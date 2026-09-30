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
  rmSync(repo, { recursive: true, force: true })
})

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
})
