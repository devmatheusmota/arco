import type { TodoItem, TodoPriority, TodoSessionLink, TodoSessionOwner, TodoStatus } from './types'

export const TODO_TITLE_MAX_LENGTH = 200
export const TODO_TAG_MAX_LENGTH = 24
/**
 * Ceiling for a task's notes.
 *
 * There has to be one: `projects.json` is read whole, saved on a debounce and
 * pushed to the sync gist in one piece, so an unbounded field on 50 tasks is a
 * file nobody can move. 4000 was too low for what it actually holds — a work
 * item's acceptance criteria, the command to run, the branch, and a running log
 * of what changed — and a briefing note reached it and lost its tail.
 */
export const TODO_NOTES_MAX_LENGTH = 32_000
/** Sessions kept per task. Older links are dropped so the file cannot grow forever. */
export const TODO_SESSIONS_MAX = 8

export const DEFAULT_TODOS: Omit<TodoItem, 'id'>[] = [
  { title: 'Review active workspace', completed: false, tags: ['review'] },
  { title: 'Open project README', completed: false, tags: ['docs'] },
  { title: 'Plan next implementation step', completed: false, tags: ['plan'] },
]

export function normalizeTodoTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, TODO_TITLE_MAX_LENGTH)
}

export function normalizeTodoNotes(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, TODO_NOTES_MAX_LENGTH)
}

export function normalizeTodoPriority(value: unknown): TodoPriority {
  return value === 'high' || value === 'low' ? value : 'normal'
}

/**
 * Spellings accepted for a status.
 *
 * The command line and the agents that drive it type what they mean rather than
 * the stored token — "doing", "wip", "code-review" — so the words map here
 * instead of turning into an error the caller has to guess its way out of.
 */
const STATUS_ALIASES: Record<string, TodoStatus> = {
  todo: 'todo',
  open: 'todo',
  backlog: 'todo',
  pending: 'todo',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  inprogress: 'in_progress',
  doing: 'in_progress',
  wip: 'in_progress',
  started: 'in_progress',
  review: 'review',
  'code-review': 'review',
  code_review: 'review',
  cr: 'review',
  reviewing: 'review',
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
}

/** Returns null for anything unrecognised, so a caller can tell a typo from a default. */
export function parseTodoStatus(value: unknown): TodoStatus | null {
  if (typeof value !== 'string') return null
  return STATUS_ALIASES[value.trim().toLowerCase()] ?? null
}

/** Reads a stored status, falling back to what `completed` already says. */
export function normalizeTodoStatus(value: unknown, completed: boolean): TodoStatus {
  const status = parseTodoStatus(value)
  if (completed) return 'done'
  return status && status !== 'done' ? status : 'todo'
}

/** The task list is split by `completed`, so a status change has to move that flag with it. */
export function applyTodoStatus(todo: TodoItem, status: TodoStatus): TodoItem {
  const next: TodoItem = { ...todo, status, completed: status === 'done' }
  if (next.completed) next.completedAt = todo.completedAt ?? Date.now()
  else delete next.completedAt
  return next
}

export function normalizeTodoTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,#\s]+/) : []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item
      .trim()
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_-]/gu, '')
      .slice(0, TODO_TAG_MAX_LENGTH)
      .toLowerCase()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags.slice(0, 6)
}

/** Drops malformed entries and keeps one link per terminal, newest first. */
export function normalizeTodoSessions(value: unknown): TodoSessionLink[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const links: TodoSessionLink[] = []
  for (const item of value) {
    const terminalId = typeof item?.terminalId === 'string' ? item.terminalId : ''
    const projectId = typeof item?.projectId === 'string' ? item.projectId : ''
    const agent = typeof item?.agent === 'string' ? item.agent : ''
    if (!terminalId || !projectId || !agent || seen.has(terminalId)) continue
    seen.add(terminalId)
    links.push({
      terminalId,
      projectId,
      agent: agent as TodoSessionLink['agent'],
      startedAt: typeof item?.startedAt === 'number' ? item.startedAt : 0,
    })
  }
  return links.sort((a, b) => b.startedAt - a.startedAt).slice(0, TODO_SESSIONS_MAX)
}

