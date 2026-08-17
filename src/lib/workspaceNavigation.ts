import type {
  Preferences,
  Project,
  WorkspaceContainer,
  WorkspaceHistoryEntry,
  WorkspaceTab,
  WorkspaceViewSnapshot,
} from './types'

export const MAX_WORKSPACE_TABS = 20
export const MAX_WORKSPACE_HISTORY = 50

export function cloneContainers(containers: WorkspaceContainer[]): WorkspaceContainer[] {
  return containers.map((container) => ({
    ...container,
    paneIds: [...container.paneIds],
  }))
}

export function cloneWorkspaceSnapshot(snapshot: WorkspaceViewSnapshot): WorkspaceViewSnapshot {
  return {
    ...snapshot,
    containers: cloneContainers(snapshot.containers),
  }
}

export function captureWorkspaceSnapshot(args: {
  containers: WorkspaceContainer[]
  activeProjectId: string | null
  focusedTerminalId: string | null
  preferences: Preferences
}): WorkspaceViewSnapshot {
  return {
    containers: cloneContainers(args.containers),
    activeProjectId: args.activeProjectId,
    focusedTerminalId: args.focusedTerminalId,
    fullscreenContainerId: args.preferences.fullscreenContainerId,
  }
}

export function sanitizeWorkspaceSnapshot(
  snapshot: WorkspaceViewSnapshot,
  projects: Project[],
): WorkspaceViewSnapshot {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const containers = snapshot.containers.flatMap((container) => {
    const project = projectsById.get(container.projectId)
    if (!project) return []
    const terminalIds = new Set(project.terminals.map((terminal) => terminal.id))
    const paneIds = container.paneIds.filter((id) => terminalIds.has(id))
    return paneIds.length > 0 ? [{ ...container, paneIds }] : []
  })
  const visibleTerminalIds = new Set(containers.flatMap((container) => container.paneIds))
  const visibleProjectIds = new Set(containers.map((container) => container.projectId))
  return {
    ...cloneWorkspaceSnapshot(snapshot),
    containers,
    activeProjectId:
      snapshot.activeProjectId && visibleProjectIds.has(snapshot.activeProjectId)
        ? snapshot.activeProjectId
        : (containers[0]?.projectId ?? null),
    focusedTerminalId:
      snapshot.focusedTerminalId && visibleTerminalIds.has(snapshot.focusedTerminalId)
        ? snapshot.focusedTerminalId
        : null,
    fullscreenContainerId:
      snapshot.fullscreenContainerId && visibleProjectIds.has(snapshot.fullscreenContainerId)
        ? snapshot.fullscreenContainerId
        : null,
  }
}

/**
 * A tab shows one project and nothing else. Panes of any other project are dropped here, so a
 * snapshot coming from disk, from history, or from a store update can never mix two projects.
 */
export function enforceTabScope(
  snapshot: WorkspaceViewSnapshot,
  projectId: string,
): WorkspaceViewSnapshot {
  const containers = snapshot.containers.filter((container) => container.projectId === projectId)
  const merged = containers.slice(0, 1).map((container) => ({
    ...container,
    paneIds: [...new Set(containers.flatMap((item) => item.paneIds))],
  }))
  const paneIds = new Set(merged.flatMap((container) => container.paneIds))
  return {
    ...cloneWorkspaceSnapshot(snapshot),
    containers: merged,
    activeProjectId: merged.length > 0 ? projectId : null,
    focusedTerminalId:
      snapshot.focusedTerminalId && paneIds.has(snapshot.focusedTerminalId)
        ? snapshot.focusedTerminalId
        : null,
    fullscreenContainerId: snapshot.fullscreenContainerId === projectId ? projectId : null,
  }
}

/** Sanitizes against the live projects and then clamps the snapshot to the tab's own project. */
export function scopedTabSnapshot(tab: WorkspaceTab, projects: Project[]): WorkspaceViewSnapshot {
  return enforceTabScope(sanitizeWorkspaceSnapshot(tab.snapshot, projects), tab.projectId)
}

export function pushWorkspaceHistory(
  history: WorkspaceHistoryEntry[],
  historyIndex: number,
  entry: WorkspaceHistoryEntry,
): { history: WorkspaceHistoryEntry[]; historyIndex: number } {
  const branch = history.slice(0, historyIndex + 1)
  const next = [...branch, { ...entry, snapshot: cloneWorkspaceSnapshot(entry.snapshot) }].slice(
    -MAX_WORKSPACE_HISTORY,
  )
  return { history: next, historyIndex: next.length - 1 }
}

export function replaceCurrentHistorySnapshot(
  history: WorkspaceHistoryEntry[],
  historyIndex: number,
  tab: WorkspaceTab,
): WorkspaceHistoryEntry[] {
  if (historyIndex < 0 || historyIndex >= history.length) return history
  return history.map((entry, index) =>
    index === historyIndex
      ? {
          ...entry,
          tabId: tab.id,
          label: tab.label,
          snapshot: cloneWorkspaceSnapshot(tab.snapshot),
        }
      : entry,
  )
}
