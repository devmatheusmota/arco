import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (args: Record<string, unknown>) => unknown

const require = createRequire(import.meta.url)
const { buildGitCommands } = require('../../electron/commands/git.cjs') as {
  buildGitCommands: () => Record<string, Handler>
}
const { buildWorktreeCommands, provision } = require('../../electron/commands/worktrees.cjs') as {
  buildWorktreeCommands: () => Record<string, Handler>
  provision: (args: { repo: string; agentId: string }) => Promise<unknown>
}

// The renderer's wrappers reach the Electron handlers exactly as the preload
// hands them over, argument names included — a name the handler does not read
// is what left every closed front's worktree on disk.
const handlers: Record<string, Handler> = {
  ...buildGitCommands(),
  ...buildWorktreeCommands(),
  kill_pty_tree_cmd: () => [],
  list_profiles: () => ({ active_profile_id: 'default', profiles: [] }),
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) =>
    (await handlers[cmd]?.(args ?? {})) ?? null,
}))
vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

const confirm = vi.fn(() => true)
vi.stubGlobal('confirm', confirm)

let repo = ''
const worktree = () => join(repo, '.arco', 'worktrees', 'cl-1')
const gitWorktrees = () =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })

function seed() {
  const pane = (id: string, groupId: string, cwd: string) => ({
    id,
    name: id,
    cwd,
    activeTabId: `${id}-t`,
    disabled: false,
    groupId,
    tabs: [{ id: `${id}-t`, type: 'claude' as const, name: 'claude', cwd, ptyId: `pty-${id}` }],
  })
  useProjectsStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'repo',
        defaultCwd: repo,
        collapsed: false,
        createdAt: 1,
        groups: [
          {
            id: 'g-wt',
            name: 'front',
            createdAt: 1,
            worktreeAgentId: 'cl-1',
            cwd: worktree(),
          },
          { id: 'g-plain', name: 'repo', createdAt: 1 },
        ],
        terminals: [pane('a', 'g-wt', worktree()), pane('c', 'g-plain', repo)],
      },
    ],
    projectOrder: ['p1'],
    activeProjectId: 'p1',
  })
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'arco-close-front-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'], {
    cwd: repo,
  })
  await provision({ repo, agentId: 'cl-1' })
  confirm.mockClear()
  seed()
})

afterEach(() => {
  vi.useRealTimers()
  // A test leaves read-only folders behind when the code under test fails.
  execFileSync('chmod', ['-R', 'u+w', repo])
  rmSync(repo, { recursive: true, force: true })
})

/** A worktree on disk that no front or pane in the workspace holds. */
async function unheldWorktree(id: string) {
  await provision({ repo, agentId: id })
  return join(repo, '.arco', 'worktrees', id)
}

/** Publishes the repository's history, so nothing in it counts as unpushed. */
function publish() {
  const remote = mkdtempSync(join(tmpdir(), 'arco-close-front-remote-'))
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo })
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: repo })
  return remote
}

/** Two hours from now, so a worktree made during the test is old enough to sweep. */
function later() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
}

describe('closing a front on the Electron build', () => {
  it('removes its clean worktree from disk and from git worktree list', async () => {
    expect(gitWorktrees()).toContain('cl-1')

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(confirm).not.toHaveBeenCalled()
    expect(gitWorktrees()).not.toContain('cl-1')
    expect(existsSync(worktree())).toBe(false)
    const project = useProjectsStore.getState().projects[0]
    expect((project.groups ?? []).map((group) => group.id)).toEqual(['g-plain'])
  })

  it('says so when the worktree could not be removed', async () => {
    // A locked worktree survives `git worktree remove --force`.
    execFileSync('git', ['worktree', 'lock', worktree()], { cwd: repo })
    const pushToast = vi.spyOn(useUiStore.getState(), 'pushToast')

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(existsSync(worktree())).toBe(true)
    expect(pushToast).toHaveBeenCalled()
    const project = useProjectsStore.getState().projects[0]
    expect(project.orphanWorktrees?.map((orphan) => orphan.path)).toEqual([worktree()])
  })

  // `git worktree remove` drops the registration even when a read-only folder
  // keeps some files, and what stayed was refused by every later removal.
  it('finishes the removal when a folder in the tree is read-only', async () => {
    const locked = join(worktree(), 'node_modules', 'pkg')
    execFileSync('mkdir', ['-p', locked])
    writeFileSync(join(locked, 'index.js'), '')
    execFileSync('chmod', ['0555', locked])

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(existsSync(worktree())).toBe(false)
    expect(gitWorktrees()).not.toContain('cl-1')
    expect(useProjectsStore.getState().projects[0].orphanWorktrees ?? []).toEqual([])
  })
})

describe('what removing a worktree would lose', () => {
  it('counts uncommitted entries and commits no remote has', async () => {
    writeFileSync(join(worktree(), 'notes.md'), 'draft\n')

    const loss = await handlers.worktree_inspect({ repo, agentId: 'cl-1' })

    // No remote at all: the first commit is on none.
    expect(loss).toEqual({ pendingChanges: 1, unpushedCommits: 1 })
  })

  it('finds nothing to lose in a clean, published worktree', async () => {
    const remote = publish()
    try {
      expect(await handlers.worktree_inspect({ repo, agentId: 'cl-1' })).toEqual({
        pendingChanges: 0,
        unpushedCommits: 0,
      })
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })
})

describe('worktrees nothing holds', () => {
  it('are listed on their project, and the held one is left alone', async () => {
    const loose = await unheldWorktree('cl-2')
    later()

    const gained = await useProjectsStore.getState().sweepUntrackedWorktrees()

    expect(gained).toEqual([{ projectId: 'p1', count: 1 }])
    const orphans = useProjectsStore.getState().projects[0].orphanWorktrees ?? []
    expect(orphans).toEqual([
      expect.objectContaining({ path: loose, untracked: true, pendingChanges: 0 }),
    ])
  })

  it('wait an hour, since a session may still be starting in one', async () => {
    await unheldWorktree('cl-2')

    expect(await useProjectsStore.getState().sweepUntrackedWorktrees()).toEqual([])
  })

  it('are not listed twice', async () => {
    await unheldWorktree('cl-2')
    later()
    await useProjectsStore.getState().sweepUntrackedWorktrees()

    expect(await useProjectsStore.getState().sweepUntrackedWorktrees()).toEqual([])
  })

  it('are cleaned up when they hold nothing that would be lost', async () => {
    const remote = publish()
    try {
      const loose = await unheldWorktree('cl-2')
      later()
      await useProjectsStore.getState().sweepUntrackedWorktrees()

      const summary = await useProjectsStore.getState().cleanupOrphanWorktrees('p1')

      expect(summary).toMatchObject({ cleaned: 1, kept: 0, failed: 0 })
      expect(existsSync(loose)).toBe(false)
      expect(existsSync(worktree())).toBe(true)
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('stay on disk, saying why, when they hold unpushed work', async () => {
    const loose = await unheldWorktree('cl-2')
    later()
    await useProjectsStore.getState().sweepUntrackedWorktrees()

    const summary = await useProjectsStore.getState().cleanupOrphanWorktrees('p1')

    expect(summary).toMatchObject({ cleaned: 0, kept: 1 })
    expect(existsSync(loose)).toBe(true)
    expect(useProjectsStore.getState().projects[0].orphanWorktrees).toEqual([
      expect.objectContaining({ path: loose, unpushedCommits: 1 }),
    ])
  })
})
