import type { AdoPullRequestSnapshot, AdoWorkItemSnapshot } from './adoApi'
import type { TodoItem, TodoStatus } from './types'

/**
 * Reduces a snapshot of the ADO side into the status the task should carry.
 *
 * Kept as a pure function so the same rules can be unit-tested away from the
 * poll loop. The current-user identity is passed in because "the ball is in
 * my court" depends on who I am — reviewer sign vs. author sign both matter
 * only relative to that identity.
 */

export type WatcherIdentity = {
  /** The unique email of the person Arco runs as. Matches `System.AssignedTo.uniqueName`. */
  uniqueName?: string
}

export type WatcherEvent = {
  todoId: string
  reason: string
  /** New status when the rule mandates one; missing means "no status change". */
  status?: TodoStatus
}

const WORK_ITEM_STATES: Record<string, TodoStatus> = {
  new: 'todo',
  approved: 'todo',
  'to do': 'todo',
  'sprint backlog': 'todo',
  committed: 'in_progress',
  doing: 'in_progress',
  'in progress': 'in_progress',
  'waiting code review': 'review',
  'code review': 'review',
  'waiting hml': 'review',
  hml: 'review',
  validated: 'done',
  completed: 'done',
  closed: 'done',
  done: 'done',
  resolved: 'done',
  removed: 'done',
}

/**
 * Chooses the status a work item's `System.State` implies. Returns `null` for
 * an unknown state — the caller keeps whatever the task already had rather
 * than falling into `todo` and undoing what the person set.
 */
export function statusFromWorkItem(snapshot: AdoWorkItemSnapshot): TodoStatus | null {
  const key = snapshot.state.trim().toLowerCase()
  return WORK_ITEM_STATES[key] ?? null
}

/**
 * Chooses the status a PR's shape implies for the task's owner.
 *
 * Draft, mergeable-awaiting-vote, and merge/abandon are the three transitions
 * the sidebar cares about — anything narrower (reviewer votes, thread state)
 * follows from those and is decided by `statusFromPullRequestForOwner`.
 */
export function statusFromPullRequest(snapshot: AdoPullRequestSnapshot): TodoStatus | null {
  if (snapshot.status === 'completed') return 'done'
  if (snapshot.status === 'abandoned') return null
  if (snapshot.isDraft) return 'in_progress'
  return 'review'
}

/**
 * Refines the PR-derived status when the task's owner is the PR author: an
 * ask-for-changes vote or a fresh reviewer thread means the ball is back
 * with the author, not with the reviewers.
 */
export function statusFromPullRequestForOwner(
  snapshot: AdoPullRequestSnapshot,
  identity: WatcherIdentity,
): TodoStatus | null {
  const base = statusFromPullRequest(snapshot)
  if (!base) return null
  if (base === 'done') return base
  const authoredByMe = identity.uniqueName
    ? snapshot.createdByUniqueName === identity.uniqueName
    : false
  if (!authoredByMe) return base
  const askedForChanges = snapshot.reviewers.some((reviewer) => reviewer.vote < 0)
  if (askedForChanges || snapshot.hasActiveThreads) return 'in_progress'
  return base
}

/** Runs the same status-picking rule the sidebar uses today, without importing the store. */
export function currentStatus(todo: TodoItem): TodoStatus {
  if (todo.completed) return 'done'
  if (todo.status === 'in_progress' || todo.status === 'review' || todo.status === 'done') {
    return todo.status
  }
  return 'todo'
}

/**
 * Decides what — if anything — the watcher should do for a single task given a
 * pair of snapshots. The rules are intentionally conservative: a null result
 * means "leave the task alone", not "reset to todo".
 */
export function planTaskTransition(
  todo: TodoItem,
  snapshots: {
    workItem?: AdoWorkItemSnapshot | null
    pullRequest?: AdoPullRequestSnapshot | null
  },
  identity: WatcherIdentity = {},
): WatcherEvent | null {
  const fromPr = snapshots.pullRequest
    ? statusFromPullRequestForOwner(snapshots.pullRequest, identity)
    : null
  const fromWi = snapshots.workItem ? statusFromWorkItem(snapshots.workItem) : null
  const target = fromPr ?? fromWi
  if (!target) return null
  const status = currentStatus(todo)
  if (status === target) return null
  const reason = fromPr
    ? `PR !${snapshots.pullRequest?.id} → ${target.replace('_', '-')}`
    : `Work item #${snapshots.workItem?.id} em ${snapshots.workItem?.state} → ${target.replace('_', '-')}`
  return { todoId: todo.id, status: target, reason }
}
