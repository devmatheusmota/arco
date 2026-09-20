import { beforeEach, describe, expect, it, vi } from 'vitest'

const gitStatus = vi.fn()
const worktreeRemove = vi.fn()
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
  worktreeList: vi.fn(async () => []),
  killPtyTree: (id: string) => killPtyTree(id),
}))

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { useProjectsStore } from './projectsStore'

const confirm = vi.fn(() => true)
vi.stubGlobal('confirm', confirm)

const clean = { staged: [], changes: [], untracked: [], conflicts: [] }
const dirty = { staged: ['a'], changes: [], untracked: [], conflicts: [] }

const project = () => useProjectsStore.getState().projects[0]
const paneIds = () => project().terminals.map((t) => t.id)

/** One pane with a worktree of its own, next to one that shares the project tree. */
function seed() {
  const pane = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [{ id: `${id}-t`, type: 'claude' as const, name: 'claude', cwd: '/repo', ptyId: id }],
    ...extra,
  })
  useProjectsStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'SOA',
        defaultCwd: '/repo',
        collapsed: false,
        createdAt: 1,
        groups: [],
        terminals: [
          pane('isolado', { worktreeAgentId: 'cl-1', cwd: '/repo/.arco/worktrees/cl-1' }),
          pane('comum'),
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
          paneIds: ['isolado', 'comum'],
          activePaneId: 'isolado',
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
  worktreeRemove.mockReset().mockResolvedValue(undefined)
  killPtyTree.mockClear()
  seed()
})

describe('closing a pane that owns a worktree', () => {
  it('removes the worktree with it, silently, when the tree is clean', async () => {
    await useProjectsStore.getState().deleteTerminalWithWorktreeCleanup('p1', 'isolado')

    expect(confirm).not.toHaveBeenCalled()
    expect(worktreeRemove).toHaveBeenCalledWith('/repo', 'cl-1', true)
    expect(paneIds()).toEqual(['comum'])
  })

  it('asks before deleting work that was never committed', async () => {
    gitStatus.mockResolvedValue(dirty)

    await useProjectsStore.getState().deleteTerminalWithWorktreeCleanup('p1', 'isolado')

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(paneIds()).toEqual(['comum'])
  })

  // Removal runs with `--force`, so "I could not read the tree" must not take the
  // same path as "the tree is clean" — that is how a day's work vanishes.
  it('asks when git could not say what is in there', async () => {
    gitStatus.mockRejectedValue(new Error('not a git repository'))

    await useProjectsStore.getState().deleteTerminalWithWorktreeCleanup('p1', 'isolado')

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String(confirm.mock.calls[0][0])).toMatch(/--force/)
  })

  it('keeps the pane and the worktree when the question is declined', async () => {
    gitStatus.mockRejectedValue(new Error('not a git repository'))
    confirm.mockReturnValue(false)

    await useProjectsStore.getState().deleteTerminalWithWorktreeCleanup('p1', 'isolado')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(paneIds()).toEqual(['isolado', 'comum'])
  })

  // `window.confirm` blocks the whole renderer while it is up. `arco session
  // close --yes` already asked in the terminal, where somebody can answer.
  it('raises no dialog of its own when the caller already asked', async () => {
    gitStatus.mockResolvedValue(dirty)

    await useProjectsStore
      .getState()
      .deleteTerminalWithWorktreeCleanup('p1', 'isolado', { assumeConfirmed: true })

    expect(confirm).not.toHaveBeenCalled()
    expect(worktreeRemove).toHaveBeenCalledWith('/repo', 'cl-1', true)
    expect(paneIds()).toEqual(['comum'])
  })
})

describe('closing a pane that works on the project tree', () => {
  it('takes nothing off disk', async () => {
    await useProjectsStore.getState().deleteTerminalWithWorktreeCleanup('p1', 'comum')

    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(gitStatus).not.toHaveBeenCalled()
    expect(paneIds()).toEqual(['isolado'])
  })
})

// What the play button on a task does, step by step: the front is created, the
// pane is its orchestrator, and the worktree the pane provisioned becomes the
// front's — so closing the front is what removes it.
describe('starting a task', () => {
  it('opens a front of its own instead of dropping a pane into the one on screen', async () => {
    const store = useProjectsStore.getState()
    const group = store.createGroup('p1', { name: 'cpf opcional no cadastro' })

    const pane = await store.createAgentTerminal('p1', {
      name: 'Claude Code',
      nameSource: 'task',
      cwd: '/repo',
      worktree: 'none',
      firstTab: { type: 'claude', cwd: '/repo' },
      groupId: group.id,
      pinned: true,
    })

    expect(pane.groupId).toBe(group.id)
    expect(pane.pinned).toBe(true)
    expect((project().groups ?? []).map((g) => g.name)).toContain('cpf opcional no cadastro')
    // The front on screen keeps its own panes.
    expect(
      project()
        .terminals.filter((t) => t.groupId === group.id)
        .map((t) => t.id),
    ).toEqual([pane.id])
  })

  it('hands the front the worktree the pane provisioned', () => {
    const store = useProjectsStore.getState()
    const group = store.createGroup('p1', { name: 'tarefa isolada' })

    store.adoptGroupWorktree('p1', group.id, { worktreeAgentId: 'cl-7', cwd: '/repo/.arco/wt/7' })

    expect((project().groups ?? []).at(-1)).toMatchObject({
      worktreeAgentId: 'cl-7',
      cwd: '/repo/.arco/wt/7',
    })
  })
})

describe('a pane created with no front named', () => {
  // Most routes in — a keybinding, the home screen, a handoff, the scheduler —
  // never had a front to pass. A pane without one is invisible in the sidebar.
  it('joins the front that is on screen', () => {
    const pane = useProjectsStore.getState().createTerminal('p1', {
      name: 'solto',
      cwd: '/repo',
      firstTab: { type: 'claude', cwd: '/repo' },
    })

    // `isolado` is the active pane of the container, and it has no front here,
    // so the pane opens one — the point is that it is never left without any.
    expect(pane.groupId).toBeTruthy()
    expect((project().groups ?? []).some((g) => g.id === pane.groupId)).toBe(true)
  })

  it('takes the front of the active pane when there is one', () => {
    const store = useProjectsStore.getState()
    const group = store.createGroup('p1', { name: 'na tela' })
    useProjectsStore.setState({
      projects: [
        {
          ...project(),
          terminals: project().terminals.map((t) =>
            t.id === 'isolado' ? { ...t, groupId: group.id } : t,
          ),
        },
      ],
    })

    const pane = store.createTerminal('p1', {
      name: 'vizinho',
      cwd: '/repo',
      firstTab: { type: 'claude', cwd: '/repo' },
    })

    expect(pane.groupId).toBe(group.id)
  })
})

describe('the orchestrator of a front', () => {
  // It goes when its front goes. Every other route in has to refuse it.
  it('is refused by both close paths', async () => {
    useProjectsStore.setState({
      projects: [
        {
          ...project(),
          terminals: project().terminals.map((t) =>
            t.id === 'comum' ? { ...t, pinned: true } : t,
          ),
        },
      ],
    })

    await useProjectsStore.getState().deleteTerminalWithWorktreeCleanup('p1', 'comum')
    useProjectsStore.getState().deleteTerminal('p1', 'comum')

    expect(paneIds()).toEqual(['isolado', 'comum'])
  })
})
