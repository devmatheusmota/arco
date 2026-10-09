import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import {
  ALL_TODO_STATUSES,
  parseTodoKind,
  resolveTodoStatusForKind,
  statusBelongsToKind,
  TODO_KINDS,
  todoKindStatuses,
  todoStatusTone,
} from './todoKinds'
import { normalizeTodoStatus, parseTodoStatus, todoStatusOf } from './todos'

const require = createRequire(import.meta.url)
const shared = require('../../electron/todo-kinds.cjs') as {
  KIND_STATUSES: Record<string, string[]>
  STATUSES: string[]
}

describe('task kinds', () => {
  it('match the table the MCP server and the command line read', () => {
    const spelled = (statuses: string[]) => statuses.map((status) => status.replace(/_/g, '-'))
    for (const kind of TODO_KINDS) {
      expect(spelled(todoKindStatuses(kind)).slice(0, -2)).toEqual(shared.KIND_STATUSES[kind])
    }
    expect(Object.keys(shared.KIND_STATUSES).sort()).toEqual([...TODO_KINDS].sort())
    expect([...shared.STATUSES].sort()).toEqual(spelled(ALL_TODO_STATUSES).sort())
  })

  it('give every kind paused and done', () => {
    for (const kind of TODO_KINDS) {
      expect(todoKindStatuses(kind).slice(-2)).toEqual(['paused', 'done'])
    }
  })

  it('read a kind as typed and refuse anything else, prototype keys included', () => {
    expect(parseTodoKind(' Review ')).toBe('review')
    expect(parseTodoKind('toString')).toBeNull()
    expect(parseTodoKind('bug')).toBeNull()
  })
})

describe('resolveTodoStatusForKind', () => {
  // The words every agent and skill learned before kinds existed keep working.
  it('reads todo, in progress and review as the kind’s first stage, start and hand-back', () => {
    expect(resolveTodoStatusForKind('todo', 'pr')).toBe('pr_draft')
    expect(resolveTodoStatusForKind('in_progress', 'task')).toBe('task_in_progress')
    expect(resolveTodoStatusForKind('review', 'task')).toBe('task_validating')
    expect(resolveTodoStatusForKind('review', 'review')).toBe('review_waiting_author')
    expect(resolveTodoStatusForKind('in_progress', 'general')).toBe('in_progress')
  })

  it('refuses a stage of another kind', () => {
    expect(resolveTodoStatusForKind('pr_draft', 'review')).toBeNull()
    expect(statusBelongsToKind('paused', 'release')).toBe(true)
  })
})

describe('status parsing and reading', () => {
  it('takes staged statuses with hyphens or underscores', () => {
    expect(parseTodoStatus('review-waiting-author')).toBe('review_waiting_author')
    expect(parseTodoStatus('PR_DRAFT')).toBe('pr_draft')
    expect(parseTodoStatus('in-progress')).toBe('in_progress')
  })

  it('reads a stored status the kind lacks as that kind’s first stage', () => {
    expect(normalizeTodoStatus('pr_draft', false, 'review')).toBe('review_pending')
    expect(normalizeTodoStatus(undefined, false, 'release')).toBe('release_scope_open')
    expect(normalizeTodoStatus('task_blocked', true, 'task')).toBe('done')
    expect(todoStatusOf({ status: 'review_rereview', completed: false, kind: 'review' })).toBe(
      'review_rereview',
    )
  })
})

describe('todoStatusTone', () => {
  it('colours a start as working, someone else’s turn as waiting, and leaves the rest idle', () => {
    expect(todoStatusTone('task_in_progress')).toBe('working')
    expect(todoStatusTone('review_waiting_author')).toBe('waiting')
    expect(todoStatusTone('release_pipeline')).toBe('waiting')
    expect(todoStatusTone('review_rereview')).toBe('idle')
    // Untouched, even though a review's work starts there.
    expect(todoStatusTone('review_pending')).toBe('idle')
    expect(todoStatusTone('done')).toBe('done')
  })
})
