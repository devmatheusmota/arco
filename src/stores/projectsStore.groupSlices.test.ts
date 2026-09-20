import { beforeEach, describe, expect, it, vi } from 'vitest'

const gitStatus = vi.fn()
const worktreeRemove = vi.fn()
const worktreeList = vi.fn()
const killPtyTree = vi.fn(async () => [])

vi.mock('../lib/tauri', () => ({
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(async () => null),
  saveProjectsFile: vi.fn(async () => undefined),
  recordAppEvent: vi.fn(async () => undefined),
  recordFrontendError: vi.fn(async () => undefined),
  killPty: vi.fn(async () => undefined),
  gitStatus: (path: string) => gitStatus(path),
  worktreeRemove: (repo: string, agent: string, force: boolean) =>
    worktreeRemove(repo, agent, force),
  worktreeList: (repo: string) => worktreeList(repo),
  killPtyTree: (id: string) => killPtyTree(id),
}))

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { useProjectsStore } from './projectsStore'

const confirm = vi.fn(() => true)
vi.stubGlobal('confirm', confirm)

const clean = { staged: [], changes: [], untracked: [], conflicts: [] }
const dirty = { staged: ['a'], changes: ['b'], untracked: [], conflicts: [] }

const project = () => useProjectsStore.getState().projects[0]
const groupIds = () => (project().groups ?? []).map((g) => g.id)

/** A project holding one isolated front and one on the project tree. */
function seed(worktree: { worktreeAgentId?: string; cwd?: string } = {}) {
  const pane = (id: string, groupId: string, ptyId: string | null) => ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    groupId,
    tabs: [{ id: `${id}-t`, type: 'claude' as const, name: 'claude', cwd: '/repo', ptyId }],
  })
  useProjectsStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'SOA',
        defaultCwd: '/repo',
        collapsed: false,
        createdAt: 1,
        groups: [
          {
            id: 'g-wt',
            name: 'cpf opcional',
            createdAt: 1,
            worktreeAgentId: 'cl-1',
            cwd: '/repo/.arco/worktrees/cl-1',
            ...worktree,
          },
          { id: 'g-plain', name: 'SOA', createdAt: 1 },
        ],
        terminals: [
          pane('a', 'g-wt', 'pty-a'),
          pane('b', 'g-wt', 'pty-b'),
          pane('c', 'g-plain', 'pty-c'),
        ],
      },
    ],
    projectOrder: ['p1'],
    todos: [],
    activeProjectId: 'p1',
    workspace: {
      containers: [
        {
          projectId: 'p1',
          paneIds: ['a', 'b', 'c'],
          activePaneId: 'a',
          sidePaneId: null,
          size: 0,
          collapsed: false,
        },
      ],
      recentProjectIds: [],
      recentTabs: [],
      tabs: [],
      closedTabs: [],
      activeTabId: null,
      focusedTerminalId: null,
      history: [],
      historyIndex: -1,
    },
  })
}

beforeEach(() => {
  confirm.mockClear().mockReturnValue(true)
  gitStatus.mockReset().mockResolvedValue(clean)
  // The repository still lists the worktree unless a test says otherwise.
  worktreeList
    .mockReset()
    .mockResolvedValue([{ agentId: 'cl-1', path: '/repo/.arco/worktrees/cl-1' }])
  worktreeRemove.mockReset().mockResolvedValue(undefined)
  killPtyTree.mockClear()
  seed()
})

