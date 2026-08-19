import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseTodo,
  parseTodoImplicit,
  parseTodoEdit,
  formatTodoTable,
  formatTodoReceipt,
  formatTodoDetail,
  statusOf,
} = require('../../electron/cli.cjs') as {
  parseTodo: (args: string[]) => Record<string, unknown>
  parseTodoImplicit: (args: string[]) => Record<string, unknown>
  parseTodoEdit: (args: string[]) => Record<string, unknown>
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

  it('reads --watch as a flag and keeps the word out of the title', () => {
    expect(parseTodo(['revisar', 'PR', '10893', '--watch'])).toMatchObject({
      title: 'revisar PR 10893',
      watch: true,
    })
  })

  it('omits watch entirely when neither flag appears', () => {
    expect(parseTodo(['revisar', 'PR'])).not.toHaveProperty('watch')
  })

  it('captures --ado as a raw string, leaving parsing to the app side', () => {
    const parsed = parseTodo([
      '22447',
      'habilitar',
      'simulado',
      '--ado',
      'https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_workitems/edit/22447',
    ])
    expect(parsed).toMatchObject({
      title: '22447 habilitar simulado',
      adoRefInput: 'https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_workitems/edit/22447',
    })
  })
})

describe('parseTodoEdit with the ADO flags', () => {
  it('carries --ado through as adoRefInput', () => {
    expect(parseTodoEdit(['abc', '--ado', '#22447'])).toMatchObject({
      ref: 'abc',
      adoRefInput: '#22447',
    })
  })

  it('carries --clear-ado through as a boolean', () => {
    expect(parseTodoEdit(['abc', '--clear-ado'])).toEqual({ ref: 'abc', clearAdoRef: true })
  })

  it('accepts --append-notes as a separate field from --notes', () => {
    expect(parseTodoEdit(['abc', '--append-notes', 'PM respondeu.'])).toEqual({
      ref: 'abc',
      appendNotes: 'PM respondeu.',
    })
  })

  it('turns the watcher on and off as a boolean, never as a title word', () => {
    expect(parseTodoEdit(['abc', '--watch'])).toEqual({ ref: 'abc', watch: true })
    expect(parseTodoEdit(['abc', '--no-watch'])).toEqual({ ref: 'abc', watch: false })
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
    expect(() => parseTodo(['tarefa', '--adoo', '22657'])).toThrow(/opcao desconhecida: --adoo/)
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
  it('prints the linked card and the notes', () => {
    const detail = formatTodoDetail(
      {
        id: 'abcdefgh1234',
        title: 'Fix the parser',
        tags: ['cli'],
        status: 'todo',
        notes: 'primeira linha\nsegunda',
        adoRef: { org: 'EuMedicoResidente', project: 'Plataforma EMR', workItemId: 22657 },
      },
      'Arco',
    )
    expect(detail).toContain('EuMedicoResidente/Plataforma EMR#22657')
    expect(detail).toContain('projeto')
    expect(detail).toContain('Arco')
    expect(detail).toContain('  primeira linha')
  })

  it('shows a pull request alongside the work item', () => {
    const detail = formatTodoDetail({
      id: 'abcdefgh1234',
      title: 'PR',
      tags: [],
      adoRef: {
        org: 'EuMedicoResidente',
        project: 'SOA',
        workItemId: 22674,
        prId: 10900,
        repository: 'SOA',
      },
    })
    expect(detail).toContain('!10900')
    expect(detail).toContain('(SOA)')
  })
})
