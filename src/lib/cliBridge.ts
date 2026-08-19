import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { parseAdoRef } from './adoRef'
import { cliReply, type CliResult } from './tauri/cli'
import { findTodoByRef, parseTodoStatus } from './todos'
import type { AgentType, TodoAdoRef, TodoItem, TodoPriority, WorktreeChoice } from './types'

/**
 * Bridge for the `arco` command line.
 *
 * The CLI posts to the local listener, which emits these events; the store lives
 * here in the frontend, so this is where the work actually happens. Every
 * request carries a `requestId` and the command line blocks on the answer: a
 * write that was rejected — an unknown task, a reference that does not parse —
 * has to reach the terminal that asked for it, not only a toast in a window
 * nobody is looking at.
 */

/** Envelope every handler answers with, echoed back through `cli_reply`. */
type CliRequest = { requestId?: string }

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
  /** Raw string handed by the CLI; parsed here against the ADO defaults. */
  adoRefInput?: string
  watch?: boolean
}

/** `arco todo show` and `arco todo delete` — a reference and nothing else. */
type TodoRefRequest = { ref?: string }

/** `arco todo edit` — every field is optional, and only what is present changes. */
type TodoEditRequest = {
  ref?: string
  title?: string
  tags?: string[]
  addTags?: string[]
  removeTags?: string[]
  notes?: string
  appendNotes?: string
  priority?: TodoPriority
  status?: string
  project?: string
  adoRefInput?: string
  clearAdoRef?: boolean
  watch?: boolean
}

/** Reads the ADO defaults saved in Preferences, used to resolve short ids like `#22447`. */
function adoDefaults(): { org?: string; project?: string } {
  const preferences = useProjectsStore.getState().preferences
  const org = preferences.adoOrg?.trim()
  const project = preferences.adoProject?.trim()
  return {
    ...(org ? { org } : {}),
    ...(project ? { project } : {}),
  }
}

function resolveAdoRef(input: string | undefined): TodoAdoRef | null {
  if (!input) return null
  return parseAdoRef(input, adoDefaults())
}

/**
 * Why a reference did not resolve, in the terms of what the caller can change.
 *
 * A bare work item id needs the organization and the project to come from
 * somewhere, and Preferences is the only place that has them. Answering "not
 * recognized" for that case sends people looking for a typo in a number that
 * was right.
 */