describe('closing a front that works on the project tree', () => {
  // Removing anything there would take the checkout everything else shares.
  it('never touches disk', async () => {
    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-plain')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(gitStatus).not.toHaveBeenCalled()
    expect(groupIds()).toEqual(['g-wt'])
    expect(project().terminals.map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('closing a front that owns a worktree', () => {
  it('removes it, with its panes, when the tree is clean', async () => {
    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(confirm).not.toHaveBeenCalled()
    expect(worktreeRemove).toHaveBeenCalledWith('/repo', 'cl-1', true)
    expect(killPtyTree.mock.calls.map(([id]) => id).sort()).toEqual(['pty-a', 'pty-b'])
    expect(groupIds()).toEqual(['g-plain'])
    expect(project().terminals.map((t) => t.id)).toEqual(['c'])
  })

  it('asks before deleting work that was never committed', async () => {
    gitStatus.mockResolvedValue(dirty)

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String(confirm.mock.calls[0][0])).toMatch(/2/)
    expect(worktreeRemove).toHaveBeenCalled()
  })

  // Cancel means cancel: the sessions the user just chose to keep stay open.
  it('changes nothing at all when the question is declined', async () => {
    gitStatus.mockResolvedValue(dirty)
    confirm.mockReturnValue(false)

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(killPtyTree).not.toHaveBeenCalled()
    expect(groupIds()).toEqual(['g-wt', 'g-plain'])
    expect(project().terminals).toHaveLength(3)
  })

  // Removal runs with `--force`, so "I could not read the tree" must not take
  // the same path as "the tree is clean" — that is how a day's work vanishes.
  it('asks when git could not say what is in there', async () => {
    gitStatus.mockRejectedValue(new Error('not a git repository'))

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String(confirm.mock.calls[0][0])).toMatch(/--force/)
  })

  it('keeps the front when an unreadable tree is declined', async () => {
    gitStatus.mockRejectedValue(new Error('not a git repository'))
    confirm.mockReturnValue(false)

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(groupIds()).toEqual(['g-wt', 'g-plain'])
  })
})

describe('when git will not give the worktree up', () => {
  it('treats a worktree that is already gone as removed', async () => {
    worktreeRemove.mockRejectedValue(new Error('worktree_not_found'))

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(worktreeRemove).toHaveBeenCalledTimes(1)
    expect(project().orphanWorktrees ?? []).toEqual([])
    expect(groupIds()).toEqual(['g-plain'])
  })

  it('tries a second time, because the killed processes hold locks for a moment', async () => {
    worktreeRemove.mockRejectedValueOnce(new Error('is locked')).mockResolvedValueOnce(undefined)

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(worktreeRemove).toHaveBeenCalledTimes(2)
    expect(project().orphanWorktrees ?? []).toEqual([])
  })

  // A worktree stuck on disk is not a reason to keep the front open: it goes to
  // the list the app already sweeps, so no pane stands in for it.
  it('records the leftover and closes the front anyway', async () => {
    worktreeRemove.mockRejectedValue(new Error('is locked'))

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(worktreeRemove).toHaveBeenCalledTimes(2)
    expect(project().orphanWorktrees).toEqual([
      { path: '/repo/.arco/worktrees/cl-1', mode: 'gitWorktree' },
    ])
    expect(groupIds()).toEqual(['g-plain'])
    expect(project().terminals.map((t) => t.id)).toEqual(['c'])
  })
})

describe('the rest of the group actions', () => {
  it('renames, and refuses a name that is only spaces', () => {
    useProjectsStore.getState().renameGroup('p1', 'g-wt', '  cpf no cadastro  ')
    expect((project().groups ?? [])[0].name).toBe('cpf no cadastro')

    useProjectsStore.getState().renameGroup('p1', 'g-wt', '   ')
    expect((project().groups ?? [])[0].name).toBe('cpf no cadastro')
  })

  it('takes ownership of the worktree its first session provisioned', () => {
    useProjectsStore.getState().createGroup('p1', { name: 'nova' })
    const created = (project().groups ?? []).at(-1)!

    useProjectsStore
      .getState()
      .adoptGroupWorktree('p1', created.id, { worktreeAgentId: 'cl-9', cwd: '/wt/9' })

    expect((project().groups ?? []).at(-1)).toMatchObject({
      worktreeAgentId: 'cl-9',
      cwd: '/wt/9',
    })
  })

  it('closes without touching disk when asked not to', () => {
    useProjectsStore.getState().closeGroup('p1', 'g-wt')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(groupIds()).toEqual(['g-plain'])
  })
})

describe('a worktree the repository no longer lists', () => {
  // Most fronts in a migrated workspace are this: the pane outlived the tree it
  // was opened in. Asking about work that cannot exist blocks the window on a
  // question nobody can answer.
  beforeEach(() => {
    worktreeList.mockResolvedValue([])
  })

  it('closes without reading the tree or asking anything', async () => {
    gitStatus.mockRejectedValue(new Error('not a git repository'))

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(confirm).not.toHaveBeenCalled()
    expect(gitStatus).not.toHaveBeenCalled()
    expect(groupIds()).toEqual(['g-plain'])
  })

  it('does not try to remove it, and records no leftover', async () => {
    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(project().orphanWorktrees ?? []).toEqual([])
  })

  // A listing that fails says nothing about the tree, so the careful path stays.
  it('still asks when the listing itself could not be read', async () => {
    worktreeList.mockRejectedValue(new Error('git exploded'))
    gitStatus.mockRejectedValue(new Error('not a git repository'))

    await useProjectsStore.getState().closeGroupWithWorktree('p1', 'g-wt')

    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('when the caller already asked', () => {
  // `window.confirm` blocks the whole renderer while it is up. A question the
  // terminal already answered would stop the window serving anything at all —
  // which is how closing nine fronts in a row hung the app on the second.
  it('never raises a dialog of its own', async () => {
    gitStatus.mockResolvedValue(dirty)

    await useProjectsStore
      .getState()
      .closeGroupWithWorktree('p1', 'g-wt', { assumeConfirmed: true })

    expect(confirm).not.toHaveBeenCalled()
    expect(worktreeRemove).toHaveBeenCalledWith('/repo', 'cl-1', true)
    expect(groupIds()).toEqual(['g-plain'])
  })
})
