/** Workspace and navigation actions extracted from the main store. */

import { nanoid } from 'nanoid'

import {
  newContainer,
  rememberProjectTab,
  rememberWorkspaceTab,
  touchTerminalUsage,
} from '../lib/terminalFactory'
import type {
  Preferences,
  Project,
  WorkspaceContainer,
  WorkspaceTab,
  WorkspaceViewSnapshot,
} from '../lib/types'
import {
  cloneWorkspaceSnapshot,
  MAX_WORKSPACE_TABS,
  replaceCurrentHistorySnapshot,
  scopedTabSnapshot,
} from '../lib/workspaceNavigation'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'

type WorkspaceSliceCtx = SliceCtx & {
  navigationUpdate: (mutator: (state: ProjectsState) => Partial<ProjectsState> | void) => void
  makeSnapshot: (
    state: ProjectsState,
    containers: WorkspaceContainer[],
    activeProjectId: string | null,
    focusedTerminalId?: string | null,
    visual?: Partial<Pick<Preferences, 'fullscreenContainerId'>>,
  ) => WorkspaceViewSnapshot
  applyTabNavigation: (
    state: ProjectsState,
    tab: WorkspaceTab,
    options?: { addTab?: boolean; pushHistory?: boolean },
  ) => Partial<ProjectsState>
  tabForProject: (state: ProjectsState, projectId: string) => WorkspaceTab | null
  openPanesInProjectTab: (
    state: ProjectsState,
    projectId: string,
    paneIds: string[],
    options?: { focusPaneId?: string | null },
  ) => Partial<ProjectsState> | undefined
}

type WorkspaceSlice = Pick<
  ProjectsState,
  | 'setActiveProject'
  | 'setActiveProjectOnly'
  | 'closeWorkspaceTab'
  | 'openProjectWorkspace'
  | 'openTerminalWorkspace'
  | 'focusWorkspaceTerminal'
  | 'activateWorkspaceTab'
  | 'toggleWorkspaceTabPinned'
  | 'closeSavedWorkspaceTab'
  | 'reopenClosedWorkspaceTab'
  | 'navigateWorkspaceHistory'
  | 'toggleProjectCollapsed'
>