function adoRefProblem(input: string): string {
  const defaults = adoDefaults()
  if (/^[!#]?\d{1,7}$/.test(input.trim()) && (!defaults.org || !defaults.project)) {
    return `Não dá para resolver "${input}" sem a organização e o projeto do Azure DevOps: preencha-os em Preferências ou passe a URL completa do work item.`
  }
  return `Referência ADO não reconhecida: ${input}. Aceito: id do work item, URL de work item (_workitems/edit/<id>) ou URL de pull request.`
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

/** Fails the request and shows the same reason in the window. */
function failure(detail: string): CliResult {
  reportProblem(detail)
  return { ok: false, message: detail }
}

async function handleSession(request: SessionRequest): Promise<CliResult> {
  const agent = (request.agent ?? 'claude') as AgentType
  if (!AGENTS.includes(agent)) return failure(`Agente desconhecido: ${request.agent}`)
  const projectId = resolveProjectId(request)
  if (!projectId) return failure('Nenhum projeto aberto para receber a sessão.')
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
  return { ok: true, message: `Sessão ${agent} criada.` }
}

/** The task as the command line prints it, read back from the store after the write. */
function todoSnapshot(id: string): TodoItem | null {
  return useProjectsStore.getState().todos.find((item) => item.id === id) ?? null
}

function handleTodo(request: TodoRequest): CliResult {
  const title = request.title?.trim()
  if (!title) return failure('Tarefa sem título.')
  const status = request.status ? parseTodoStatus(request.status) : null
  if (request.status && !status) return failure(`Status desconhecido: ${request.status}`)
  const adoRef = resolveAdoRef(request.adoRefInput)
  // A rejected reference fails the whole creation: a task that silently lost
  // the card it was created for is worse than no task at all.
  if (request.adoRefInput && !adoRef) return failure(adoRefProblem(request.adoRefInput))
  const store = useProjectsStore.getState()
  const todo = store.createTodo(title, request.tags ?? [], resolveProjectId(request) ?? undefined, {
    notes: request.notes,
    priority: request.priority,
    ...(status ? { status } : {}),
    ...(adoRef ? { adoRef } : {}),
  })
  if (!todo) return failure(`Não consegui criar a tarefa "${title}".`)
  const warnings: string[] = []
  if (request.watch !== undefined) {
    store.setTodoWatch(todo.id, request.watch)
    if (request.watch) warnings.push(...idleWatcherWarnings(Boolean(adoRef)))
  }
  return {
    ok: true,
    message: 'criada',
    data: { todo: todoSnapshot(todo.id) ?? todo, warnings },
  }
}

/**
 * A task can be marked as watched before anything can act on it — the watcher
 * needs both a linked card and a PAT. Saying so at the call site is what keeps
 * `--watch` from looking like it worked while nothing polls.
 */
function idleWatcherWarnings(hasAdoRef: boolean): string[] {
  if (!hasAdoRef) {
    return ['Acompanhamento ligado, mas a tarefa não tem card do ADO: nada será consultado.']
  }
  if (!useProjectsStore.getState().preferences.adoPat.trim()) {
    return ['Acompanhamento ligado, mas falta o PAT do Azure DevOps em Preferências.']
  }
  return []
}

/**
 * Applies an edit to the task a reference points at.
 *
 * Agents drive this as much as people do — a session started from a task moves
 * it to `in_progress` and to `review` on its own — so an ambiguous reference
 * answers with the candidates instead of picking one.
 */
function handleTodoEdit(request: TodoEditRequest): CliResult {
  const found = resolveTodo(request.ref, 'editar')
  if ('error' in found) return found.error
  const { todo } = found
  const store = useProjectsStore.getState()

  if (request.status) {
    const status = parseTodoStatus(request.status)
    if (!status) return failure(`Status desconhecido: ${request.status}`)
    store.setTodoStatus(todo.id, status)
  }
  if (request.title?.trim()) store.renameTodo(todo.id, request.title)
  if (request.notes !== undefined) store.updateTodoNotes(todo.id, request.notes)
  if (request.appendNotes !== undefined) store.appendTodoNotes(todo.id, request.appendNotes)
  if (request.priority) store.setTodoPriority(todo.id, request.priority)
  if (request.project !== undefined) {
    store.setTodoProject(todo.id, request.project ? resolveProjectId(request) : null)
  }
  let linked = Boolean(todo.adoRef)
  if (request.clearAdoRef) {
    store.setTodoAdoRef(todo.id, null)
    linked = false
  } else if (request.adoRefInput) {
    const ref = resolveAdoRef(request.adoRefInput)
    // Stopping here leaves the edits already applied in place, which is the
    // honest outcome: the answer names what failed instead of reporting a link
    // that was never written.
    if (!ref) return failure(adoRefProblem(request.adoRefInput))
    store.setTodoAdoRef(todo.id, ref, 'merge')
    linked = true
  }
  const warnings: string[] = []
  if (request.watch !== undefined) {
    store.setTodoWatch(todo.id, request.watch)
    if (request.watch) warnings.push(...idleWatcherWarnings(linked))
  }

  const tags = nextTags(todo.tags, request)
  if (tags) store.updateTodoTags(todo.id, tags)
  return { ok: true, message: 'editada', data: { todo: todoSnapshot(todo.id), warnings } }
}

/** `arco todo show <ref>` — the whole task, so nobody has to grep the JSON listing. */
function handleTodoShow(request: TodoRefRequest): CliResult {
  const found = resolveTodo(request.ref, 'mostrar')
  if ('error' in found) return found.error
  const projects = useProjectsStore.getState().projects
  const project = projects.find((item) => item.id === found.todo.projectId)
  return { ok: true, data: { todo: found.todo, projectName: project?.name ?? null } }
}

/** `arco todo delete <ref>` — how an agent cleans up tasks it created by mistake. */
function handleTodoDelete(request: TodoRefRequest): CliResult {
  const found = resolveTodo(request.ref, 'apagar')
  if ('error' in found) return found.error
  useProjectsStore.getState().deleteTodo(found.todo.id)
  return { ok: true, message: 'apagada', data: { todo: found.todo } }
}

/** `arco todo list` — served from the store, so it never lags behind a write. */
function handleTodoList(): CliResult {
  return { ok: true, data: { todos: useProjectsStore.getState().todos } }
}

/** Resolves a `<ref>` or explains, in one place, why it did not point at a task. */
function resolveTodo(
  rawRef: string | undefined,
  verb: string,
): { todo: TodoItem } | { error: CliResult } {
  const ref = rawRef?.trim()
  if (!ref) return { error: failure(`Informe qual tarefa ${verb}.`) }
  const { todo, ambiguous } = findTodoByRef(useProjectsStore.getState().todos, ref)
  if (todo) return { todo }
  if (ambiguous.length > 0) {
    const names = ambiguous
      .slice(0, 3)
      .map((item) => `${item.id.slice(0, 8)} ${item.title}`)
      .join('; ')
    return { error: failure(`"${ref}" corresponde a ${ambiguous.length} tarefas: ${names}…`) }
  }
  return { error: failure(`Nenhuma tarefa encontrada para "${ref}".`) }
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

/**
 * Runs a handler and answers the request the command line is blocked on.
 *
 * A handler that throws still has to answer — an unanswered request only shows
 * up as a timeout eight seconds later, with nothing saying what broke.
 */
function answer<T extends CliRequest>(
  handler: (request: T) => CliResult | Promise<CliResult>,
): (event: { payload?: T }) => void {
  return (event) => {
    const request = (event.payload ?? {}) as T
    void (async () => {
      let result: CliResult
      try {
        result = await handler(request)
      } catch (error) {
        result = failure(`Falha ao executar o comando: ${String(error).slice(0, 160)}`)
      }
      if (!request.requestId) return
      await cliReply(request.requestId, result).catch(() => {})
    })()
  }
}

/** Wires the CLI events. Returns a disposer for the app to call on teardown. */
export async function startCliBridge(): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<SessionRequest & CliRequest>(
      'cli://session-new',
      answer<SessionRequest & CliRequest>(handleSession),
    ),
    listen<TodoRequest & CliRequest>(
      'cli://todo-add',
      answer<TodoRequest & CliRequest>(handleTodo),
    ),
    listen<CliRequest>('cli://todo-list', answer<CliRequest>(handleTodoList)),
    listen<TodoRefRequest & CliRequest>(
      'cli://todo-show',
      answer<TodoRefRequest & CliRequest>(handleTodoShow),
    ),
    listen<TodoEditRequest & CliRequest>(
      'cli://todo-edit',
      answer<TodoEditRequest & CliRequest>(handleTodoEdit),
    ),
    listen<TodoRefRequest & CliRequest>(
      'cli://todo-delete',
      answer<TodoRefRequest & CliRequest>(handleTodoDelete),
    ),
  ])
  return () => unlisteners.forEach((dispose) => dispose())
}
