import { beforeEach, describe, expect, it, vi } from 'vitest'

const projectsState = {
  projects: [] as Array<Record<string, unknown>>,
  workspace: { containers: [] as Array<Record<string, unknown>> },
}

const uiState = {
  activeView: 'workspace',
  focusedTerminalId: null as string | null,
  activeTerminal: null as { terminalId: string } | null,
  keptAlivePaneIds: [] as string[],
  agentCanvasSession: null as { ptyId: string } | null,
}

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: { getState: () => projectsState, subscribe: () => () => {} },
}))
vi.mock('../stores/uiStore', () => ({
  useUiStore: { getState: () => uiState, subscribe: () => () => {} },
}))

const { computeVisibleFocusedPtyIds } = await import('./ptyVisibility')

/** A pane whose tab may or may not have spawned its process yet. */
function pane(id: string, ptyId: string | null, groupId?: string) {
  return {
    id,
    activeTabId: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, ptyId }],
    ...(groupId ? { groupId } : {}),
  }
}

beforeEach(() => {
  projectsState.projects = [{ id: 'p1', terminals: [] }]
  projectsState.workspace.containers = [
    {
      projectId: 'p1',
      collapsed: false,
      activePaneId: 'pane-1',
      sidePaneId: null,
      paneIds: ['pane-1', 'pane-2', 'pane-3'],
    },
  ]
  uiState.focusedTerminalId = null
  uiState.activeTerminal = null
  uiState.keptAlivePaneIds = []
})

describe('computeVisibleFocusedPtyIds', () => {
  it('counts a pane that has not spawned yet, under the id it will spawn with', () => {
    projectsState.projects[0].terminals = [pane('pane-1', null)]
    expect(computeVisibleFocusedPtyIds().visible.has('pane-1-tab')).toBe(true)
  })

  it('counts a running pane under its pty id', () => {
    projectsState.projects[0].terminals = [pane('pane-1', 'pty-1')]
    expect(computeVisibleFocusedPtyIds().visible.has('pty-1')).toBe(true)
  })

  it('leaves a pane that is not on screen out', () => {
    projectsState.projects[0].terminals = [pane('pane-2', null)]
    expect(computeVisibleFocusedPtyIds().visible.size).toBe(0)
  })

  it('marks the focused pane before it spawns as well', () => {
    projectsState.projects[0].terminals = [pane('pane-1', null)]
    uiState.focusedTerminalId = 'pane-1'
    expect(computeVisibleFocusedPtyIds().focused.has('pane-1-tab')).toBe(true)
  })
})

describe('a front of work laid out side by side', () => {
  // The panes of the active front are all on screen, so they all have to spawn,
  // stream and take input. Deciding this by "the one active pane" is what left
  // every other pane of a split front showing "session not started".
  it('counts every pane of the active front, not only the active one', () => {
    projectsState.projects[0].terminals = [
      pane('pane-1', 'pty-1', 'g1'),
      pane('pane-2', 'pty-2', 'g1'),
    ]

    const visible = computeVisibleFocusedPtyIds().visible
    expect(visible.has('pty-1')).toBe(true)
    expect(visible.has('pty-2')).toBe(true)
  })

  it('leaves the panes of another front out', () => {
    projectsState.projects[0].terminals = [
      pane('pane-1', 'pty-1', 'g1'),
      pane('pane-2', 'pty-2', 'g2'),
    ]

    const visible = computeVisibleFocusedPtyIds().visible
    expect(visible.has('pty-1')).toBe(true)
    expect(visible.has('pty-2')).toBe(false)
  })

  // The front says which panes belong together; the container says which are
  // open. A sibling that was closed is not on screen just for being a sibling.
  it('leaves out a sibling that is not open in the container', () => {
    projectsState.workspace.containers[0].paneIds = ['pane-1']
    projectsState.projects[0].terminals = [
      pane('pane-1', 'pty-1', 'g1'),
      pane('pane-2', 'pty-2', 'g1'),
    ]

    expect(computeVisibleFocusedPtyIds().visible.has('pty-2')).toBe(false)
  })

  it('still works for a pane that belongs to no front', () => {
    projectsState.projects[0].terminals = [pane('pane-1', 'pty-1'), pane('pane-2', 'pty-2')]

    const visible = computeVisibleFocusedPtyIds().visible
    expect(visible.has('pty-1')).toBe(true)
    expect(visible.has('pty-2')).toBe(false)
  })
})
