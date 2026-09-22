import { useEffect } from 'react'

import { APP_SHELL_ID } from '../lib/appShell'
import { frontEntryPane, frontForSlot, orderedFronts } from '../lib/frontOrder'
import { getLocale, translate } from '../lib/i18n'
import {
  type AppShortcut,
  FOCUS_TASK_COMPOSER_EVENT,
  keyFocusOf,
  type PaneDirection,
  resolveAppShortcut,
  taskComposerAvailable,
} from '../lib/keybindings'
import { paneInCycle, paneInDirection, paneRects, panesOnScreen } from '../lib/paneLayout'
import type { Terminal } from '../lib/types'
import {
  MAX_RECENT_PROJECT_TABS,
  selectActiveContainer,
  selectActiveProject,
  selectFirstWorkspaceTerminal,
  UI_ZOOM_LIMITS,
  useProjectsStore,
} from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const ui = useUiStore.getState()
        if (ui.openModal) {
          e.preventDefault()
          ui.closeModal()
          return
        }
        const projects = useProjectsStore.getState()
        if (projects.preferences.fullscreenContainerId) {
          e.preventDefault()
          projects.setFullscreenContainer(null)
          return
        }
      }

      const shortcut = resolveAppShortcut(e, {
        focus: keyFocusOf(e.target),
        taskComposer: taskComposerAvailable(),
      })
      if (!shortcut) return
      if (shortcut.type === 'restartTerminal' && !restartableTerminalSelected()) return
      e.preventDefault()
      runShortcut(shortcut)
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Coming back to the app can leave the webview with no focused element, and
  // WebView2 then keeps Ctrl+Tab for its own focus traversal instead of handing
  // the key to the page. Parking focus on the shell keeps the shortcuts alive
  // without pulling it away from a terminal, an input, or a modal.
  useEffect(() => {
    const restoreShellFocus = () => {
      if (document.visibilityState === 'hidden') return
      const active = document.activeElement
      if (active && active !== document.body) return
      document.getElementById(APP_SHELL_ID)?.focus({ preventScroll: true })
    }
    const onWindowFocus = () => {
      restoreShellFocus()
      window.requestAnimationFrame(restoreShellFocus)
    }
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onWindowFocus)
    onWindowFocus()
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onWindowFocus)
    }
  }, [])
}

function runShortcut(shortcut: AppShortcut) {
  switch (shortcut.type) {
    case 'zoom': {
      const projects = useProjectsStore.getState()
      projects.setUiZoom(projects.preferences.uiZoom + shortcut.step * UI_ZOOM_LIMITS.step)
      return
    }
    case 'zoomReset':
      useProjectsStore.getState().setUiZoom(1)
      return
    case 'restartTerminal': {
      const selected = useUiStore.getState().activeTerminal
      if (!selected) return
      window.dispatchEvent(
        new CustomEvent('arco:terminal-restart-request', {
          detail: { terminalId: selected.terminalId },
        }),
      )
      return
    }
    case 'toggleLeftSidebar': {
      const projects = useProjectsStore.getState()
      projects.setPreferences({
        leftSidebarVisible: !projects.preferences.leftSidebarVisible,
      })
      return
    }
    case 'newTerminal': {
      const project = selectActiveProject(useProjectsStore.getState())
      if (!project) return
      useUiStore.getState().openModal_('newTerminal', { projectId: project.id })
      return
    }
    case 'repeatTerminal':
      repeatLastTerminal()
      return
    case 'reopenClosedTab':
      useProjectsStore.getState().reopenClosedWorkspaceTab()
      return
    case 'addContent': {
      const project = selectActiveProject(useProjectsStore.getState())
      if (!project) return
      useUiStore.getState().openModal_('addContent', { projectId: project.id })
      return
    }
    case 'closePane': {
      const projects = useProjectsStore.getState()
      const container = selectActiveContainer(projects)
      if (!container || container.paneIds.length === 0) return
      // Close what is on screen, not whatever happens to be first in the list.
      projects.closePane(container.projectId, container.activePaneId ?? container.paneIds[0])
      return
    }
    case 'findJump':
      useUiStore.getState().openModal_('findJump')
      return
    case 'newProject':
      useUiStore.getState().openModal_('newProject')
      return
    case 'toggleHome':
      useUiStore.getState().toggleHome()
      return
    case 'focusTaskComposer':
      window.dispatchEvent(new Event(FOCUS_TASK_COMPOSER_EVENT))
      return
    case 'openFront':
      openFront(shortcut.slot)
      return
    case 'history':
      useProjectsStore.getState().navigateWorkspaceHistory(shortcut.step)
      useUiStore.getState().setActiveView('workspace')
      return
    case 'cyclePane':
    case 'focusPane':
      movePaneFocus(shortcut.type === 'cyclePane' ? shortcut.step : shortcut.direction)
      return
    case 'cycleProjectTab':
      cycleProjectTab(shortcut.step)
      return
  }
}

