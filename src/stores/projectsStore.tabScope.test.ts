import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/tauri', () => ({
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(async () => null),
  saveProjectsFile: vi.fn(async () => undefined),
  recordAppEvent: vi.fn(async () => undefined),
  recordFrontendError: vi.fn(async () => undefined),
  gitStatus: vi.fn(async () => ({ staged: [], changes: [], untracked: [], conflicts: [] })),
  worktreeRemove: vi.fn(async () => undefined),
  killPty: vi.fn(async () => undefined),
}))

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { useProjectsStore } from './projectsStore'

function newTerminalArgs(name: string, cwd: string) {
  return { name, cwd, firstTab: { type: 'shell' as const, cwd } }
}

describe('a workspace tab holds a single project', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [],
      groups: [],
      ungroupedOrder: [],
      activeProjectId: null,
      workspace: {
        containers: [],
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
  })

  it('creating a terminal in another project opens that project tab instead of mixing', () => {
    const store = useProjectsStore.getState()
    const projectA = store.createProject({ name: 'A', defaultCwd: '/a' })
    const projectB = store.createProject({ name: 'B', defaultCwd: '/b' })

    const terminalA = useProjectsStore
      .getState()
      .createTerminal(projectA.id, newTerminalArgs('A1', '/a'))
    const afterA = useProjectsStore.getState()
    expect(afterA.workspace.tabs).toHaveLength(1)
    expect(afterA.workspace.containers.map((c) => c.projectId)).toEqual([projectA.id])

    const terminalB = useProjectsStore
      .getState()
      .createTerminal(projectB.id, newTerminalArgs('B1', '/b'))
    const afterB = useProjectsStore.getState()

    // Two tabs, one per project — never one tab holding both.
    expect(afterB.workspace.tabs.map((tab) => tab.projectId)).toEqual([projectA.id, projectB.id])
    expect(afterB.workspace.activeTabId).toBe(
      afterB.workspace.tabs.find((tab) => tab.projectId === projectB.id)?.id,
    )
    expect(afterB.workspace.containers.map((c) => c.projectId)).toEqual([projectB.id])
    for (const tab of afterB.workspace.tabs) {
      expect(tab.snapshot.containers).toHaveLength(1)
      expect(tab.snapshot.containers[0].projectId).toBe(tab.projectId)
    }
    // The pane of A stays in A's tab, not on B's screen.
    expect(
      afterB.workspace.tabs.find((tab) => tab.projectId === projectA.id)?.snapshot.containers[0]
        .paneIds,
    ).toEqual([terminalA.id])
    expect(afterB.workspace.containers[0].paneIds).toEqual([terminalB.id])
  })

  it('opening a pane of another project switches tabs rather than adding a container', () => {
    const store = useProjectsStore.getState()
    const projectA = store.createProject({ name: 'A', defaultCwd: '/a' })
    const projectB = store.createProject({ name: 'B', defaultCwd: '/b' })
    const terminalA = useProjectsStore
      .getState()
      .createTerminal(projectA.id, newTerminalArgs('A1', '/a'))
    useProjectsStore.getState().createTerminal(projectB.id, newTerminalArgs('B1', '/b'))

    // Active tab is B's; opening a pane of A must not append A to it.
    useProjectsStore.getState().openPane(projectA.id, terminalA.id)
    const state = useProjectsStore.getState()

    expect(state.workspace.containers.map((c) => c.projectId)).toEqual([projectA.id])
    expect(
      state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)?.projectId,
    ).toBe(projectA.id)
  })

  it('opening a second project gives it its own tab', () => {
    const projectA = useProjectsStore.getState().createProject({ name: 'A' })
    const projectB = useProjectsStore.getState().createProject({ name: 'B' })
    useProjectsStore.getState().createTerminal(projectA.id, newTerminalArgs('A1', '/a'))
    useProjectsStore.getState().createTerminal(projectB.id, newTerminalArgs('B1', '/b'))

    useProjectsStore.getState().openProjectWorkspace(projectA.id)
    useProjectsStore.getState().openProjectWorkspace(projectB.id)
    const state = useProjectsStore.getState()

    expect(state.workspace.tabs.map((tab) => tab.projectId)).toEqual([projectA.id, projectB.id])
    expect(state.workspace.containers.map((c) => c.projectId)).toEqual([projectB.id])
  })
})