export function createWorkspaceSlice({
  get,
  update,
  updateProject,
  navigationUpdate,
  makeSnapshot,
  applyTabNavigation,
  openPanesInProjectTab,
}: WorkspaceSliceCtx): WorkspaceSlice {
  /** A tab holding every open pane of `project`, reusing the existing tab of that project. */
  const projectTab = (
    state: ProjectsState,
    project: Project,
    tabs: WorkspaceTab[],
    stamp: number,
  ): WorkspaceTab => {
    const snapshot = makeSnapshot(
      state,
      project.terminals.length > 0
        ? [
            newContainer(
              project.id,
              project.terminals.map((terminal) => terminal.id),
            ),
          ]
        : [],
      project.id,
      null,
      { fullscreenContainerId: null },
    )
    const existing = tabs.find((tab) => tab.kind === 'project' && tab.projectId === project.id)
    if (existing) {
      return {
        ...existing,
        label: project.name,
        color: project.color,
        iconUrl: project.iconUrl,
        snapshot,
        updatedAt: stamp,
      }
    }
    return {
      id: nanoid(),
      kind: 'project',
      projectId: project.id,
      label: project.name,
      color: project.color,
      iconUrl: project.iconUrl,
      snapshot,
      createdAt: stamp,
      updatedAt: stamp,
    }
  }

  return {
    setActiveProject: (id) => {
      if (!id) {
        update(() => ({ activeProjectId: null }))
        return
      }
      const state = get()
      const target = state.projects.find((project) => project.id === id)
      if (!target) {
        update(() => ({ activeProjectId: id }))
        return
      }
      if (target.terminals.length === 0) {
        update((current) => ({
          activeProjectId: id,
          workspace: {
            ...current.workspace,
            recentProjectIds: rememberProjectTab(current.workspace.recentProjectIds, id),
            recentTabs: rememberWorkspaceTab(current.workspace.recentTabs, {
              kind: 'project',
              id,
            }),
          },
        }))
        return
      }
      get().openProjectWorkspace(id)
    },

    setActiveProjectOnly: (id) =>
      update((state) => {
        if (state.activeProjectId === id) return
        return {
          activeProjectId: id,
          workspace: id
            ? {
                ...state.workspace,
                recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
                recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                  kind: 'project',
                  id,
                }),
              }
            : state.workspace,
        }
      }),

    closeWorkspaceTab: (tab) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          recentProjectIds:
            tab.kind === 'project'
              ? (state.workspace.recentProjectIds ?? []).filter((id) => id !== tab.id)
              : state.workspace.recentProjectIds,
          recentTabs: (state.workspace.recentTabs ?? []).filter(
            (item) => !(item.kind === tab.kind && item.id === tab.id),
          ),
        },
      })),

    openProjectWorkspace: (projectId) =>
      navigationUpdate((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        if (!project) return
        const existing = state.workspace.tabs.find(
          (tab) => tab.kind === 'project' && tab.projectId === projectId,
        )
        const tab = existing ?? projectTab(state, project, state.workspace.tabs, Date.now())
        const navigation = applyTabNavigation(state, tab, { addTab: !existing })
        return {
          ...navigation,
          workspace: {
            ...(navigation.workspace ?? state.workspace),
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    openTerminalWorkspace: (projectId, terminalId) =>
      navigationUpdate((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        const terminal = project?.terminals.find((item) => item.id === terminalId)
        if (!project || !terminal) return
        const projects = state.projects.map((item) =>
          item.id !== projectId
            ? item
            : {
                ...item,
                terminals: item.terminals.map((tab) =>
                  tab.id === terminalId ? touchTerminalUsage(tab) : tab,
                ),
              },
        )
        const nextState = { ...state, projects } as ProjectsState
        const existing = nextState.workspace.tabs.find(
          (tab) =>
            tab.kind === 'terminal' && tab.terminalId === terminalId && tab.projectId === projectId,
        )
        if (existing) {
          return { projects, ...applyTabNavigation(nextState, existing) }
        }
        const now = Date.now()
        const tab: WorkspaceTab = {
          id: nanoid(),
          kind: 'terminal',
          projectId: project.id,
          terminalId: terminal.id,
          label: terminal.name,
          color: project.color,
          iconUrl: project.iconUrl,
          snapshot: makeSnapshot(
            nextState,
            [newContainer(project.id, [terminal.id])],
            project.id,
            terminal.id,
            { fullscreenContainerId: null },
          ),
          createdAt: now,
          updatedAt: now,
        }
        return { projects, ...applyTabNavigation(nextState, tab, { addTab: true }) }
      }),

    focusWorkspaceTerminal: (projectId, terminalId) =>
      navigationUpdate((state) => {
        const projects = state.projects.map((project) =>
          project.id !== projectId
            ? project
            : {
                ...project,
                terminals: project.terminals.map((terminal) =>
                  terminal.id === terminalId ? touchTerminalUsage(terminal) : terminal,
                ),
              },
        )
        const nextState = { ...state, projects } as ProjectsState
        const inScope = nextState.workspace.containers.some(
          (container) =>
            container.projectId === projectId && container.paneIds.includes(terminalId),
        )
        // Focusing a session is asking to read it, so it takes the screen —
        // unless it is already the terminal sitting beside the active one.
        if (inScope) {
          nextState.workspace = {
            ...nextState.workspace,
            containers: nextState.workspace.containers.map((container) =>
              container.projectId === projectId && container.sidePaneId !== terminalId
                ? { ...container, activePaneId: terminalId }
                : container,
            ),
          }
        }
        // A pane of another project cannot be focused in this tab; it opens in its own tab.
        if (!inScope) {
          const navigation = openPanesInProjectTab(nextState, projectId, [terminalId], {
            focusPaneId: terminalId,
          })
          return navigation ? { projects, ...navigation } : { projects }
        }
        const activeTab = nextState.workspace.tabs.find(
          (tab) => tab.id === nextState.workspace.activeTabId,
        )
        if (!activeTab) return { projects, activeProjectId: projectId }
        const snapshot = makeSnapshot(
          nextState,
          nextState.workspace.containers,
          projectId,
          terminalId,
        )
        const updatedTab = { ...activeTab, snapshot, updatedAt: Date.now() }
        return {
          activeProjectId: projectId,
          projects,
          workspace: {
            ...nextState.workspace,
            focusedTerminalId: terminalId,
            tabs: nextState.workspace.tabs.map((tab) =>
              tab.id === updatedTab.id ? updatedTab : tab,
            ),
            history: replaceCurrentHistorySnapshot(
              nextState.workspace.history,
              nextState.workspace.historyIndex,
              updatedTab,
            ),
          },
        }
      }),

    activateWorkspaceTab: (tabId) =>
      navigationUpdate((state) => {
        const tab = state.workspace.tabs.find((item) => item.id === tabId)
        return tab ? applyTabNavigation(state, tab) : undefined
      }),

    toggleWorkspaceTabPinned: (tabId) =>
      navigationUpdate((state) => {
        if (!state.workspace.tabs.some((tab) => tab.id === tabId)) return
        const tabs = state.workspace.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, pinned: !tab.pinned, updatedAt: Date.now() } : tab,
        )
        const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)]
        return { workspace: { ...state.workspace, tabs: ordered } }
      }),

    closeSavedWorkspaceTab: (tabId) =>
      navigationUpdate((state) => {
        const index = state.workspace.tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) return
        const closedTabs = [
          state.workspace.tabs[index],
          ...(state.workspace.closedTabs ?? []).filter((tab) => tab.id !== tabId),
        ].slice(0, MAX_WORKSPACE_TABS)
        const tabs = state.workspace.tabs.filter((tab) => tab.id !== tabId)
        const history = state.workspace.history.filter((entry) => entry.tabId !== tabId)
        if (state.workspace.activeTabId !== tabId) {
          return {
            workspace: {
              ...state.workspace,
              tabs,
              closedTabs,
              history,
              historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
            },
          }
        }
        const nextTab = tabs[Math.min(index, tabs.length - 1)]
        if (!nextTab) {
          return {
            activeProjectId: null,
            workspace: {
              ...state.workspace,
              containers: [],
              tabs: [],
              closedTabs,
              activeTabId: null,
              focusedTerminalId: null,
              history: [],
              historyIndex: -1,
            },
          }
        }
        const base = {
          ...state,
          workspace: {
            ...state.workspace,
            tabs,
            closedTabs,
            history,
            historyIndex: history.length - 1,
          },
        }
        return applyTabNavigation(base, nextTab)
      }),

    reopenClosedWorkspaceTab: () =>
      navigationUpdate((state) => {
        const closedTabs = state.workspace.closedTabs ?? []
        const tab = closedTabs[0]
        if (!tab) return
        const nextTab = {
          ...tab,
          snapshot: scopedTabSnapshot(tab, state.projects),
          updatedAt: Date.now(),
        }
        const base = {
          ...state,
          workspace: {
            ...state.workspace,
            closedTabs: closedTabs.slice(1),
          },
        }
        return applyTabNavigation(base, nextTab, { addTab: true })
      }),

    navigateWorkspaceHistory: (direction) =>
      navigationUpdate((state) => {
        const targetIndex = state.workspace.historyIndex + direction
        if (targetIndex < 0 || targetIndex >= state.workspace.history.length) return
        const target = state.workspace.history[targetIndex]
        const tab = state.workspace.tabs.find((item) => item.id === target.tabId)
        if (!tab) return
        const snapshot = scopedTabSnapshot({ ...tab, snapshot: target.snapshot }, state.projects)
        return {
          activeProjectId: snapshot.activeProjectId ?? tab.projectId,
          preferences: {
            ...state.preferences,
            fullscreenContainerId: snapshot.fullscreenContainerId,
          },
          workspace: {
            ...state.workspace,
            containers: cloneWorkspaceSnapshot(snapshot).containers,
            activeTabId: tab.id,
            focusedTerminalId: snapshot.focusedTerminalId,
            historyIndex: targetIndex,
          },
        }
      }),

    toggleProjectCollapsed: (id) => updateProject(id, (p) => ({ ...p, collapsed: !p.collapsed })),
  }
}
