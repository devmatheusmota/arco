import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Brings a pane to the front, wherever the user currently is.
 *
 * Five calls have to happen together — the project becomes active, the pane is
 * focused inside its container, the UI records it, the DOM focus is requested,
 * and the view switches — and getting one of them wrong lands the user on the
 * right project with the wrong pane. It lived inside the todo sidebar while
 * `TaskSessionModal` repeated the same body inline; the board is the third
 * caller, which is one copy too many.
 */
export function useSessionFocus() {
  const setActiveView = useUiStore((state) => state.setActiveView)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)

  return (projectId: string, terminalId: string) => {
    const store = useProjectsStore.getState()
    store.setActiveProjectOnly(projectId)
    store.focusWorkspaceTerminal(projectId, terminalId)
    setActiveTerminal(projectId, terminalId)
    requestPaneFocus(terminalId)
    setActiveView('workspace')
  }
}
