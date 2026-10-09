import { invoke } from '@tauri-apps/api/core'

import type { TodoKind, TodoStatus } from '../types'

/** One recorded change of a task's status; `from` is null when the task was created. */
export type TodoEvent = {
  id: string
  from: TodoStatus | null
  to: TodoStatus
  kind: TodoKind
  at: number
  /** `ui` for the board and the list, `cli` for the command line, the MCP tools and the skills. */
  source: 'ui' | 'cli'
}

export async function appendTodoEvents(events: TodoEvent[]): Promise<void> {
  await invoke('todo_events_append', { events })
}

export async function readTodoEvents(id: string): Promise<TodoEvent[]> {
  return (await invoke<TodoEvent[] | null>('todo_events_read', { id })) ?? []
}
