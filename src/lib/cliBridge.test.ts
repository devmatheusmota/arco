import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliResult } from './tauri/cli'
import type { TodoAdoRef, TodoItem, TodoSessionOwner } from './types'

const handlers = new Map<string, (event: { payload: unknown }) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (received: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => handlers.delete(event))
  },
}))

const replies: Array<{ requestId: string; result: CliResult }> = []
vi.mock('./tauri/cli', () => ({
  cliReply: (requestId: string, result: CliResult) => {
    replies.push({ requestId, result })
    return Promise.resolve()
  },
}))

const toasts: string[] = []
vi.mock('../stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({ pushToast: ({ body }: { body: string }) => toasts.push(body) }),
  },
}))

const state = {
  todos: [] as TodoItem[],
  projects: [
    {
      id: 'p1',
      name: 'Arco',
      defaultCwd: '/tmp/arco',
      terminals: [] as Array<Record<string, unknown>>,
      groups: [] as Array<Record<string, unknown>>,
    },
  ],
  activeProjectId: 'p1',
  preferences: { adoOrg: '', adoProject: '' },
  createTodo: vi.fn((title: string, tags: string[], projectId?: string) => {
    const todo: TodoItem = {
      id: `id-${state.todos.length}`,
      title,
      completed: false,
      tags,
      status: 'todo',
      ...(projectId ? { projectId } : {}),
    }
    state.todos = [...state.todos, todo]
    return todo
  }),
  setTodoAdoRef: vi.fn((id: string, ref: TodoAdoRef | null) => {
    state.todos = state.todos.map((item) =>
      item.id === id ? { ...item, ...(ref ? { adoRef: ref } : {}) } : item,
    )
  }),
  setTodoSession: vi.fn((id: string, session: TodoSessionOwner | null) => {
    state.todos = state.todos.map((item) => {
      if (item.id !== id) return item
      const next = { ...item }
      if (session) next.session = session
      else delete next.session
      return next
    })
  }),
  setTodoStatus: vi.fn(),
  deleteTodo: vi.fn((id: string) => {
    state.todos = state.todos.filter((item) => item.id !== id)
  }),
  renameTodo: vi.fn(),
  renameTerminal: vi.fn(),
  closeGroupWithWorktree: vi.fn(async () => undefined),
  deleteTerminalWithWorktreeCleanup: vi.fn(async () => undefined),
  createAgentTerminal: vi.fn(async (projectId: string, args: Record<string, unknown>) => {
    const pane = {
      id: `novo-${state.projects[0].terminals.length}`,
      name: String(args.name ?? ''),
      cwd: String(args.cwd ?? ''),
      kind: 'terminal',
      shortId: 'pa-7777',
      activeTabId: 'novo-tab',
      tabs: [{ id: 'novo-tab', type: 'claude', cwd: args.cwd, ptyId: null }],
      ...(args.groupId ? { groupId: args.groupId } : {}),
    }
    state.projects[0].terminals = [...state.projects[0].terminals, pane]
    return pane
  }),
  updateTodoNotes: vi.fn(),
  appendTodoNotes: vi.fn(),
  setTodoPriority: vi.fn(),
  setTodoProject: vi.fn(),
  updateTodoTags: vi.fn(),
}

vi.mock('../stores/projectsStore', () => ({ useProjectsStore: { getState: () => state } }))

/**
 * What reached a PTY. The submit key comes back tagged with the agent it was
 * chosen for: which key each agent takes is `paneDelivery`'s own test, and this
 * one only checks that the pane's agent is what gets asked.
 */
const deliveries: Array<{ ptyId: string; text: string; submit: string }> = []
let deliveryError: Error | null = null
vi.mock('./paneDelivery', () => ({
  deliverToPty: (ptyId: string, text: string, submit: string) => {
    if (deliveryError) return Promise.reject(deliveryError)
    deliveries.push({ ptyId, text, submit })
    return Promise.resolve()
  },
  submitKeyFor: (agent: string) => `submit:${agent}`,
}))

/** PTY runtime lives outside `projects.json`, keyed by pty id, and drives `status`. */
const runtimes: Record<string, { status: string; alive: boolean; parked: boolean }> = {}
vi.mock('../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ byPtyId: runtimes }) },
}))

const { startCliBridge } = await import('./cliBridge')

/** Fires one CLI event and returns the answer the command line would receive. */
async function request(event: string, payload: Record<string, unknown>): Promise<CliResult> {
  const handler = handlers.get(event)
  if (!handler) throw new Error(`sem handler para ${event}`)
  const requestId = `req-${replies.length}`
  handler({ payload: { ...payload, requestId } })
  await vi.waitFor(() => expect(replies.at(-1)?.requestId).toBe(requestId))
  return replies.at(-1)!.result
}

/** A pane as the store holds it, which is what the CLI calls a session. */
function pane(id: string, cwd: string, name = id, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    cwd,
    kind: 'terminal',
    shortId: `pa-${String(id.length + 1000).padStart(4, '0')}`,
    activeTabId: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, type: 'claude', cwd, ptyId: id }],
    ...extra,
  }
}

