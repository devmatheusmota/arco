import type { TodoHolder, TodoKind, TodoStatus } from './types'

// What kind of work a task is, and the stages that kind of work goes through.
//
// One list of four statuses could not say where a task actually stood: a pull
// request someone else wrote waits on its author after the review, a pull
// request of your own waits on its reviewers, a release waits on DevOps, and all
// of them sat in "review". Each kind now carries its own stages, so the status
// names the next step and whose turn it is. `paused` and `done` are shared by
// every kind; `general` keeps the original three for work that fits no kind.

export const TODO_KINDS: TodoKind[] = [
  'review',
  'pr',
  'task',
  'refinement',
  'release',
  'investigation',
  'general',
]

type KindDefinition = {
  /** The stages of this kind, in the order the work usually moves through them. */
  stages: TodoStatus[]
  /** Where "start working on it" lands: the CLI's `in-progress` and the board's offer to open a session. */
  start: TodoStatus
  /** Where "hand the work back" lands: the CLI's `review`. */
  handoff: TodoStatus
}

const KINDS: Record<TodoKind, KindDefinition> = {
  review: {
    stages: ['review_pending', 'review_waiting_author', 'review_rereview', 'review_approved'],
    start: 'review_pending',
    handoff: 'review_waiting_author',
  },
  pr: {
    stages: [
      'pr_draft',
      'pr_waiting_review',
      'pr_changes_requested',
      'pr_waiting_revote',
      'pr_approved',
      'pr_waiting_hml',
    ],
    start: 'pr_changes_requested',
    handoff: 'pr_waiting_review',
  },
  task: {
    stages: ['task_todo', 'task_blocked', 'task_in_progress', 'task_validating'],
    start: 'task_in_progress',
    handoff: 'task_validating',
  },
  refinement: {
    stages: [
      'refinement_waiting_pm',
      'refinement_ready',
      'refinement_in_progress',
      'refinement_waiting_decision',
    ],
    start: 'refinement_in_progress',
    handoff: 'refinement_waiting_decision',
  },
  release: {
    stages: [
      'release_scope_open',
      'release_assembling',
      'release_waiting_devops',
      'release_pipeline',
      'release_testing',
      'release_followup',
    ],
    start: 'release_assembling',
    handoff: 'release_testing',
  },
  investigation: {
    stages: [
      'investigation_open',
      'investigation_reply',
      'investigation_waiting_requester',
      'investigation_escalated',
    ],
    start: 'investigation_open',
    handoff: 'investigation_waiting_requester',
  },
  general: {
    stages: ['todo', 'in_progress', 'review'],
    start: 'in_progress',
    handoff: 'review',
  },
}

/** Who has to move next. Not shown on its own yet; it is what decides a status's colour. */
const HOLDER: Record<TodoStatus, TodoHolder> = {
  todo: 'me',
  in_progress: 'me',
  review: 'other',
  paused: 'me',
  done: 'me',
  review_pending: 'me',
  review_waiting_author: 'other',
  review_rereview: 'me',
  review_approved: 'other',
  pr_draft: 'me',
  pr_waiting_review: 'other',
  pr_changes_requested: 'me',
  pr_waiting_revote: 'other',
  pr_approved: 'me',
  pr_waiting_hml: 'me',
  task_todo: 'me',
  task_blocked: 'other',
  task_in_progress: 'me',
  task_validating: 'me',
  refinement_waiting_pm: 'other',
  refinement_ready: 'me',
  refinement_in_progress: 'me',
  refinement_waiting_decision: 'other',
  release_scope_open: 'other',
  release_assembling: 'me',
  release_waiting_devops: 'other',
  release_pipeline: 'machine',
  release_testing: 'other',
  release_followup: 'me',
  investigation_open: 'me',
  investigation_reply: 'me',
  investigation_waiting_requester: 'other',
  investigation_escalated: 'other',
}

const SHARED: TodoStatus[] = ['paused', 'done']

/** Every status any kind can hold, shared ones last. */
export const ALL_TODO_STATUSES: TodoStatus[] = [
  ...new Set([...TODO_KINDS.flatMap((kind) => KINDS[kind].stages), ...SHARED]),
]

const STATUS_SET = new Set<string>(ALL_TODO_STATUSES)

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

/** A kind as typed on the command line; null for anything that is not one. */
export function parseTodoKind(value: unknown): TodoKind | null {
  if (typeof value !== 'string') return null
  const kind = value.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? (kind as TodoKind) : null
}

export function normalizeTodoKind(value: unknown): TodoKind {
  return parseTodoKind(value) ?? 'general'
}

/** The statuses a task of this kind can be moved to, in board order. */
export function todoKindStatuses(kind: TodoKind): TodoStatus[] {
  return [...KINDS[kind].stages, ...SHARED]
}

/** The status a new task of this kind starts in. */
export function todoKindInitialStatus(kind: TodoKind): TodoStatus {
  return KINDS[kind].stages[0]
}

export function todoKindStartStatus(kind: TodoKind): TodoStatus {
  return KINDS[kind].start
}

export function todoHolder(status: TodoStatus): TodoHolder {
  return HOLDER[status]
}

export function statusBelongsToKind(status: TodoStatus, kind: TodoKind): boolean {
  return SHARED.includes(status) || KINDS[kind].stages.includes(status)
}

/**
 * How a status is drawn: `working` while someone is at it, `waiting` while the
 * turn is somebody else's (or a pipeline's), `idle` when it sits with you
 * untouched, `done` at the end. The old board coloured `in_progress` and
 * `review` and left the rest neutral; this keeps that reading for every kind.
 */
export function todoStatusTone(status: TodoStatus): 'idle' | 'working' | 'waiting' | 'done' {
  if (status === 'done') return 'done'
  if (HOLDER[status] !== 'me') return 'waiting'
  // A kind whose work starts in its first stage (a review, an investigation) has
  // no separate "started" stage, and colouring that first stage would paint
  // every untouched task as work in flight.
  return TODO_KINDS.some((kind) => KINDS[kind].start === status && KINDS[kind].stages[0] !== status)
    ? 'working'
    : 'idle'
}

/**
 * Resolves what a caller asked for against a task's kind.
 *
 * `todo`, `in_progress` and `review` are the words every agent, skill and
 * script learned before kinds existed, so they keep working: they mean "the
 * first stage", "start" and "hand back" of whatever kind the task is. Anything
 * else has to be a stage of that kind, or null so the caller can say which
 * ones are.
 */
export function resolveTodoStatusForKind(status: TodoStatus, kind: TodoKind): TodoStatus | null {
  if (statusBelongsToKind(status, kind)) return status
  if (status === 'todo') return todoKindInitialStatus(kind)
  if (status === 'in_progress') return KINDS[kind].start
  if (status === 'review') return KINDS[kind].handoff
  return null
}
