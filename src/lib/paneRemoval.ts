/**
 * Taking panes out of a project and every place the workspace remembers them.
 *
 * A pane lives in four places at once: the project's own list, the live
 * containers, the containers inside each saved tab's snapshot, and the ones in
 * the navigation history. Leaving an id in any of the last three leaves a
 * container pointing at a pane that does not exist, which is how a closed
 * session comes back as an empty box.
 *
 * Pure on purpose: closing one pane and closing a whole front of work remove
 * the same things from the same places, and only the list of ids differs.
 */

import { pruneTodoSessions } from './todos'
import type { ProjectsFile, TodoItem } from './types'
import { sanitizeWorkspaceSnapshot } from './workspaceNavigation'

type Workspace = ProjectsFile['workspace']

export type PaneRemoval = {
  projects: ProjectsFile['projects']
  workspace: Workspace
  todos: TodoItem[]
}

export function removePanesFromWorkspace(args: {
  projects: ProjectsFile['projects']
  workspace: Workspace
  todos: TodoItem[]
  projectId: string
  paneIds: ReadonlySet<string>
  /** Groups to drop along with the panes. Empty when only panes are closing. */
  groupIds?: ReadonlySet<string>
}): PaneRemoval {
  const { paneIds, projectId } = args
  const groupIds = args.groupIds ?? new Set<string>()

  const projects = args.projects.map((project) =>
    project.id === projectId
      ? {
          ...project,
          terminals: project.terminals.filter((terminal) => !paneIds.has(terminal.id)),
          ...(groupIds.size > 0
            ? { groups: (project.groups ?? []).filter((group) => !groupIds.has(group.id)) }
            : {}),
        }
      : project,
  )

  // Which front each pane belonged to, read before the removal — it is what
  // decides where the cursor lands next.
  const frontOf = new Map(
    (args.projects.find((project) => project.id === projectId)?.terminals ?? []).map((terminal) => [
      terminal.id,
      terminal.groupId,
    ]),
  )

  // A container with no panes left is a box with nothing in it. The pointers
  // into it move too: an `activePaneId` naming a pane that is gone is a dead id
  // that every reader then has to guess around.
  const containers = args.workspace.containers
    .map((container) => {
      if (container.projectId !== projectId) return container
      const remaining = container.paneIds.filter((id) => !paneIds.has(id))
      // Closing a pane must not move the user to another piece of work. The
      // front the closed pane was in is the one still on screen, so the next
      // active pane comes from there; the first pane of the container is a
      // fallback for when that front closed too, or had nothing else in it.
      const front = frontOf.get(container.activePaneId ?? '')
      const nextActive = remaining.find((id) => frontOf.get(id) === front) ?? remaining[0] ?? null
      return {
        ...container,
        paneIds: remaining,
        activePaneId: paneIds.has(container.activePaneId ?? '')
          ? nextActive
          : container.activePaneId,
        sidePaneId: paneIds.has(container.sidePaneId ?? '') ? null : container.sidePaneId,
      }
    })
    .filter((container) => container.paneIds.length > 0)

  const tabs = args.workspace.tabs
    .filter(
      (tab) =>
        !(
          tab.kind === 'terminal' &&
          tab.projectId === projectId &&
          paneIds.has(tab.terminalId ?? '')
        ),
    )
    .map((tab) => ({ ...tab, snapshot: sanitizeWorkspaceSnapshot(tab.snapshot, projects) }))

  const tabIds = new Set(tabs.map((tab) => tab.id))
  const history = args.workspace.history
    .filter((entry) => tabIds.has(entry.tabId))
    .map((entry) => ({ ...entry, snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, projects) }))

  return {
    projects,
    // A task that launched one of these panes must not keep pointing at it.
    todos: pruneTodoSessions(args.todos, (link) => !paneIds.has(link.terminalId)),
    workspace: {
      ...args.workspace,
      containers,
      tabs,
      activeTabId: tabIds.has(args.workspace.activeTabId ?? '')
        ? args.workspace.activeTabId
        : (tabs[0]?.id ?? null),
      focusedTerminalId: paneIds.has(args.workspace.focusedTerminalId ?? '')
        ? null
        : args.workspace.focusedTerminalId,
      history,
      historyIndex: Math.min(args.workspace.historyIndex, history.length - 1),
    },
  }
}
