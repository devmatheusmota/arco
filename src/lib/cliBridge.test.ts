import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliResult } from './tauri/cli'
import type { TodoAdoRef, TodoItem } from './types'

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
  useUiStore: { getState: () => ({ pushToast: ({ body }: { body: string }) => toasts.push(body) }) },
}))

const state = {
  todos: [] as TodoItem[],
  projects: [{ id: 'p1', name: 'Arco', defaultCwd: '/tmp/arco' }],
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

beforeEach(async () => {
  state.todos = []
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
