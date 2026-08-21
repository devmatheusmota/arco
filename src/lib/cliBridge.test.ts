import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    },
  ],
  activeProjectId: 'p1',
  preferences: { adoOrg: '', adoProject: '', adoPat: '' },
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
  setTodoWatch: vi.fn(),
  deleteTodo: vi.fn((id: string) => {
    state.todos = state.todos.filter((item) => item.id !== id)
  }),
  renameTodo: vi.fn(),
  updateTodoNotes: vi.fn(),
  appendTodoNotes: vi.fn(),
  setTodoPriority: vi.fn(),
  setTodoProject: vi.fn(),
  updateTodoTags: vi.fn(),
}

vi.mock('../stores/projectsStore', () => ({ useProjectsStore: { getState: () => state } }))

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
function pane(id: string, cwd: string, name = id) {
  return {
    id,
    name,
    cwd,
    kind: 'terminal',
    activeTabId: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, type: 'claude', cwd, ptyId: id }],
  }
}

beforeEach(async () => {
  state.todos = []
  state.projects[0].terminals = []
  replies.length = 0
  toasts.length = 0
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
