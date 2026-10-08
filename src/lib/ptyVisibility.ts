import { useSyncExternalStore } from 'react'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { rendersWorkspace } from './activeView'

export type PtyVisibilitySets = {
  visible: Set<string>
  focused: Set<string>
}

export function computeVisibleFocusedPtyIds(): PtyVisibilitySets {
  const projectsState = useProjectsStore.getState()
  const ui = useUiStore.getState()
  const visible = new Set<string>()
  const focused = new Set<string>()
  const workspaceVisible = rendersWorkspace(ui.activeView)
  const focusedTerminalIds = new Set(
    [ui.focusedTerminalId, ui.activeTerminal?.terminalId].filter(
      (id): id is string => typeof id === 'string',
    ),
  )

  // Panes of hidden-but-mounted workspace tabs count as visible: they keep streaming so
  // switching back to their tab costs nothing.
  const keptAlivePaneIds = new Set(ui.keptAlivePaneIds)

  for (const project of projectsState.projects) {
    const container = projectsState.workspace.containers.find(
      (entry) => entry.projectId === project.id,
    )
    // The whole front of work is on screen, not just one session of it. This
    // decides which panes spawn, stream and take input, so leaving it on the
    // old "one active pane" rule leaves every other pane of a split front
    // showing "session not started" and refusing the keyboard.
    const activePane = container
      ? project.terminals.find((item) => item.id === container.activePaneId)
      : undefined
    const activeGroupId = activePane?.groupId ?? null

    for (const terminal of project.terminals) {
      const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId)
      // A tab has no pty id until it spawns, and the pane it mounts is keyed by
      // the tab's own id until then — which is the id the process is spawned
      // with. Keying on the pty id alone left a brand-new session invisible to
      // itself: it sat on screen waiting to be opened, and only the button
      // started it.
      const paneId = activeTab ? (activeTab.ptyId ?? activeTab.id) : null
      // Only what is on screen streams: the session in front and the terminal
      // beside it. Every other session of the project is a tab.
      const onScreen =
        container &&
        !container.collapsed &&
        (container.activePaneId === terminal.id ||
          container.sidePaneId === terminal.id ||
          // A sibling of the active front, and open in this container: the
          // panes laid out beside the active one.
          (activeGroupId !== null &&
            terminal.groupId === activeGroupId &&
            container.paneIds.includes(terminal.id)))
      const isKeptAlive = keptAlivePaneIds.has(terminal.id)
      if (paneId && workspaceVisible && (onScreen || isKeptAlive)) {
        visible.add(paneId)
      }
      if (paneId && focusedTerminalIds.has(terminal.id)) {
        focused.add(paneId)
      }
    }
  }

  const canvasId = ui.agentCanvasSession?.ptyId
  if (canvasId && ui.activeView === 'agentCanvas') {
    visible.add(canvasId)
    focused.add(canvasId)
  }

  return { visible, focused }
}

let cached: PtyVisibilitySets | null = null

/** Everything `computeVisibleFocusedPtyIds` reads. */
function visibilityInputs(): unknown[] {
  const projects = useProjectsStore.getState()
  const ui = useUiStore.getState()
  return [
    projects.projects,
    projects.workspace.containers,
    ui.activeView,
    ui.focusedTerminalId,
    ui.activeTerminal,
    ui.keptAlivePaneIds,
    ui.agentCanvasSession,
  ]
}

let lastInputs: unknown[] = []
const visibilityListeners = new Set<() => void>()
let stopWatchingStores: (() => void) | null = null

/**
 * One subscription for every pane. Each pane used to subscribe to both stores
 * on its own and clear the cache in its own callback, so a single store change
 * recomputed the sets twice per mounted pane — and the resource sampler alone
 * changes the UI store three times every five seconds, for fields that decide
 * nothing here.
 */
function onStoreChange(): void {
  const inputs = visibilityInputs()
  if (inputs.every((value, index) => value === lastInputs[index])) return
  lastInputs = inputs
  cached = null
  for (const listener of visibilityListeners) listener()
}

function subscribePtyVisibility(callback: () => void): () => void {
  visibilityListeners.add(callback)
  if (!stopWatchingStores) {
    lastInputs = visibilityInputs()
    cached = null
    const unsubProjects = useProjectsStore.subscribe(onStoreChange)
    const unsubUi = useUiStore.subscribe(onStoreChange)
    stopWatchingStores = () => {
      unsubProjects()
      unsubUi()
    }
  }
  return () => {
    visibilityListeners.delete(callback)
    if (visibilityListeners.size === 0 && stopWatchingStores) {
      stopWatchingStores()
      stopWatchingStores = null
    }
  }
}

function visibilitySets(): PtyVisibilitySets {
  // With nobody subscribed nothing clears the cache, so nothing is kept.
  if (!stopWatchingStores) return computeVisibleFocusedPtyIds()
  if (!cached) cached = computeVisibleFocusedPtyIds()
  return cached
}

/**
 * Whether a pane is on screen *right now*, straight from the stores.
 *
 * The hook value reaches a ref through an effect, so code that runs between
 * commits — an async boot deciding whether to start its session — can read a
 * value that is already stale. This asks the source instead.
 */
export function isPtyPanelVisibleNow(ptyId: string | undefined): boolean {
  if (!ptyId) return false
  return visibilitySets().visible.has(ptyId)
}

export function usePtyPanelVisible(ptyId: string | undefined): boolean {
  return useSyncExternalStore(subscribePtyVisibility, () => {
    if (!ptyId) return false
    return visibilitySets().visible.has(ptyId)
  })
}

/**
 * Whether this pane is the one the user is working in. A pane that is on screen
 * but not focused still has to show live output, yet nobody is reading it at
 * frame rate — so it can repaint far less often than the focused one.
 */
export function usePtyPanelFocused(ptyId: string | undefined): boolean {
  return useSyncExternalStore(subscribePtyVisibility, () => {
    if (!ptyId) return false
    return visibilitySets().focused.has(ptyId)
  })
}
