import { normalizeTodoStatus, todoSessionLinks } from './todos'
import type { Project, TodoItem, TodoStatus } from './types'

// What a drop on the board does, kept out of the component so it can be tested
// without a DOM.

export type BoardDrop = { move: TodoStatus; then: 'nothing' | 'offer' }

/**
 * The pane a task can jump to, or null when none of its links is still alive.
 *
 * A link written from the command line often carries no project id, but the
 * pane is still findable: only one terminal in the app has that id.
 */
export function liveSessionOf(
  todo: TodoItem,
  projects: Project[],
): { projectId: string; terminalId: string } | null {
  for (const link of todoSessionLinks(todo)) {
    const project =
      (link.projectId ? projects.find((item) => item.id === link.projectId) : null) ??
      projects.find((item) => item.terminals.some((term) => term.id === link.terminalId))
    if (project?.terminals.some((term) => term.id === link.terminalId)) {
      return { projectId: project.id, terminalId: link.terminalId }
    }
  }
  return null
}

/**
 * Decides a drop.
 *
 * Moving the card always changes the status. Landing in "in progress" is a
 * statement about starting, so the board also offers a session — but never
 * spawns one: a drag is a cheap gesture to make by accident and starting an
 * agent is expensive and visible. An offer is a filled-in modal one key away.
 *
 * A drop never navigates. Sorting the board is a batch gesture — several cards
 * in a row — and being thrown into a terminal after the first one ends it.
 * Opening a session is a separate, deliberate gesture: double-click the card.
 *
 * A task that already has a live pane only moves; the work started once, and
 * proposing a second session for it would be noise. So does coming back from
 * review or done.
 */
export function resolveBoardDrop(todo: TodoItem, projects: Project[], to: TodoStatus): BoardDrop {
  const from = normalizeTodoStatus(todo.status, todo.completed)
  if (to !== 'in_progress' || from === 'in_progress') return { move: to, then: 'nothing' }
  if (liveSessionOf(todo, projects)) return { move: to, then: 'nothing' }
  return { move: to, then: from === 'todo' ? 'offer' : 'nothing' }
}