/**
 * Reads the session that owns a task, or null when the stored value says nothing.
 *
 * Only the id is required: a link written from a terminal whose pane has already
 * been closed carries no agent and no name, and dropping it for that would throw
 * away exactly the history the field exists to keep.
 */
export function normalizeTodoSessionOwner(value: unknown): TodoSessionOwner | null {
  const raw = value as Partial<TodoSessionOwner> | null | undefined
  const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  const text = (input: unknown) =>
    typeof input === 'string' && input.trim() ? input.trim().slice(0, 200) : undefined
  return {
    id,
    ...(text(raw?.projectId) ? { projectId: text(raw?.projectId) } : {}),
    ...(text(raw?.agent) ? { agent: raw?.agent } : {}),
    ...(text(raw?.name) ? { name: text(raw?.name) } : {}),
    ...(text(raw?.cwd) ? { cwd: text(raw?.cwd) } : {}),
    linkedAt: typeof raw?.linkedAt === 'number' ? raw.linkedAt : 0,
  }
}

/**
 * Every session a task points at, newest first.
 *
 * A task can be tied to a session two ways, and only one of them was ever
 * drawn: `sessions`, written when the session is started from the task, and
 * `session`, written by `arco todo --session current` from inside a pane. A
 * task linked from the command line therefore showed no session at all, while
 * the task next to it — same pane — showed one. To a reader they mean the same
 * thing, so they are merged here and the row draws whatever comes out.
 *
 * The owner link is the newer of the two when both name the same pane: it is
 * the one carrying a name and a working directory.
 */
export function todoSessionLinks(todo: TodoItem): TodoSessionLink[] {
  const links = [...(todo.sessions ?? [])]
  const owner = todo.session
  if (owner?.id && !links.some((link) => link.terminalId === owner.id)) {
    links.push({
      terminalId: owner.id,
      projectId: owner.projectId ?? '',
      agent: (owner.agent ?? 'claude') as TodoSessionLink['agent'],
      startedAt: owner.linkedAt,
    })
  }
  return links.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Whether a task belongs to the session the user is in.
 *
 * Two links can say so: the one the command line writes (`session`) and the
 * jump-back link a task-started session leaves behind (`sessions`). Both mean
 * the same thing to somebody reading the board — this row is what the pane in
 * front is working on — so both count.
 *
 * Which pane is in front is answered by more than one piece of state, and none
 * of them alone is the answer: focus mode names a pane only while it is on,
 * the last pane pointed at is unset until something is pointed at, and the
 * container knows what it renders but not what the user is typing into. Any of
 * them naming the task is enough.
 */
export function isCurrentSessionTodo(todo: TodoItem, sessionIds: readonly string[]): boolean {
  if (sessionIds.length === 0) return false
  const wanted = new Set(sessionIds)
  if (todo.session && wanted.has(todo.session.id)) return true
  return (todo.sessions ?? []).some((link) => wanted.has(link.terminalId))
}

/**
 * Turns a task into the first message of an agent session. The title carries the
 * intent, the notes carry the detail, and the tags survive as a hint — agents read
 * them as scope labels the same way a human reader would.
 */
export function buildTaskSessionPrompt(todo: Pick<TodoItem, 'title' | 'notes' | 'tags'>): string {
  const lines = [`Task: ${todo.title.trim()}`]
  if (todo.tags.length > 0) lines.push(`Tags: ${todo.tags.map((tag) => `#${tag}`).join(' ')}`)
  const notes = todo.notes?.trim()
  if (notes) lines.push('', notes)
  return lines.join('\n')
}

/** Sorts a task list so higher priority floats up without disturbing manual order inside a tier. */
export function sortTodosByPriority(items: TodoItem[]): TodoItem[] {
  const weight: Record<TodoPriority, number> = { high: 0, normal: 1, low: 2 }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const delta =
        weight[normalizeTodoPriority(a.item.priority)] -
        weight[normalizeTodoPriority(b.item.priority)]
      return delta !== 0 ? delta : a.index - b.index
    })
    .map((entry) => entry.item)
}

