import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { findTodoByRef, parseTodoStatus } from './todos'
import type { AgentType, TodoPriority, WorktreeChoice } from './types'

/**
 * Bridge for the `arco` command line.
 *
 * The CLI posts to the local listener, which emits these events; the store lives
 * here in the frontend, so this is where the work actually happens. Requests are
 * fire-and-forget by design — the HTTP side answers `queued` and never blocks on
 * the UI.
 */

type SessionRequest = {
  agent?: string
  project?: string
  cwd?: string
  name?: string
  worktree?: WorktreeChoice | boolean
  prompt?: string
}

type TodoRequest = {
  title?: string
  project?: string
  tags?: string[]
  notes?: string
  priority?: TodoPriority
  status?: string
}

/** `arco todo edit` — every field is optional, and only what is present changes. */
type TodoEditRequest = {
  ref?: string
  title?: string
  tags?: string[]
  addTags?: string[]
  removeTags?: string[]
  notes?: string
  priority?: TodoPriority
  status?: string
  project?: string
}

const AGENTS: readonly AgentType[] = ['shell', 'claude', 'codex', 'opencode']

/** `--worktree` is a flag on the command line and an enum in the store. */
function normalizeWorktree(value: SessionRequest['worktree']): WorktreeChoice {
  if (value === true) return 'new'
  if (value === false) return 'none'
  if (value === 'new' || value === 'none' || value === 'inherit') return value
  return 'inherit'
}

/**
 * Resolves which project a request targets: an explicit name or id wins, then the
 * project whose directory matches `cwd` — the common case, since the CLI is
 * usually run from inside the repo — and the active project last.
 */
function resolveProjectId(request: SessionRequest | TodoRequest | TodoEditRequest): string | null {
  const { projects, activeProjectId } = useProjectsStore.getState()
  const wanted = request.project?.trim().toLowerCase()
  if (wanted) {
    const match = projects.find(
      (project) => project.id === request.project || project.name.trim().toLowerCase() === wanted,
    )
    if (match) return match.id
  }
  const cwd = 'cwd' in request ? request.cwd?.trim() : undefined
  if (cwd) {
    const match = projects.find((project) => {
      const root = project.defaultCwd?.trim()
      return root ? cwd === root || cwd.startsWith(`${root}/`) : false
    })
    if (match) return match.id
  }
  return activeProjectId ?? projects[0]?.id ?? null
}

function reportProblem(detail: string) {
  useUiStore.getState().pushToast({ title: 'CLI', body: detail })
}

async function handleSession(request: SessionRequest) {
  const agent = (request.agent ?? 'claude') as AgentType
  if (!AGENTS.includes(agent)) {
    reportProblem(`Agente desconhecido: ${request.agent}`)
    return
  }
  const projectId = resolveProjectId(request)
  if (!projectId) {
    reportProblem('Nenhum projeto aberto para receber a sessão.')
    return
  }
  const store = useProjectsStore.getState()
  const project = store.projects.find((item) => item.id === projectId)
  const cwd = request.cwd?.trim() || project?.defaultCwd?.trim() || ''

  await store.createAgentTerminal(projectId, {
    name: request.name?.trim() || agent,
    cwd,
    worktree: normalizeWorktree(request.worktree),
    firstTab: {
      type: agent,
      cwd,
      initialInput: request.prompt?.trim() || undefined,
      runtimeProfile: 'lean',
    },
  })
}

function handleTodo(request: TodoRequest) {
  const title = request.title?.trim()
  if (!title) {
    reportProblem('Tarefa sem título.')
    return
  }
  const status = request.status ? parseTodoStatus(request.status) : null
  if (request.status && !status) {
    reportProblem(`Status desconhecido: ${request.status}`)
    return
  }
  const store = useProjectsStore.getState()
  store.createTodo(title, request.tags ?? [], resolveProjectId(request) ?? undefined, {
    notes: request.notes,
    priority: request.priority,
    ...(status ? { status } : {}),
  })
}

/**
 * Applies an edit to the task a reference points at.
 *
 * Agents drive this as much as people do — a session started from a task moves
 * it to `in_progress` and to `review` on its own — so an ambiguous reference
 * answers with the candidates instead of picking one.
 */
function handleTodoEdit(request: TodoEditRequest) {
  const ref = request.ref?.trim()
  if (!ref) {
    reportProblem('Informe qual tarefa editar.')
    return
  }
  const store = useProjectsStore.getState()
  const { todo, ambiguous } = findTodoByRef(store.todos, ref)
  if (!todo) {
    if (ambiguous.length > 0) {
      const names = ambiguous.slice(0, 3).map((item) => item.title).join(', ')
      reportProblem(`"${ref}" corresponde a ${ambiguous.length} tarefas: ${names}…`)
      return
    }
    reportProblem(`Nenhuma tarefa encontrada para "${ref}".`)
    return
  }

  if (request.status) {
    const status = parseTodoStatus(request.status)
    if (!status) {
      reportProblem(`Status desconhecido: ${request.status}`)
      return
    }
    store.setTodoStatus(todo.id, status)
  }
  if (request.title?.trim()) store.renameTodo(todo.id, request.title)
  if (request.notes !== undefined) store.updateTodoNotes(todo.id, request.notes)
  if (request.priority) store.setTodoPriority(todo.id, request.priority)
  if (request.project !== undefined) {
    store.setTodoProject(todo.id, request.project ? resolveProjectId(request) : null)
  }

  const tags = nextTags(todo.tags, request)
  if (tags) store.updateTodoTags(todo.id, tags)
}

/** Returns the new tag list, or null when the request does not touch tags. */
function nextTags(current: string[], request: TodoEditRequest): string[] | null {
  const replace = request.tags
  const added = request.addTags ?? []
  const removed = new Set((request.removeTags ?? []).map((tag) => tag.trim().toLowerCase()))
  if (!replace && added.length === 0 && removed.size === 0) return null
  const base = replace ?? current
  return [...base, ...added].filter((tag) => !removed.has(tag.trim().toLowerCase()))
}

/** Wires the CLI events. Returns a disposer for the app to call on teardown. */
export async function startCliBridge(): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<SessionRequest>('cli://session-new', (event) => {
      void handleSession(event.payload ?? {}).catch((error) =>
        reportProblem(`Falha ao criar sessão: ${String(error).slice(0, 160)}`),
      )
    }),
    listen<TodoRequest>('cli://todo-add', (event) => {
      handleTodo(event.payload ?? {})
    }),
    listen<TodoEditRequest>('cli://todo-edit', (event) => {
      handleTodoEdit(event.payload ?? {})
    }),
  ])
  return () => unlisteners.forEach((dispose) => dispose())
}
