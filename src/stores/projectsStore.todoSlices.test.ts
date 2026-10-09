import { beforeEach, describe, expect, it, vi } from 'vitest'

const appendTodoEvents = vi.fn(async (_events: unknown[]) => undefined)

vi.mock('../lib/tauri', () => ({
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(async () => null),
  saveProjectsFile: vi.fn(async () => undefined),
  recordAppEvent: vi.fn(async () => undefined),
  recordFrontendError: vi.fn(async () => undefined),
  appendTodoEvents: (events: unknown[]) => appendTodoEvents(events),
}))

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { useProjectsStore } from './projectsStore'

const store = () => useProjectsStore.getState()
const todo = (id: string) => store().todos.find((item) => item.id === id)!
const recorded = () => appendTodoEvents.mock.calls.map(([events]) => events).flat()

beforeEach(() => {
  useProjectsStore.setState({ todos: [] })
  appendTodoEvents.mockClear()
})

describe('task kinds in the store', () => {
  it('starts a task in its kind’s first stage and records the creation', () => {
    const created = store().createTodo('[REVIEW] PR 1', [], undefined, { kind: 'review' })!
    expect(todo(created.id)).toMatchObject({ kind: 'review', status: 'review_pending' })
    expect(recorded()).toEqual([
      expect.objectContaining({ id: created.id, from: null, to: 'review_pending', source: 'ui' }),
    ])
  })

  it('reads the old words against the kind and ignores a stage of another kind', () => {
    const { id } = store().createTodo('[TASK] x', [], undefined, { kind: 'task' })!
    store().setTodoStatus(id, 'in_progress', 'cli')
    expect(todo(id).status).toBe('task_in_progress')
    store().setTodoStatus(id, 'pr_draft')
    expect(todo(id).status).toBe('task_in_progress')
    expect(recorded().at(-1)).toMatchObject({
      from: 'task_todo',
      to: 'task_in_progress',
      kind: 'task',
      source: 'cli',
    })
  })

  it('records nothing when the status does not change', () => {
    const { id } = store().createTodo('x')!
    appendTodoEvents.mockClear()
    store().setTodoStatus(id, 'todo')
    expect(appendTodoEvents).not.toHaveBeenCalled()
  })

  it('carries paused and done across a change of kind and resets any other stage', () => {
    const { id } = store().createTodo('[TASK] y', [], undefined, { kind: 'task' })!
    store().setTodoStatus(id, 'paused')
    store().setTodoKind(id, 'pr')
    expect(todo(id)).toMatchObject({ kind: 'pr', status: 'paused' })

    store().setTodoStatus(id, 'pr_waiting_review')
    store().setTodoKind(id, 'general')
    expect(todo(id).kind).toBeUndefined()
    expect(todo(id).status).toBe('todo')
    expect(recorded().at(-1)).toMatchObject({ from: 'pr_waiting_review', to: 'todo' })
  })

  it('reopens a finished task in its kind’s first stage', () => {
    const { id } = store().createTodo('[RELEASE] v1', [], undefined, { kind: 'release' })!
    store().toggleTodo(id)
    expect(todo(id)).toMatchObject({ status: 'done', completed: true })
    store().toggleTodo(id)
    expect(todo(id)).toMatchObject({ status: 'release_scope_open', completed: false })
  })
})
