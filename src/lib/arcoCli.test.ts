import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseTodo,
  parseTodoImplicit,
  parseTodoEdit,
  parseSession,
  formatTodoTable,
  formatTodoReceipt,
  formatTodoDetail,
  statusOf,
} = require('../../electron/cli.cjs') as {
  parseTodo: (args: string[]) => Record<string, unknown>
  parseTodoImplicit: (args: string[]) => Record<string, unknown>
  parseTodoEdit: (args: string[]) => Record<string, unknown>
  parseSession: (args: string[]) => Record<string, unknown>
  formatTodoTable: (todos: unknown[]) => string
  formatTodoReceipt: (verb: string, todo: unknown) => string
  formatTodoDetail: (todo: unknown, projectName?: string | null) => string
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

describe('parseTodoEdit with the notes flags', () => {
  it('accepts --append-notes as a separate field from --notes', () => {
    expect(parseTodoEdit(['abc', '--append-notes', 'PM respondeu.'])).toEqual({
      ref: 'abc',
      appendNotes: 'PM respondeu.',
    })
  })
})

describe('parseTodoEdit', () => {
  it('sends only the fields the command line mentioned', () => {
    expect(parseTodoEdit(['abc', '--title', 'New name'])).toEqual({ ref: 'abc', title: 'New name' })
  })

  it('collects repeated tag flags', () => {
    expect(
      parseTodoEdit(['abc', '--add-tag', 'api', '--add-tag', 'ui', '--remove-tag', 'old']),
    ).toEqual({
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

describe('parseTodoImplicit', () => {
  it('refuses a mistyped subcommand instead of creating a task named after it', () => {
    expect(() => parseTodoImplicit(['show', '2vaJ6Oop'])).toThrow(/subcomando desconhecido: show/)
    expect(() => parseTodoImplicit(['delete', 'abc'])).toThrow(/subcomando desconhecido/)
    expect(() => parseTodoImplicit(['done', 'abc'])).toThrow(/subcomando desconhecido/)
  })

  it('refuses a lone short id, which is a reference and never a title', () => {
    expect(() => parseTodoImplicit(['2vaJ6Oop'])).toThrow(/parece o id de uma tarefa/)
  })

  it('still creates a task from a plain multi-word title', () => {
    expect(parseTodoImplicit(['revisar', 'PR', '10900', '--tag', 'review'])).toMatchObject({
      title: 'revisar PR 10900',
      tags: ['review'],
    })
  })

  it('leaves a single word that reads as a title alone', () => {
    expect(parseTodoImplicit(['deploy'])).toMatchObject({ title: 'deploy' })
  })
})

describe('parseTodo', () => {
  it('refuses an unknown option instead of dragging it into the title', () => {
    expect(() => parseTodo(['tarefa', '--tagg', 'cli'])).toThrow(/opcao desconhecida: --tagg/)
  })
})

describe('formatTodoReceipt', () => {
  it('names what happened, with the id and the resulting status', () => {
    const receipt = formatTodoReceipt('criada', {
      id: 'abcdefgh1234',
      title: 'Fix the parser',
      tags: ['cli'],
      status: 'todo',
    })
    expect(receipt).toBe('criada  abcdefgh  todo  Fix the parser  #cli\n')
  })
})

describe('formatTodoDetail', () => {
  it('prints the project and the notes', () => {
    const detail = formatTodoDetail(
      {
        id: 'abcdefgh1234',
        title: 'Fix the parser',
        tags: ['cli'],
        status: 'todo',
        notes: 'primeira linha\nsegunda',
      },
      'Arco',
    )
    expect(detail).toContain('projeto')
    expect(detail).toContain('Arco')
    expect(detail).toContain('  primeira linha')
  })
})

describe('--session', () => {
  it('reads the session off an add without dragging it into the title', () => {
    expect(parseTodo(['ligar', 'card', '--session', 'current'])).toMatchObject({
      title: 'ligar card',
      session: 'current',
      force: false,
    })
  })

  it('reads the session, the release and the override on an edit', () => {
    expect(parseTodoEdit(['abc123', '--session', 'aB3', '--force'])).toEqual({
      ref: 'abc123',
      session: 'aB3',
      force: true,
    })
    expect(parseTodoEdit(['abc123', '--clear-session'])).toEqual({
      ref: 'abc123',
      clearSession: true,
    })
  })

  it('lets a session be born tied to a task', () => {
    expect(parseSession(['--todo', 'abc123', '--force'])).toMatchObject({
      todo: 'abc123',
      force: true,
    })
  })

  it('marks the tasks a session owns in the listing', () => {
    const table = formatTodoTable([
      { id: 'aaaaaaaa1', title: 'com sessao', tags: [], session: { id: 'bbbbbbbb2' } },
      { id: 'cccccccc3', title: 'sem sessao', tags: [] },
    ])
    expect(table).toContain('@bbbbbbbb')
    expect(table.split('\n')[1]).not.toContain('@')
  })

  it('names the session in the detail, and says so when there is none', () => {
    const detail = formatTodoDetail({
      id: 'aaaaaaaa1',
      title: 'com sessao',
      tags: [],
      session: { id: 'bbbbbbbb2', name: 'claude', agent: 'claude' },
    })
    expect(detail).toContain('sessao')
    expect(detail).toContain('bbbbbbbb claude (claude)')
    expect(formatTodoDetail({ id: 'x', title: 'sem', tags: [] })).toMatch(/sessao\s+-/)
  })
})