/**
 * Puts a task back in the list after its status changed: finished tasks sink to
 * the bottom, reopened ones return just above the finished block.
 */
export function placeTodoInList(items: TodoItem[], changed: TodoItem): TodoItem[] {
  const remaining = items.filter((item) => item.id !== changed.id)
  if (changed.completed) return [...remaining, changed]
  const firstCompleted = remaining.findIndex((item) => item.completed)
  const insertAt = firstCompleted === -1 ? remaining.length : firstCompleted
  return [...remaining.slice(0, insertAt), changed, ...remaining.slice(insertAt)]
}

export type TodoMatch = {
  todo: TodoItem | null
  /** Populated when the reference fits more than one task, so the caller can say which. */
  ambiguous: TodoItem[]
}

/**
 * Resolves the task a command line argument points at.
 *
 * Ids are generated, so nobody types them in full: an id prefix works, and so
 * does a piece of the title, which is what a person — or an agent reading its
 * own task — actually has at hand.
 */
export function findTodoByRef(items: TodoItem[], rawRef: string): TodoMatch {
  const ref = rawRef.trim().toLowerCase()
  if (!ref) return { todo: null, ambiguous: [] }

  const exact = items.find((item) => item.id.toLowerCase() === ref)
  if (exact) return { todo: exact, ambiguous: [] }

  const byPrefix =
    ref.length >= 3 ? items.filter((item) => item.id.toLowerCase().startsWith(ref)) : []
  if (byPrefix.length === 1) return { todo: byPrefix[0], ambiguous: [] }
  if (byPrefix.length > 1) return { todo: null, ambiguous: byPrefix }

  const byTitle = items.filter((item) => item.title.toLowerCase().includes(ref))
  if (byTitle.length === 1) return { todo: byTitle[0], ambiguous: [] }
  return { todo: null, ambiguous: byTitle }
}

/** Every tag currently in use, ordered by how many tasks carry it. */
export function collectTodoTags(items: TodoItem[]): string[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
}

/**
 * Drops the session links a predicate rejects — used when the panes they point at are
 * gone. Returns the original array untouched when nothing matched, so a delete that
 * touches no task does not trigger a persist.
 */
export function pruneTodoSessions(
  items: TodoItem[],
  keep: (link: TodoSessionLink) => boolean,
): TodoItem[] {
  let changed = false
  const next = items.map((item) => {
    if (!item.sessions?.length) return item
    const sessions = item.sessions.filter(keep)
    if (sessions.length === item.sessions.length) return item
    changed = true
    const pruned = { ...item }
    if (sessions.length > 0) pruned.sessions = sessions
    else delete pruned.sessions
    return pruned
  })
  return changed ? next : items
}

/** Moves a task within its own completion section; cross-section drops are refused. */
export function reorderTodoItems(
  items: TodoItem[],
  draggedId: string,
  targetId: string,
): TodoItem[] {
  if (draggedId === targetId) return items
  const fromIndex = items.findIndex((item) => item.id === draggedId)
  const targetIndex = items.findIndex((item) => item.id === targetId)
  if (fromIndex === -1 || targetIndex === -1) return items
  if (items[fromIndex].completed !== items[targetIndex].completed) return items

  const next = [...items]
  const [dragged] = next.splice(fromIndex, 1)
  const adjustedTarget = next.findIndex((item) => item.id === targetId)
  next.splice(adjustedTarget, 0, dragged)
  return next
}
