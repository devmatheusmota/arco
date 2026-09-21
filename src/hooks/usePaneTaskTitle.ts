import { paneTaskTitle } from '../lib/sessionLabel'
import { useProjectsStore } from '../stores/projectsStore'

/**
 * The title of the task this pane is working on, or `null` when it has none.
 *
 * Selects the string rather than the task, so a label that reads it repaints
 * when that title changes and not whenever anything else on the board moves.
 */
export function usePaneTaskTitle(paneId: string): string | null {
  return useProjectsStore((s) => paneTaskTitle(s.todos, paneId))
}
