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
        (container.activePaneId === terminal.id || container.sidePaneId === terminal.id)
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

function subscribePtyVisibility(callback: () => void): () => void {
  const unsubProjects = useProjectsStore.subscribe(() => {
    cached = null
    callback()
  })
  const unsubUi = useUiStore.subscribe(() => {
    cached = null
    callback()
  })
  return () => {
    unsubProjects()
    unsubUi()
  }
}

let cached: PtyVisibilitySets | null = null

function visibilitySets(): PtyVisibilitySets {
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