beforeEach(async () => {
  state.todos = []
  state.projects[0].terminals = []
  state.projects[0].groups = []
  state.closeGroupWithWorktree.mockClear()
  state.deleteTerminalWithWorktreeCleanup.mockClear()
  state.createAgentTerminal.mockClear()
  for (const key of Object.keys(runtimes)) delete runtimes[key]
  deliveries.length = 0
  deliveryError = null
  replies.length = 0
  toasts.length = 0
  state.renameTerminal.mockClear()
  handlers.clear()
  await startCliBridge()
})

describe('cli://todo-add', () => {
  it('answers with the task it created', async () => {
    const result = await request('cli://todo-add', { title: 'revisar PR 10900', tags: ['review'] })
    expect(result.ok).toBe(true)
    expect((result.data as { todo: TodoItem }).todo.title).toBe('revisar PR 10900')
  })

  it('fails the creation when the ADO reference cannot be resolved', async () => {
    const result = await request('cli://todo-add', { title: 'x', adoRefInput: 'nao-e-uma-ref' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/não reconhecida/)
    expect(state.todos).toHaveLength(0)
  })

  it('says a bare id needs the ADO defaults instead of blaming the number', async () => {
    const result = await request('cli://todo-add', { title: 'x', adoRefInput: '22657' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/organização e o projeto do Azure DevOps/)
  })
})

describe('notes that do not fit', () => {
  it('refuses the creation instead of storing a note with its tail cut off', async () => {
    const result = await request('cli://todo-add', { title: 'x', notes: 'a'.repeat(32_001) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/limite/)
    expect(state.todos).toHaveLength(0)
  })

  it('refuses an append that would overflow, counting what is already there', async () => {
    await request('cli://todo-add', { title: 'com nota', notes: 'a'.repeat(31_000) })
    state.todos = state.todos.map((item) => ({ ...item, notes: 'a'.repeat(31_000) }))
    const result = await request('cli://todo-edit', {
      ref: 'id-0',
      appendNotes: 'b'.repeat(2_000),
    })
    expect(result.ok).toBe(false)
    expect(state.appendTodoNotes).not.toHaveBeenCalled()
  })

  it('takes a note that fits', async () => {
    const result = await request('cli://todo-add', { title: 'y', notes: 'a'.repeat(31_999) })
    expect(result.ok).toBe(true)
  })
})

describe('cli://todo-edit', () => {
  it('reports a reference that matches nothing', async () => {
    const result = await request('cli://todo-edit', { ref: 'ausente', status: 'done' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Nenhuma tarefa encontrada/)
  })

  it('links a work item URL and answers with the stored task', async () => {
    await request('cli://todo-add', { title: 'ligar card' })
    const result = await request('cli://todo-edit', {
      ref: 'id-0',
      adoRefInput: 'https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_workitems/edit/22657',
    })
    expect(result.ok).toBe(true)
    expect((result.data as { todo: TodoItem }).todo.adoRef).toMatchObject({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      workItemId: 22657,
    })
  })

  it('fails when the reference does not parse, instead of reporting a link it did not write', async () => {
    await request('cli://todo-add', { title: 'sem card' })
    const result = await request('cli://todo-edit', { ref: 'id-0', adoRefInput: 'lixo aqui' })
    expect(result.ok).toBe(false)
    expect(state.todos[0].adoRef).toBeUndefined()
  })
})

describe('cli://todo-show and cli://todo-delete', () => {
  it('shows a task with the name of its project', async () => {
    await request('cli://todo-add', { title: 'ver esta' })
    const result = await request('cli://todo-show', { ref: 'id-0' })
    expect(result.ok).toBe(true)
    expect((result.data as { projectName: string }).projectName).toBe('Arco')
  })

  it('deletes the task a reference points at', async () => {
    await request('cli://todo-add', { title: 'apagar esta' })
    const result = await request('cli://todo-delete', { ref: 'id-0' })
    expect(result.ok).toBe(true)
    expect(state.todos).toHaveLength(0)
  })

  it('refuses an ambiguous reference and names the candidates', async () => {
    await request('cli://todo-add', { title: 'revisar PR 1' })
    await request('cli://todo-add', { title: 'revisar PR 2' })
    const result = await request('cli://todo-delete', { ref: 'revisar' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/corresponde a 2 tarefas/)
    expect(state.todos).toHaveLength(2)
  })
})

describe('cli://todo-list', () => {
  it('answers from the store, so a listing never lags behind a write', async () => {
    await request('cli://todo-add', { title: 'recém-criada' })
    const result = await request('cli://todo-list', {})
    expect((result.data as { todos: TodoItem[] }).todos).toHaveLength(1)
  })
})

describe('cli://session-rename', () => {
  it('renames the pane the command ran inside, marking the name as typed', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco/wt/a', 'claude')]
    const result = await request('cli://session-rename', {
      name: 'revisao do PR 11132',
      session: 'current',
      sessionId: 'term-1',
    })
    expect(result.ok).toBe(true)
    expect(state.renameTerminal).toHaveBeenCalledWith('p1', 'term-1', 'revisao do PR 11132')
  })

  it('accepts a prefix of the session id from outside the pane', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco/wt/a', 'claude')]
    const result = await request('cli://session-rename', { name: 'nova', session: 'term-' })
    expect(result.ok).toBe(true)
    expect(state.renameTerminal).toHaveBeenCalledWith('p1', 'term-1', 'nova')
  })

  it('refuses to guess when two sessions share the tree', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco'), pane('term-2', '/tmp/arco')]
    const result = await request('cli://session-rename', {
      name: 'nova',
      session: 'current',
      sessionCwd: '/tmp/arco/src',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('--session <id>')
    expect(state.renameTerminal).not.toHaveBeenCalled()
  })

  it('says the pane is gone instead of renaming nothing', async () => {
    const result = await request('cli://session-rename', {
      name: 'nova',
      session: 'current',
      sessionId: 'term-morto',
      sessionCwd: '/tmp/arco/wt/a',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('não está aberta')
    expect(state.renameTerminal).not.toHaveBeenCalled()
  })

  it('refuses an empty name', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco/wt/a')]
    const result = await request('cli://session-rename', {
      name: '   ',
      session: 'current',
      sessionId: 'term-1',
    })
    expect(result.ok).toBe(false)
    expect(state.renameTerminal).not.toHaveBeenCalled()
  })
})

describe('--session', () => {
  it('ties a new task to the pane that declared its own id', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco/wt/a', 'claude')]
    const result = await request('cli://todo-add', {
      title: 'amarrar',
      session: 'current',
      sessionId: 'term-1',
    })
    expect(result.ok).toBe(true)
    expect(state.todos[0].session).toMatchObject({
      id: 'term-1',
      projectId: 'p1',
      agent: 'claude',
      name: 'claude',
    })
  })

  it('falls back to the directory when the pane exports nothing', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco/wt/a')]
    const result = await request('cli://todo-add', {
      title: 'pelo cwd',
      session: 'current',
      sessionCwd: '/tmp/arco/wt/a/src',
    })
    expect(result.ok).toBe(true)
    expect(state.todos[0].session?.id).toBe('term-1')
  })

  it('refuses to guess when two sessions share the tree', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/arco'), pane('term-2', '/tmp/arco')]
    const result = await request('cli://todo-add', {
      title: 'ambigua',
      session: 'current',
      sessionCwd: '/tmp/arco/src',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('--session <id>')
    expect(state.todos).toHaveLength(0)
  })

  it('says so instead of linking when there is no session here', async () => {
    const result = await request('cli://todo-add', {
      title: 'sem sessao',
      session: 'current',
      sessionCwd: '/outro/lugar',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Sem sessão do Arco')
  })

  it('keeps the link when the pane it names is already gone', async () => {
    const result = await request('cli://todo-add', {
      title: 'historico',
      session: 'current',
      sessionId: 'term-morto',
      sessionCwd: '/tmp/arco/wt/a',
    })
    expect(result.ok).toBe(true)
    expect(state.todos[0].session).toMatchObject({ id: 'term-morto', cwd: '/tmp/arco/wt/a' })
  })

  it('is idempotent and refuses a second session without --force', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/a'), pane('term-2', '/tmp/b')]
    await request('cli://todo-add', { title: 'uma', session: 'current', sessionId: 'term-1' })
    state.setTodoSession.mockClear()

    const again = await request('cli://todo-edit', {
      ref: 'id-0',
      session: 'current',
      sessionId: 'term-1',
    })
    expect(again.ok).toBe(true)
    expect(state.setTodoSession).not.toHaveBeenCalled()

    const stolen = await request('cli://todo-edit', {
      ref: 'id-0',
      session: 'current',
      sessionId: 'term-2',
    })
    expect(stolen.ok).toBe(false)
    expect(stolen.message).toContain('--force')
    expect(state.todos[0].session?.id).toBe('term-1')

    const forced = await request('cli://todo-edit', {
      ref: 'id-0',
      session: 'current',
      sessionId: 'term-2',
      force: true,
    })
    expect(forced.ok).toBe(true)
    expect(state.todos[0].session?.id).toBe('term-2')
  })

  it('releases a task with --clear-session', async () => {
    await request('cli://todo-add', { title: 'solta', session: 'current', sessionId: 'term-1' })
    const result = await request('cli://todo-edit', { ref: 'id-0', clearSession: true })
    expect(result.ok).toBe(true)
    expect(state.todos[0].session).toBeUndefined()
  })

  it('resolves an explicit pane id, and names the ones it could not find', async () => {
    state.projects[0].terminals = [pane('term-1', '/tmp/a')]
    const ok = await request('cli://todo-add', { title: 'por id', session: 'term-1' })
    expect(ok.ok).toBe(true)
    expect(state.todos[0].session?.id).toBe('term-1')

    const missing = await request('cli://todo-add', { title: 'nada', session: 'term-9' })
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('term-9')
  })

  it('lifts the session to the top level of what `todo show` answers', async () => {
    await request('cli://todo-add', { title: 'mostrar', session: 'current', sessionId: 'term-1' })
    const result = await request('cli://todo-show', { ref: 'id-0' })
    expect(result.data).toMatchObject({ sessionId: 'term-1' })
  })
})

describe('cli://session-list', () => {
  type Session = {
    ref: string
    id: string
    project: string
    name: string
    agent: string
    cwd: string
    status: string
    parked: boolean
    todo?: string
    worktree?: string
  }

  const list = async (): Promise<Session[]> => {
    const result = await request('cli://session-list', {})
    expect(result.ok).toBe(true)
    return (result.data as { sessions: Session[] }).sessions
  }

  it('answers with the reference the other commands take, and the pane behind it', async () => {
    state.projects[0].terminals = [pane('sessao-a', '/tmp/arco', 'mesa')]
    runtimes['sessao-a'] = { status: 'working', alive: true, parked: false }

    expect(await list()).toEqual([
      {
        ref: 'pa-1008',
        id: 'sessao-a',
        project: 'Arco',
        projectId: 'p1',
        name: 'mesa',
        agent: 'claude',
        cwd: '/tmp/arco',
        status: 'working',
        parked: false,
        pinned: false,
        current: false,
      },
    ])
  })

  // A pane that has not been opened since the app started has no PTY at all,
  // which is the normal state of most of the list — not an error.
  it('calls a pane with no live runtime offline instead of guessing', async () => {
    state.projects[0].terminals = [pane('sem-pty', '/tmp/arco')]

    expect((await list())[0].status).toBe('offline')
  })

  it('reports a released runtime as parked without hiding its status', async () => {
    state.projects[0].terminals = [pane('dormindo', '/tmp/arco')]
    runtimes['dormindo'] = { status: 'waiting', alive: true, parked: true }

    const [session] = await list()
    expect(session).toMatchObject({ status: 'waiting', parked: true })
  })

  it('leaves out the panes that are not sessions', async () => {
    state.projects[0].terminals = [
      pane('terminal', '/tmp/arco'),
      { ...pane('nota', '/tmp/arco'), kind: 'markdown', tabs: [] },
      { ...pane('site', '/tmp/arco'), kind: 'web', tabs: [] },
    ]

    expect((await list()).map((session) => session.id)).toEqual(['terminal'])
  })

  it('names the task a session is working on and the worktree it lives in', async () => {
    state.projects[0].terminals = [
      pane('com-tudo', '/tmp/wt', 'isolada', { worktreeAgentId: 'cl-a1b2c3' }),
    ]
    await request('cli://todo-add', { title: 'revisar PR' })
    state.todos = state.todos.map((todo) => ({
      ...todo,
      session: { id: 'com-tudo', linkedAt: 1 },
    }))

    expect((await list())[0]).toMatchObject({ todo: 'id-0', worktree: 'cl-a1b2c3' })
  })

  it('answers with an empty list rather than an error when nothing is open', async () => {
    expect(await list()).toEqual([])
  })
})

describe('cli://session-send', () => {
  const send = (payload: Record<string, unknown>) => request('cli://session-send', payload)

  beforeEach(() => {
    state.projects[0].terminals = [pane('alvo', '/tmp/arco', 'mesa')]
    runtimes['alvo'] = { status: 'waiting', alive: true, parked: false }
  })

  it('takes the short reference, in every form a person writes it', async () => {
    for (const target of ['pa-1004', 'PA-1004', '1004']) {
      const result = await send({ target, text: `oi via ${target}` })
      expect(result.ok).toBe(true)
    }
    expect(deliveries.map((item) => item.text)).toEqual([
      'oi via pa-1004',
      'oi via PA-1004',
      'oi via 1004',
    ])
  })

  it('still takes the pane id, so a reference-shaped miss does not hide it', async () => {
    const result = await send({ target: 'alvo', text: 'oi' })

    expect(result.ok).toBe(true)
    expect(deliveries).toHaveLength(1)
  })

  it('names the reference when nothing answers to it, instead of calling it an id', async () => {
    const result = await send({ target: 'pa-9999', text: 'oi' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/referência pa-9999/)
    expect(deliveries).toEqual([])
  })

  // Written inside the request: the answer reports what happened, not a promise
  // about later that a reload of the window could break.
  it('writes into the pane PTY before answering', async () => {
    const result = await send({ target: 'pa-1004', text: 'roda os testes' })

    expect(deliveries).toEqual([{ ptyId: 'alvo', text: 'roda os testes', submit: 'submit:claude' }])
    expect(result.ok).toBe(true)
    expect(result.message).toBe('pa-1004: entregue.')
    expect(result.data).toEqual({ sessionId: 'alvo', ref: 'pa-1004', status: 'waiting' })
  })

  // The agent's own queue holds what arrives mid-turn, so a busy agent is not a
  // reason to wait — only a reason to say when it will be read.
  it('delivers to a working agent at once, and says when it will be read', async () => {
    runtimes['alvo'] = { status: 'working', alive: true, parked: false }

    const result = await send({ target: 'pa-1004', text: 'depois disso' })

    expect(deliveries).toHaveLength(1)
    expect(result.message).toMatch(/entregue\. O agente está trabalhando/)
  })

  it('asks for the submit key of the agent the pane is running', async () => {
    state.projects[0].terminals = [
      pane('alvo', '/tmp/arco', 'mesa', {
        tabs: [{ id: 'alvo-tab', type: 'codex', cwd: '/tmp/arco', ptyId: 'alvo' }],
      }),
    ]

    await send({ target: 'pa-1004', text: 'revisa isso' })

    expect(deliveries[0].submit).toBe('submit:codex')
  })

  it('warns that a shell pane runs the text as soon as it lands', async () => {
    state.projects[0].terminals = [
      pane('alvo', '/tmp/arco', 'mesa', {
        tabs: [{ id: 'alvo-tab', type: 'shell', cwd: '/tmp/arco', ptyId: 'alvo' }],
      }),
    ]

    const result = await send({ target: 'pa-1004', text: 'npm test' })

    expect(deliveries).toHaveLength(1)
    expect(result.message).toMatch(/entregue ao shell, que executa na hora/)
  })

  // Nothing in the window lasts long enough to promise a delivery for later.
  it('refuses a pane whose process is not up', async () => {
    delete runtimes['alvo']

    const result = await send({ target: 'pa-1004', text: 'quando abrir' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/O pane pa-1004 não está rodando\. Abra-o no app/)
    expect(deliveries).toEqual([])
  })

  it('refuses a pane that has not spawned its process at all', async () => {
    state.projects[0].terminals = [
      pane('alvo', '/tmp/arco', 'mesa', {
        tabs: [{ id: 'alvo-tab', type: 'claude', cwd: '/tmp/arco', ptyId: null }],
      }),
    ]

    const result = await send({ target: 'pa-1004', text: 'oi' })

    expect(result.ok).toBe(false)
    expect(deliveries).toEqual([])
  })

  it('refuses a parked pane and says why it is down', async () => {
    runtimes['alvo'] = { status: 'waiting', alive: true, parked: true }

    const result = await send({ target: 'pa-1004', text: 'oi' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/foi estacionado para liberar memória/)
    expect(deliveries).toEqual([])
  })

  it('answers with the failure when the write itself fails', async () => {
    deliveryError = new Error('pty morto')

    const result = await send({ target: 'pa-1004', text: 'oi' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Não consegui escrever no pane pa-1004: Error: pty morto/)
  })

  it('refuses a disabled pane instead of writing to something switched off', async () => {
    state.projects[0].terminals = [{ ...pane('alvo', '/tmp/arco'), disabled: true }]

    const result = await send({ target: 'pa-1004', text: 'oi' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/desativado/)
    expect(deliveries).toEqual([])
  })

  it('refuses an empty message and a call with no target', async () => {
    expect((await send({ target: 'pa-1004', text: '   ' })).ok).toBe(false)
    expect((await send({ text: 'oi' })).ok).toBe(false)
    expect(deliveries).toEqual([])
  })

  it('resolves current from the pane the command ran in', async () => {
    const result = await send({ target: 'current', sessionId: 'alvo', text: 'para mim mesmo' })

    expect(result.ok).toBe(true)
    expect(deliveries).toHaveLength(1)
  })

  it('reports a current that points at a pane this profile does not have', async () => {
    const result = await send({ target: 'current', sessionId: 'outro-perfil', text: 'oi' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/não está aberta neste perfil/)
  })
})

describe('the line that says where a message came from', () => {
  const send = (payload: Record<string, unknown>) => request('cli://session-send', payload)

  beforeEach(() => {
    state.projects[0].terminals = [
      pane('alvo', '/tmp/arco', 'mesa'),
      pane('remetente', '/tmp/arco'),
    ]
    runtimes['alvo'] = { status: 'waiting', alive: true, parked: false }
  })

  // Text arriving bare reads like something the user typed: the agent answers
  // into its own pane and the reply goes nowhere. The header names the sender
  // and the exact command that reaches it back.
  it('names the sender, and how to answer it', async () => {
    await send({ target: 'pa-1004', text: 'roda os testes', sessionId: 'remetente' })

    expect(deliveries[0].text).toBe(
      '[de pa-1009 · responda com: arco session send pa-1009 <texto>] roda os testes',
    )
  })

  // A header glued to the first line of a block reads as part of it.
  it('keeps its own line when the text has more than one', async () => {
    await send({ target: 'pa-1004', text: 'primeira\nsegunda', sessionId: 'remetente' })

    expect(deliveries[0].text).toBe(
      '[de pa-1009 · responda com: arco session send pa-1009 <texto>]\nprimeira\nsegunda',
    )
  })

  // `--raw` exists for text that is a command the receiving side will run: a
  // prefix in front of it changes what gets executed.
  it('delivers the text alone when asked for raw', async () => {
    await send({ target: 'pa-1004', text: '/compact', sessionId: 'remetente', raw: true })

    expect(deliveries[0].text).toBe('/compact')
  })

  // Called from a plain shell there is no pane to answer, so a header would
  // promise a reply address that does not exist.
  it('says nothing when the sender is not a pane of this workspace', async () => {
    await send({ target: 'pa-1004', text: 'de fora' })
    await send({ target: 'pa-1004', text: 'de um pane fechado', sessionId: 'sumiu' })

    expect(deliveries.map((item) => item.text)).toEqual(['de fora', 'de um pane fechado'])
  })
})

describe('cli://session-close', () => {
  const close = (payload: Record<string, unknown>) => request('cli://session-close', payload)

  beforeEach(() => {
    state.projects[0].terminals = [
      pane('orq', '/tmp/arco', 'orquestrador', { pinned: true }),
      pane('outro', '/tmp/arco'),
      pane('proprio', '/tmp/arco'),
    ]
  })

  // The whole point: one pane goes, the front and its other panes stay.
  it('closes the pane it was given and says the front stays', async () => {
    const result = await close({ target: 'pa-1005' })

    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/A frente segue aberta/)
    expect(state.deleteTerminalWithWorktreeCleanup).toHaveBeenCalledWith('p1', 'outro', {
      assumeConfirmed: undefined,
    })
  })

  // The orchestrator is the front's own pane: `deleteTerminal` refuses it, and a
  // silent no-op would read like a bug in the command.
  it('refuses the orchestrator, and names the command that does close it', async () => {
    const result = await close({ target: 'pa-1003' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/arco group close/)
    expect(state.deleteTerminalWithWorktreeCleanup).not.toHaveBeenCalled()
  })

  // Closing the caller kills the process still waiting to print the answer.
  it('refuses to close the pane the command is running in', async () => {
    const result = await close({ target: 'pa-1007', sessionId: 'proprio' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/é este pane/)
    expect(state.deleteTerminalWithWorktreeCleanup).not.toHaveBeenCalled()
  })

  // Removal runs `git worktree remove --force`. The window would ask, but
  // `window.confirm` blocks the renderer with nobody there to answer it, so the
  // question goes back to the terminal.
  it('refuses a pane that owns a worktree until --yes says so', async () => {
    state.projects[0].terminals = [
      pane('isolado', '/tmp/wt', 'isolado', { worktreeAgentId: 'cl-9' }),
    ]

    const refused = await close({ target: 'pa-1007' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/--yes/)
    expect(state.deleteTerminalWithWorktreeCleanup).not.toHaveBeenCalled()

    const done = await close({ target: 'pa-1007', confirmed: true })
    expect(done.ok).toBe(true)
    expect(done.message).toMatch(/worktree cl-9/)
    expect(state.deleteTerminalWithWorktreeCleanup).toHaveBeenCalledWith('p1', 'isolado', {
      assumeConfirmed: true,
    })
  })

  it('names the reference when nothing answers to it', async () => {
    const result = await close({ target: 'pa-9999' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/referência pa-9999/)
  })
})

describe('cli://group-list and cli://group-close', () => {
  const front = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    createdAt: 1,
    ...extra,
  })

  beforeEach(() => {
    state.projects[0].groups = [
      front('g-wt', 'cpf opcional', { worktreeAgentId: 'cl-1', cwd: '/wt/1' }),
      front('g-plain', 'Arco'),
    ]
    state.projects[0].terminals = [
      { ...pane('orq', '/wt/1', 'Claude Code'), groupId: 'g-wt', pinned: true },
      { ...pane('lado', '/wt/1', 'testes'), groupId: 'g-wt' },
      { ...pane('solto', '/tmp/arco', 'shell'), groupId: 'g-plain' },
    ]
  })

  it('lists each front with the references its sessions answer to', async () => {
    const result = await request('cli://group-list', {})
    const groups = (result.data as { groups: Array<Record<string, unknown>> }).groups

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      name: 'cpf opcional',
      project: 'Arco',
      panes: 2,
      worktree: 'cl-1',
    })
    expect(groups[0].refs).toEqual(['pa-1003', 'pa-1004'])
    expect(groups[1]).toMatchObject({ name: 'Arco', panes: 1 })
    expect(groups[1].worktree).toBeUndefined()
  })

  // A group id is a nanoid nobody reads; the reference is the id a person has.
  it('closes the front a session belongs to, named by that session', async () => {
    const result = await request('cli://group-close', { target: 'pa-1004' })

    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/cpf opcional/)
    expect(result.message).toMatch(/cl-1/)
    expect(result.data).toMatchObject({ groupId: 'g-wt', panes: 2 })
  })

  it('says nothing leaves the disk for a front with no worktree', async () => {
    const result = await request('cli://group-close', { target: 'pa-1005' })

    expect(result.message).toMatch(/Nada sai do disco/)
  })

  it('refuses a reference that answers to nothing', async () => {
    const result = await request('cli://group-close', { target: 'pa-9999' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/referência pa-9999/)
  })

  it('refuses a session that is in no front at all', async () => {
    state.projects[0].terminals = [pane('orfao', '/tmp/arco')]

    const result = await request('cli://group-close', { target: 'pa-1005' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/não está em nenhuma frente/)
  })

  it('reports the front each session belongs to in the session listing', async () => {
    const result = await request('cli://session-list', {})
    const sessions = (result.data as { sessions: Array<Record<string, unknown>> }).sessions

    expect(sessions.map((s) => s.group)).toEqual(['cpf opcional', 'cpf opcional', 'Arco'])
    expect(sessions.map((s) => s.pinned)).toEqual([true, false, false])
  })
})

describe('cli://session-new lands in a front of work', () => {
  beforeEach(() => {
    state.projects[0].groups = [
      { id: 'g-wt', name: 'cpf opcional', createdAt: 1, worktreeAgentId: 'cl-1', cwd: '/wt/1' },
      { id: 'g-plain', name: 'Arco', createdAt: 1 },
    ]
    state.projects[0].terminals = [
      { ...pane('orq', '/wt/1', 'Claude Code'), groupId: 'g-wt', pinned: true },
      { ...pane('solto', '/tmp/arco', 'shell'), groupId: 'g-plain' },
    ]
  })

  const created = () => state.createAgentTerminal.mock.calls.at(-1)?.[1]

  // Asking for a session from inside a pane means asking for one *here*. A
  // session that lands outside the front shows up as a loose tab beside the
  // fronts instead of beside its siblings.
  it('inherits the front of the pane the command was run in', async () => {
    const result = await request('cli://session-new', { agent: 'claude', sessionId: 'orq' })

    expect(result.ok).toBe(true)
    expect(created()).toMatchObject({ groupId: 'g-wt' })
    expect(result.message).toMatch(/frente "cpf opcional"/)
  })

  // A second session in a front with a worktree shares it; one with a checkout
  // of its own would not be in the same piece of work at all.
  it('shares the front worktree instead of provisioning another', async () => {
    await request('cli://session-new', { agent: 'claude', sessionId: 'orq', worktree: 'new' })

    expect(created()).toMatchObject({ worktree: 'none', cwd: '/wt/1' })
  })

  it('still isolates when the front has no worktree of its own', async () => {
    await request('cli://session-new', { agent: 'claude', sessionId: 'solto', worktree: 'new' })

    expect(created()).toMatchObject({ groupId: 'g-plain', worktree: 'new' })
  })

  it('takes another front by name', async () => {
    await request('cli://session-new', {
      agent: 'claude',
      sessionId: 'solto',
      group: 'cpf opcional',
    })

    expect(created()).toMatchObject({ groupId: 'g-wt' })
  })

  it('takes another front by the reference of a session in it', async () => {
    await request('cli://session-new', { agent: 'claude', sessionId: 'solto', group: 'pa-1003' })

    expect(created()).toMatchObject({ groupId: 'g-wt' })
  })

  it('leaves the session without a front when there is no pane to inherit from', async () => {
    const result = await request('cli://session-new', { agent: 'claude', cwd: '/nowhere' })

    expect(result.ok).toBe(true)
    expect(created()?.groupId).toBeUndefined()
  })
})

describe('the worktree a session reports', () => {
  beforeEach(() => {
    state.projects[0].groups = [
      { id: 'g-wt', name: 'cpf opcional', createdAt: 1, worktreeAgentId: 'cl-1', cwd: '/wt/1' },
    ]
  })

  const worktreeOf = async () => {
    const result = await request('cli://session-list', {})
    return (result.data as { sessions: Array<{ worktree?: string }> }).sessions[0].worktree
  }

  // A session opened inside a front runs in its worktree without owning it.
  // Reporting only what the pane owns makes it read as loose when it is not.
  it('names the front worktree for a session that does not own one', async () => {
    state.projects[0].terminals = [{ ...pane('dentro', '/wt/1'), groupId: 'g-wt' }]

    expect(await worktreeOf()).toBe('cl-1')
  })

  it('prefers the one the pane owns when it has one', async () => {
    state.projects[0].terminals = [
      { ...pane('dono', '/wt/9'), groupId: 'g-wt', worktreeAgentId: 'cl-9' },
    ]

    expect(await worktreeOf()).toBe('cl-9')
  })

  it('reports none for a session on the project tree', async () => {
    state.projects[0].terminals = [pane('solto', '/tmp/arco')]

    expect(await worktreeOf()).toBeUndefined()
  })
})

describe('a session opened by an older arco binary', () => {
  // The `arco` on PATH is whatever build is installed. 2.16.2 sends no session
  // scope at all, so inheriting the front cannot depend on it — which is how a
  // pane asked for from inside a front still came back as a loose tab.
  beforeEach(() => {
    state.projects[0].groups = [
      {
        id: 'g-wt',
        name: 'cpf opcional',
        createdAt: 1,
        worktreeAgentId: 'cl-1',
        cwd: '/repo/.arco/worktrees/cl-1',
      },
      { id: 'g-plain', name: 'Arco', createdAt: 1 },
    ]
    state.projects[0].terminals = [
      { ...pane('orq', '/repo/.arco/worktrees/cl-1'), groupId: 'g-wt' },
      { ...pane('raiz', '/repo'), groupId: 'g-plain' },
    ]
  })

  const created = () => state.createAgentTerminal.mock.calls.at(-1)?.[1]

  it('falls back to the working directory the old binary does send', async () => {
    await request('cli://session-new', { agent: 'claude', cwd: '/repo/.arco/worktrees/cl-1' })

    expect(created()).toMatchObject({ groupId: 'g-wt' })
  })

  it('matches a directory below the worktree too', async () => {
    await request('cli://session-new', { agent: 'claude', cwd: '/repo/.arco/worktrees/cl-1/src' })

    expect(created()).toMatchObject({ groupId: 'g-wt' })
  })

  // The worktree lives under the project root, so a prefix match against the
  // root would claim every isolated session for the project's own front.
  it('does not let the project root claim a session inside a worktree', async () => {
    await request('cli://session-new', { agent: 'claude', cwd: '/repo/.arco/worktrees/cl-1' })

    expect(created()?.groupId).not.toBe('g-plain')
  })

  it('still finds the front of a pane that has no worktree', async () => {
    await request('cli://session-new', { agent: 'claude', cwd: '/repo' })

    expect(created()).toMatchObject({ groupId: 'g-plain' })
  })

  it('leaves it without a front when the directory belongs to none', async () => {
    await request('cli://session-new', { agent: 'claude', cwd: '/outro/lugar' })

    expect(created()?.groupId).toBeUndefined()
  })
})

describe('which project a session belongs to', () => {
  // These replace the whole project list, so it goes back afterwards or every
  // test declared later runs against the wrong workspace.
  const original = state.projects
  const twoProjects = () => {
    state.projects = [
      { id: 'home', name: 'mota', defaultCwd: '/home/mota', terminals: [], groups: [] },
      {
        id: 'soa',
        name: 'SOA',
        defaultCwd: '/home/mota/projetos/emr/SOA',
        terminals: [],
        groups: [],
      },
    ] as never
  }
  afterEach(() => {
    state.projects = original
  })

  // A project rooted at the home directory is a prefix of every other one.
  // Taking the first match hands it every session opened anywhere below it —
  // which is how a pane asked for inside a SOA worktree landed in "mota".
  it('picks the deepest root, not the first that matches', async () => {
    twoProjects()

    await request('cli://session-new', {
      agent: 'claude',
      cwd: '/home/mota/projetos/emr/SOA/.arco/worktrees/cl-1',
    })

    expect(state.createAgentTerminal.mock.calls.at(-1)?.[0]).toBe('soa')
  })

  it('still falls back to the home project for a directory only it covers', async () => {
    twoProjects()

    await request('cli://session-new', { agent: 'claude', cwd: '/home/mota/documentos' })

    expect(state.createAgentTerminal.mock.calls.at(-1)?.[0]).toBe('home')
  })
})

describe('a reference that names a pane, typed where a task was expected', () => {
  // Told "send this to pa-2825", an agent reaches for the reference it knows:
  // the task one. "No task found" sends it grepping the filesystem for what the
  // reference means — which is what it actually did.
  beforeEach(() => {
    state.projects[0].terminals = [pane('alvo', '/tmp/arco', 'mesa')]
  })

  it('says it is a pane and gives the command that sends to one', async () => {
    const result = await request('cli://todo-show', { ref: 'pa-1004' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/é um pane, não uma tarefa/)
    expect(result.message).toMatch(/arco session send pa-1004/)
  })

  it('points at the listing when no pane answers to it either', async () => {
    const result = await request('cli://todo-show', { ref: 'pa-9999' })

    expect(result.message).toMatch(/arco session list/)
    expect(result.message).not.toMatch(/é um pane, não uma tarefa/)
  })

  it('leaves an ordinary task reference alone', async () => {
    await request('cli://todo-add', { title: 'uma tarefa' })

    const result = await request('cli://todo-show', { ref: 'id-0' })
    expect(result.ok).toBe(true)
  })

  it('still reports a plain miss as a plain miss', async () => {
    const result = await request('cli://todo-show', { ref: 'abacaxi' })

    expect(result.message).toMatch(/Nenhuma tarefa encontrada/)
  })

  // A reference is bare digits far more often than it is a pane: a PR number,
  // an issue, a piece of a title. `arco todo edit 11299 --ado …` was refused
  // with "pa-11299 looks like a pane reference" while the task was right there.
  it('finds the task first when the reference is bare digits', async () => {
    await request('cli://todo-add', { title: '[MEU PR] publicar 11299 prova impressa' })

    const result = await request('cli://todo-show', { ref: '11299' })

    expect(result.ok).toBe(true)
    expect(result.message ?? JSON.stringify(result.data)).toMatch(/11299/)
  })

  // Only the written prefix says "I meant a pane"; bare digits that match no
  // pane are a reference that missed, and saying otherwise hides the real miss.
  it('calls bare digits that match nothing a plain miss, not a pane', async () => {
    const result = await request('cli://todo-show', { ref: '4321' })

    expect(result.message).toMatch(/Nenhuma tarefa encontrada/)
    expect(result.message).not.toMatch(/pane/)
  })

  // The pane wins over nothing, though: an open pane answering to those digits
  // is still the likeliest thing the agent meant.
  it('still names the pane when one answers to the bare digits', async () => {
    const result = await request('cli://todo-show', { ref: '1004' })

    expect(result.message).toMatch(/é um pane, não uma tarefa/)
  })
})

describe('finding yourself in the listing', () => {
  // An agent exports its own id; without the listing saying which row that is,
  // it cannot tell itself apart from the panes it is supposed to talk to.
  it('marks the session the command was run from', async () => {
    state.projects[0].terminals = [pane('eu', '/tmp/arco'), pane('outro', '/tmp/arco')]

    const result = await request('cli://session-list', { sessionId: 'eu' })
    const sessions = (result.data as { sessions: Array<{ id: string; current: boolean }> }).sessions

    expect(sessions.find((s) => s.id === 'eu')?.current).toBe(true)
    expect(sessions.find((s) => s.id === 'outro')?.current).toBe(false)
  })

  it('marks nobody when the command came from outside a pane', async () => {
    state.projects[0].terminals = [pane('eu', '/tmp/arco')]

    const result = await request('cli://session-list', {})
    const sessions = (result.data as { sessions: Array<{ current: boolean }> }).sessions

    expect(sessions.every((s) => !s.current)).toBe(true)
  })
})
