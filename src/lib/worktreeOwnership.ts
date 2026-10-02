import type { Project, Terminal } from './types'

const WORKTREES_SEGMENT = '/.arco/worktrees/'

/**
 * The repository a worktree under `.arco/worktrees/` belongs to, read off its
 * own path; `fallback` when the path is not shaped like one.
 *
 * The project's directory is not always that repository, and a worktree opened
 * inside another one belongs to the inner tree — hence the last segment, not
 * the first.
 */
export function worktreeRepoOf(path: string, fallback = ''): string {
  const at = path.replace(/\\/g, '/').lastIndexOf(WORKTREES_SEGMENT)
  return at > 0 ? path.slice(0, at) : fallback
}

function within(path: string | undefined, root: string): boolean {
  if (!path || !root) return false
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === base || normalized.startsWith(`${base}/`)
}

/**
 * Whether the worktree a pane carries is somebody else's to remove.
 *
 * The first pane of a front provisions the front's worktree and keeps its id,
 * so the pane and the front both carry it, and a second session opened in the
 * front works in the same directory with no mark at all. Closing that first
 * pane used to remove the worktree with the front and its other panes still in
 * it. The worktree goes when the last holder goes: the front, through
 * `closeGroupWithWorktree`, or the one pane that had it alone.
 */
export function worktreeHeldBeyondPane(projects: Project[], terminal: Terminal): boolean {
  const id = terminal.worktreeAgentId
  if (!id) return false
  const home = terminal.cwd?.trim() ?? ''
  return projects.some(
    (project) =>
      (project.groups ?? []).some((group) => group.worktreeAgentId === id) ||
      project.terminals.some(
        (pane) =>
          pane.id !== terminal.id &&
          (pane.worktreeAgentId === id ||
            within(pane.cwd, home) ||
            pane.tabs.some((tab) => within(tab.cwd, home))),
      ),
  )
}

/**
 * Every worktree id something in the workspace still answers for, and the
 * directories panes work in — what a sweep for leftovers must not touch.
 */
export function heldWorktrees(projects: Project[]): { ids: Set<string>; dirs: string[] } {
  const ids = new Set<string>()
  const dirs: string[] = []
  for (const project of projects) {
    for (const group of project.groups ?? []) {
      if (group.worktreeAgentId) ids.add(group.worktreeAgentId)
      if (group.cwd) dirs.push(group.cwd)
    }
    for (const pane of project.terminals) {
      if (pane.worktreeAgentId) ids.add(pane.worktreeAgentId)
      if (pane.cwd) dirs.push(pane.cwd)
      for (const tab of pane.tabs) if (tab.cwd) dirs.push(tab.cwd)
    }
  }
  return { ids, dirs }
}

/** Whether any of `dirs` is `path` or lies below it. */
export function anyWithin(dirs: string[], path: string): boolean {
  return dirs.some((dir) => within(dir, path))
}
