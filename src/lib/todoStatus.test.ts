import { describe, expect, it } from 'vitest'

import {
  applyTodoStatus,
  findTodoByRef,
  normalizeTodoStatus,
  parseTodoStatus,
  placeTodoInList,
} from './todos'
import type { TodoItem } from './types'

const task = (overrides: Partial<TodoItem> & { id: string }): TodoItem => ({
  title: 'task',
  completed: false,
  tags: [],
  ...overrides,
})

describe('parseTodoStatus', () => {
  it('accepts the words people and agents actually type', () => {
    expect(parseTodoStatus('in-progress')).toBe('in_progress')
    expect(parseTodoStatus('WIP')).toBe('in_progress')
    expect(parseTodoStatus(' code-review ')).toBe('review')
    expect(parseTodoStatus('completed')).toBe('done')
  })

  it('rejects anything else so a typo is not silently a default', () => {
    expect(parseTodoStatus('almost')).toBeNull()
    expect(parseTodoStatus(undefined)).toBeNull()
  })
})

describe('normalizeTodoStatus', () => {
  it('reads a finished task as done regardless of what was stored', () => {
    expect(normalizeTodoStatus('review', true)).toBe('done')
    expect(normalizeTodoStatus(undefined, true)).toBe('done')
  })

  it('falls back to todo for an open task', () => {
    expect(normalizeTodoStatus(undefined, false)).toBe('todo')
    expect(normalizeTodoStatus('done', false)).toBe('todo')
    expect(normalizeTodoStatus('review', false)).toBe('review')
  })
})

describe('applyTodoStatus', () => {
  it('moves completed along with the status', () => {
    const done = applyTodoStatus(task({ id: 'a' }), 'done')
    expect(done.completed).toBe(true)
    expect(done.completedAt).toBeTypeOf('number')

    const reopened = applyTodoStatus(done, 'in_progress')
    expect(reopened.completed).toBe(false)
    expect(reopened.completedAt).toBeUndefined()
  })

  it('keeps an intermediate status open', () => {
    expect(applyTodoStatus(task({ id: 'a' }), 'review').completed).toBe(false)
  })
})

describe('placeTodoInList', () => {
  it('sinks a finished task to the bottom', () => {
    const items = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
    const moved = placeTodoInList(items, applyTodoStatus(items[0], 'done'))
    expect(moved.map((item) => item.id)).toEqual(['b', 'c', 'a'])
  })

  it('returns a reopened task above the finished block', () => {
    const items = [
      task({ id: 'a' }),
      task({ id: 'b', completed: true }),
      task({ id: 'c', completed: true }),
    ]
    const moved = placeTodoInList(items, applyTodoStatus(items[2], 'todo'))
    expect(moved.map((item) => item.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('findTodoByRef', () => {
  const items = [
    task({ id: 'abc123', title: 'Fix the parser' }),
    task({ id: 'abd999', title: 'Write the docs' }),
    task({ id: 'zzz000', title: 'Fix the linter' }),
  ]

  it('matches a full id', () => {
    expect(findTodoByRef(items, 'abd999').todo?.id).toBe('abd999')
  })

  it('matches an id prefix', () => {
    expect(findTodoByRef(items, 'abc').todo?.id).toBe('abc123')
  })

  it('matches a piece of the title', () => {
    expect(findTodoByRef(items, 'parser').todo?.id).toBe('abc123')
  })

  it('reports the candidates instead of guessing', () => {
    const byId = findTodoByRef(items, 'ab')
    expect(byId.todo).toBeNull()

    const byTitle = findTodoByRef(items, 'fix the')
    expect(byTitle.todo).toBeNull()
    expect(byTitle.ambiguous.map((item) => item.id)).toEqual(['abc123', 'zzz000'])
  })

  it('finds nothing for an empty reference', () => {
    expect(findTodoByRef(items, '  ').todo).toBeNull()
  })
})
