// Task kinds and their stages, for the parts of the app that run outside the
// renderer: the MCP server and the `arco` command line.
//
// Mirrors `src/lib/todoKinds.ts`, spelled with hyphens the way the tools and the
// command line take them; `arcoMcpServer.test.ts` fails when the two drift.

const KIND_STATUSES = {
  review: ['review-pending', 'review-waiting-author', 'review-rereview', 'review-approved'],
  pr: [
    'pr-draft',
    'pr-waiting-review',
    'pr-changes-requested',
    'pr-waiting-revote',
    'pr-approved',
    'pr-waiting-hml',
  ],
  task: ['task-todo', 'task-blocked', 'task-in-progress', 'task-validating'],
  refinement: [
    'refinement-waiting-pm',
    'refinement-ready',
    'refinement-in-progress',
    'refinement-waiting-decision',
  ],
  release: [
    'release-scope-open',
    'release-assembling',
    'release-waiting-devops',
    'release-pipeline',
    'release-testing',
    'release-followup',
  ],
  investigation: [
    'investigation-open',
    'investigation-reply',
    'investigation-waiting-requester',
    'investigation-escalated',
  ],
  general: ['todo', 'in-progress', 'review'],
}
const KINDS = Object.keys(KIND_STATUSES)
const STATUSES = [...new Set([...Object.values(KIND_STATUSES).flat(), 'paused', 'done'])]

function kindOf(todo) {
  const kind = String(todo?.kind ?? 'general')
  return KINDS.includes(kind) ? kind : 'general'
}

/** Every status a task of this kind can hold, in board order. */
function statusesOf(kind) {
  return [...(KIND_STATUSES[kind] ?? KIND_STATUSES.general), 'paused', 'done']
}

/**
 * Status as the board shows it, spelled with hyphens. A stored status the
 * task's kind does not have reads as the kind's first stage, the same fallback
 * the app applies when it loads the file.
 */
function statusOf(todo) {
  if (todo?.completed) return 'done'
  const status = String(todo?.status ?? '').replace(/_/g, '-')
  const kind = kindOf(todo)
  return KIND_STATUSES[kind].includes(status) || status === 'paused'
    ? status
    : KIND_STATUSES[kind][0]
}

module.exports = { KIND_STATUSES, KINDS, STATUSES, kindOf, statusOf, statusesOf }
