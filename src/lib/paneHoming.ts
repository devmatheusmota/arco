/**
 * Which front a new pane belongs to when nobody said.
 *
 * A pane with no front is a pane the model cannot show: the sidebar lists
 * fronts, the screen shows the panes of the front that is open, and one that
 * belongs to neither takes the screen from the work the user was in the middle
 * of. Most pane-creating routes — a keybinding, the home screen, a handoff, a
 * recovered chat, the scheduler — never had a front to pass, so the answer is
 * worked out here instead of at every call site.
 */

import type { Project, ProjectsFile } from './types'

type Workspace = ProjectsFile['workspace']

/**
 * The front the user is looking at in that project, or null when the project
 * has no container on screen, or its active pane belongs to no front.
 */
export function activeGroupId(
  project: Project | undefined,
  workspace: Workspace,
  projectId: string,
): string | null {
  const container = workspace.containers.find((item) => item.projectId === projectId)
  if (!container?.activePaneId) return null
  const active = project?.terminals.find((pane) => pane.id === container.activePaneId)
  const groupId = active?.groupId
  if (!groupId) return null
  // A pointer to a front that was closed is not a home.
  return (project?.groups ?? []).some((group) => group.id === groupId) ? groupId : null
}

/**
 * Where a pane being created should land: the front it was given, else the one
 * on screen, else none — and "none" is the caller's cue to open a front for it.
 */
export function homeGroupId(args: {
  requested?: string
  /** The pane provisioned a worktree of its own. */
  ownsWorktree?: boolean
  project: Project | undefined
  workspace: Workspace
  projectId: string
}): string | null {
  const { requested, project } = args
  if (requested && (project?.groups ?? []).some((group) => group.id === requested)) {
    return requested
  }
  // A front is one piece of work in one tree. A pane that brought its own
  // checkout would put a second tree inside a front already working in another,
  // so it gets a front of its own instead.
  if (args.ownsWorktree) return null
  return activeGroupId(project, args.workspace, args.projectId)
}