/** R restarts the selected terminal, and only a live terminal pane can be restarted. */
function restartableTerminalSelected(): boolean {
  const selected = useUiStore.getState().activeTerminal
  if (!selected) return false
  const terminal = useProjectsStore
    .getState()
    .projects.find((item) => item.id === selected.projectId)
    ?.terminals.find((item) => item.id === selected.terminalId)
  return Boolean(terminal && !terminal.disabled && (!terminal.kind || terminal.kind === 'terminal'))
}

// Ctrl+Alt+T repeats the last terminal configuration without reopening the picker.
function repeatLastTerminal() {
  const projects = useProjectsStore.getState()
  const project = selectActiveProject(projects)
  if (!project) return
  const creation = projects.preferences.lastTerminalCreation
  if (!creation) {
    useUiStore.getState().openModal_('newTerminal', { projectId: project.id })
    return
  }
  void projects
    .createAgentTerminal(project.id, {
      ...creation,
      firstTab: {
        ...creation.firstTab,
        extraArgs: creation.firstTab.extraArgs?.slice(),
      },
    })
    .catch((error) => {
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'term.repeatCreationFailed'),
        body: String(error),
      })
    })
}

/** Puts a session in front of the user the way clicking it does. */
function focusPane(projectId: string, terminalId: string, view: 'workspace' | 'agentSandbox') {
  const projects = useProjectsStore.getState()
  const ui = useUiStore.getState()
  projects.focusWorkspaceTerminal(projectId, terminalId)
  ui.setActiveTerminal(projectId, terminalId)
  projects.clearTerminalCompletionUnread(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
  ui.setActiveView(view)
}

function openFront(slot: number) {
  const projects = useProjectsStore.getState()
  const front = frontForSlot(orderedFronts(projects.projectOrder, projects.projects), slot)
  if (!front) return
  const pane = frontEntryPane(front)
  focusPane(
    front.projectId,
    pane.id,
    front.projectMode === 'agentSandbox' ? 'agentSandbox' : 'workspace',
  )
}

/**
 * Moves between the sessions on screen — the front's panes and the terminal
 * beside them — by position or in order. Other fronts are reached with
 * Ctrl+digit, so neither way leaves the one you are in.
 */
function movePaneFocus(move: 1 | -1 | PaneDirection) {
  const projects = useProjectsStore.getState()
  const ui = useUiStore.getState()
  // A session in focus mode covers the others; there is nothing beside it to move to.
  if (ui.focusedTerminalId) return
  const project = selectActiveProject(projects)
  const container = selectActiveContainer(projects)
  if (!project || !container || container.collapsed) return
  const byId = new Map(project.terminals.map((terminal) => [terminal.id, terminal]))
  const panes = container.paneIds
    .map((id) => byId.get(id))
    .filter((terminal): terminal is Terminal => Boolean(terminal))
  const { activePane, visibleIds, sidePane } = panesOnScreen(panes, container)
  const stackIds = visibleIds.filter((id) => id !== sidePane?.id)
  const onScreen = sidePane ? [...stackIds, sidePane.id] : stackIds
  const selected = ui.activeTerminal?.terminalId
  const currentId = selected && onScreen.includes(selected) ? selected : (activePane?.id ?? null)
  const targetId =
    typeof move === 'number'
      ? paneInCycle(onScreen, currentId, move)
      : paneInDirection(paneRects(stackIds, sidePane?.id ?? null), currentId, move)
  if (!targetId || targetId === currentId) return
  focusPane(project.id, targetId, 'workspace')
}

function cycleProjectTab(step: 1 | -1) {
  const projects = useProjectsStore.getState()
  const ui = useUiStore.getState()
  const topTabs = projects.workspace.tabs.slice(0, MAX_RECENT_PROJECT_TABS)
  if (topTabs.length < 2) return
  const currentIndex = topTabs.findIndex((tab) => tab.id === projects.workspace.activeTabId)
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + step + topTabs.length) % topTabs.length
  projects.activateWorkspaceTab(topTabs[nextIndex].id)
  ui.setActiveView('workspace')
  const entry = selectFirstWorkspaceTerminal(useProjectsStore.getState())
  if (entry) {
    projects.focusWorkspaceTerminal(entry.projectId, entry.terminalId)
    ui.setActiveTerminal(entry.projectId, entry.terminalId)
    ui.requestPaneFocus(entry.terminalId)
  }
}
