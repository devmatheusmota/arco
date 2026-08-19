import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { parseTodo, parseTodoEdit, formatTodoTable, statusOf } = require('../../electron/cli.cjs') as {
  parseTodo: (args: string[]) => Record<string, unknown>
  parseTodoEdit: (args: string[]) => Record<string, unknown>
  formatTodoTable: (todos: unknown[]) => string
  statusOf: (todo: unknown) => string
}

describe('parseTodo', () => {
  it('joins loose words into the title', () => {
    expect(parseTodo(['fix', 'the', 'parser'])).toMatchObject({
      title: 'fix the parser',
      tags: [],
    })
  })

  it('reads --notes and --priority instead of dragging them into the title', () => {
    const parsed = parseTodo([
      'ship',
      '2.1.2',
      '--tag',
      'release',
      '--status',
      'todo',
      '--priority',
      'high',
      '--notes',
      'context for the session',
    ])
    expect(parsed).toMatchObject({
      title: 'ship 2.1.2',
      tags: ['release'],
      status: 'todo',
      priority: 'high',
      notes: 'context for the session',
    })
  })
})

describe('parseTodoEdit', () => {
  it('sends only the fields the command line mentioned', () => {
    expect(parseTodoEdit(['abc', '--title', 'New name'])).toEqual({ ref: 'abc', title: 'New name' })
  })

  it('collects repeated tag flags', () => {
    expect(parseTodoEdit(['abc', '--add-tag', 'api', '--add-tag', 'ui', '--remove-tag', 'old'])).toEqual({
      ref: 'abc',
      addTags: ['api', 'ui'],
      removeTags: ['old'],
    })
  })

  it('refuses an edit that changes nothing', () => {
    expect(() => parseTodoEdit(['abc'])).toThrow(/informe o que mudar/)
  })

  it('refuses an unknown flag instead of dropping it', () => {
    expect(() => parseTodoEdit(['abc', '--colour', 'red'])).toThrow(/opcao desconhecida/)
  })

  it('requires a task reference', () => {
    expect(() => parseTodoEdit([])).toThrow(/informe a tarefa/)
  })
})

describe('statusOf', () => {
  it('reports a finished task as done whatever it stored', () => {
    expect(statusOf({ completed: true, status: 'review' })).toBe('done')
  })

  it('defaults an open task without a status to todo', () => {
    expect(statusOf({ completed: false })).toBe('todo')
    expect(statusOf({ completed: false, status: 'nonsense' })).toBe('todo')
  })
})

describe('formatTodoTable', () => {
  it('prints the short id the edit command takes', () => {
    const table = formatTodoTable([
      { id: 'abcdefgh1234', title: 'Fix the parser', tags: ['api'], status: 'in_progress' },
    ])
    expect(table).toContain('abcdefgh')
    expect(table).not.toContain('abcdefgh1')
    expect(table).toContain('in-progress')
    expect(table).toContain('#api')
  })

  it('says so when there is nothing to list', () => {
    expect(formatTodoTable([])).toBe('nenhuma tarefa\n')
  })
})
