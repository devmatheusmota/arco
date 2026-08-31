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
  handlesCli,
  manifestCandidates,
  mistypedFlag,
} = require('../../electron/cli.cjs') as {
  parseTodo: (args: string[]) => Record<string, unknown>
  parseTodoImplicit: (args: string[]) => Record<string, unknown>
  parseTodoEdit: (args: string[]) => Record<string, unknown>
  parseSession: (args: string[]) => Record<string, unknown>
  formatTodoTable: (todos: unknown[]) => string
  formatTodoReceipt: (verb: string, todo: unknown) => string
  formatTodoDetail: (todo: unknown, projectName?: string | null) => string
  statusOf: (todo: unknown) => string
  handlesCli: (argv: string[]) => boolean
  manifestCandidates: (dir: string) => string[]
  mistypedFlag: (argv: string[]) => string | null
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

describe('handlesCli', () => {
  // `main.cjs` reads this answer before Electron reaches the display, and a
  // claimed argv is re-run as a plain Node process instead. Anything missing
  // from this list boots the window layer to answer a question that draws
  // nothing — which prints libX11's authorization warning over the command's
  // own output, or kills it outright where there is no display at all.
  it('claims every subcommand the binary answers by itself', () => {
    for (const argv of [
      ['/opt/Arco/arco', 'todo', 'list'],
      ['/opt/Arco/arco', 'session', '--agent', 'claude'],
      ['/opt/Arco/arco', '--version'],
      ['/opt/Arco/arco', '-v'],
      ['/opt/Arco/arco', 'version'],
      ['/opt/Arco/arco', 'help'],
      ['/opt/Arco/arco', '--help'],
      ['/opt/Arco/arco', '-h'],
      ['electron', '.', 'todo', 'show', 'abc'],
    ]) {
      expect(handlesCli(argv), argv.join(' ')).toBe(true)
    }
  })

  it('leaves the launches that open a window to the app', () => {
    for (const argv of [
      ['/opt/Arco/arco'],
      ['/opt/Arco/arco', '.'],
      ['/opt/Arco/arco', '/home/mota/projetos'],
      ['/opt/Arco/arco', '--no-sandbox', '/tmp'],
    ]) {
      expect(handlesCli(argv), argv.join(' ')).toBe(false)
    }
  })
})

describe('manifestCandidates', () => {
  // `arco --version` answered "desconhecida" about itself in 2.13.5: run as
  // plain Node there is no `app` to ask, and the only path tried was the
  // unpacked directory, which carries the electron/ files and no manifest.
  it('also looks inside the archive when running from the unpacked directory', () => {
    expect(manifestCandidates('/opt/Arco/resources/app.asar.unpacked/electron')).toEqual([
      '/opt/Arco/resources/app.asar.unpacked/package.json',
      '/opt/Arco/resources/app.asar/package.json',
    ])
  })

  it('offers the one path there is when nothing is packed', () => {
    expect(manifestCandidates('/home/mota/projetos/apps/arco/electron')).toEqual([
      '/home/mota/projetos/apps/arco/package.json',
    ])
  })
})

describe('mistypedFlag', () => {
  // `arco --hlep` exited 0 having done nothing, after starting the window layer
  // to look for a directory named after the typo — which is where libX11's
  // authorization warning came from. Naming the flag never touches a display.
  it('names a flag the CLI does not know', () => {
    expect(mistypedFlag(['/opt/Arco/arco', '--hlep'])).toBe('--hlep')
    expect(mistypedFlag(['/opt/Arco/arco', '-x'])).toBe('-x')
  })

  it('leaves the flags the CLI does know', () => {
    expect(mistypedFlag(['/opt/Arco/arco', '--help'])).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', '-v'])).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', '--open-path', '/tmp'])).toBeNull()
  })

  // Chromium's switch surface is too large to list, so they pass by shape. The
  // two `npm run app` sends must never read as a typo.
  it("lets Chromium's own switches through", () => {
    expect(
      mistypedFlag(['electron', '--no-sandbox', '--disable-gpu-sandbox', 'electron/main.cjs']),
    ).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', '--ozone-platform=wayland'])).toBeNull()
  })

  // The boot smoke caught this: `todo list --json` read as a typo on `--json`
  // and exited 2. A subcommand owns its own options and refuses the ones it
  // does not know itself, naming the command they belong to.
  it("leaves a subcommand's own options to the subcommand", () => {
    expect(mistypedFlag(['/opt/Arco/arco', 'todo', 'list', '--json'])).toBeNull()
    expect(
      mistypedFlag(['electron', 'electron/main.cjs', '--no-sandbox', 'todo', 'list', '--json']),
    ).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', 'session', '--agent', 'claude'])).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', 'todo', 'add', 'x', '--taag', 'y'])).toBeNull()
  })

  it('stays out of the way when there is a directory to open', () => {
    expect(mistypedFlag(['/opt/Arco/arco'])).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', '/tmp'])).toBeNull()
    expect(mistypedFlag(['/opt/Arco/arco', '--hlep', '/tmp'])).toBeNull()
  })
})
