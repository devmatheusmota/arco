import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { parseAdoRef } from './adoRef'
import { cliReply, type CliResult } from './tauri/cli'
import { findTodoByRef, parseTodoStatus, TODO_NOTES_MAX_LENGTH } from './todos'
import type {
  AgentType,
  Terminal,
  TodoAdoRef,
  TodoItem,
  TodoPriority,
  TodoSessionOwner,
  WorktreeChoice,
} from './types'

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
  /** `--todo <ref>`: the task this session is born working on. */
  todo?: string
  /** Takes the task over from the session that already holds it. */
  force?: boolean
}

/**
 * How a command names the session it wants a task tied to.
 *
 * `session` is what was typed — a pane id or `current`. The other two are how
 * `current` gets resolved: the pane exports its own id, and the directory the
 * command ran in is the fallback for sessions started before that existed, or
 * for a terminal the app did not spawn.
 */
type SessionScope = {
  session?: string
  sessionId?: string
  sessionCwd?: string
  force?: boolean
}

type TodoRequest = {
  title?: string
  project?: string
  /** Where the command ran, so a task lands in the project that owns that tree. */
  cwd?: string
  tags?: string[]
  notes?: string
  priority?: TodoPriority
  status?: string
  /** Raw string handed by the CLI; parsed here against the ADO defaults. */
  adoRefInput?: string
} & SessionScope

/** `arco session rename` — the new name plus how the session was named. */
type SessionRenameRequest = { name?: string } & SessionScope

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
  clearSession?: boolean
} & SessionScope

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

/**
 * Refuses a note that would not fit whole.
 *
 * The store clamps to `TODO_NOTES_MAX_LENGTH`, and a clamp the caller never
 * hears about is how an append reports success and drops its tail. Saying no
 * leaves the note that is there intact and tells the caller what to cut.
 */
function notesTooLong(text: string, existing = ''): string | null {
  const combined = existing ? `${existing}\n\n${text}` : text
  if (combined.length <= TODO_NOTES_MAX_LENGTH) return null
  return `Notas grandes demais: ${combined.length} caracteres, o limite e ${TODO_NOTES_MAX_LENGTH}. Nada foi gravado.`
}

/** A pane and the project holding it — what the CLI calls a session. */
type SessionEntry = { terminal: Terminal; projectId: string }

/** Only real terminals are sessions; a markdown or browser pane is not one. */
function sessionEntries(): SessionEntry[] {
  return useProjectsStore
    .getState()
    .projects.flatMap((project) =>
      project.terminals
        .filter((terminal) => (terminal.kind ?? 'terminal') === 'terminal')
        .map((terminal) => ({ terminal, projectId: project.id })),
    )
}

/**
 * Records what the session was, not only which id it had.
 *
 * The pane is going to close long before the task stops being read, and an id
 * on its own tells whoever opens the task later nothing at all — the name, the
 * agent and the directory are what make the link legible afterwards.
 */
function sessionOwner(entry: SessionEntry): TodoSessionOwner {
  const { terminal, projectId } = entry
  const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
  const cwd = tab?.cwd?.trim() || terminal.cwd?.trim() || ''
  const name = terminal.name?.trim() || ''
  return {
    id: terminal.id,
    projectId,
    ...(tab?.type ? { agent: tab.type } : {}),
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    linkedAt: Date.now(),
  }
}

/** How deep inside a pane's tree a directory sits, or -1 when it is outside it. */
function treeDepth(entry: SessionEntry, cwd: string): number {
  const roots = [entry.terminal.cwd, ...entry.terminal.tabs.map((tab) => tab.cwd)]
  let deepest = -1
  for (const raw of roots) {
    const root = raw?.trim()
    if (!root) continue
    if (cwd === root || cwd.startsWith(`${root}/`)) deepest = Math.max(deepest, root.length)
  }
  return deepest
}

function describeSession(entry: SessionEntry): string {
  const name = entry.terminal.name?.trim()
  return name ? `${entry.terminal.id.slice(0, 8)} ${name}` : entry.terminal.id.slice(0, 8)
}

const NO_SESSION_HERE =
  'Sem sessão do Arco neste terminal: rode o comando dentro de uma sessão, ou passe --session <id>.'

/**
 * What `--session <id|current>` points at.
 *
 * `orphanId` is a session the store no longer has a pane for: still a truthful
 * name for a task that outlives it, and nothing a command that has to act on
 * the pane can work with.
 */
type SessionMatch = { entry: SessionEntry } | { orphanId: string } | { error: CliResult }

/**
 * Resolves `--session <id|current>` to the pane it names.
 *
 * `current` is answered from the pane's own `ARCO_SESSION_ID` when it has one,
 * and from the working directory otherwise. The directory is a good enough
 * answer for a pane with its own worktree and no answer at all for two sessions
 * sharing a tree — which is why that case asks for an explicit id instead of
 * picking one, since acting on the wrong session is worse than doing nothing.
 */
function matchSession(request: SessionScope): SessionMatch {
  const wanted = request.session?.trim() ?? ''
  const cwd = request.sessionCwd?.trim() ?? ''
  const entries = sessionEntries()

  if (wanted && wanted.toLowerCase() !== 'current' && wanted.toLowerCase() !== 'atual') {
    const exact = entries.find((entry) => entry.terminal.id === wanted)
    if (exact) return { entry: exact }
    const byPrefix = entries.filter((entry) => entry.terminal.id.startsWith(wanted))
    if (byPrefix.length === 1) return { entry: byPrefix[0] }
    if (byPrefix.length > 1) {
      return {
        error: failure(
          `"${wanted}" corresponde a ${byPrefix.length} sessões: ${byPrefix
            .slice(0, 3)
            .map(describeSession)
            .join('; ')}…`,
        ),
      }
    }
    return { error: failure(`Nenhuma sessão do Arco com o id "${wanted}".`) }
  }

  const declared = request.sessionId?.trim()
  if (declared) {
    const entry = entries.find((item) => item.terminal.id === declared)
    return entry ? { entry } : { orphanId: declared }
  }

  if (!cwd) return { error: failure(NO_SESSION_HERE) }
  const matches = entries
    .map((entry) => ({ entry, depth: treeDepth(entry, cwd) }))
    .filter((match) => match.depth >= 0)
  if (matches.length === 0) return { error: failure(NO_SESSION_HERE) }
  const deepest = Math.max(...matches.map((match) => match.depth))
  const finalists = matches.filter((match) => match.depth === deepest)
  if (finalists.length > 1) {
    return {
      error: failure(
        `${finalists.length} sessões dividem este diretório: ${finalists
          .slice(0, 3)
          .map((match) => describeSession(match.entry))
          .join('; ')}. Passe --session <id> para dizer qual.`,
      ),
    }
  }
  return { entry: finalists[0].entry }
}

/** The session a task gets tied to — an id it can keep even after the pane closes. */
function resolveSession(request: SessionScope): { owner: TodoSessionOwner } | { error: CliResult } {
  const match = matchSession(request)
  if ('error' in match) return { error: match.error }
  if ('entry' in match) return { owner: sessionOwner(match.entry) }
  // The pane is gone, or belongs to another profile. The id still names the
  // session honestly, which is the whole point of keeping the link.
  const cwd = request.sessionCwd?.trim() ?? ''
  return { owner: { id: match.orphanId, ...(cwd ? { cwd } : {}), linkedAt: Date.now() } }
}

/** Refuses to move a task another session already holds, unless told to. */
function sessionConflict(
  todo: TodoItem,
  next: TodoSessionOwner,
  force?: boolean,
): CliResult | null {
  const current = todo.session
  if (!current || current.id === next.id || force) return null
  const label = current.name
    ? `${current.id.slice(0, 8)} (${current.name})`
    : current.id.slice(0, 8)
  return failure(
    `A tarefa já é da sessão ${label}. Use --force para transferir, ou --clear-session antes.`,
  )
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

  // The task is resolved before anything is spawned: a reference that does not
  // point anywhere must not leave a session running with nothing attached to it.
  let target: TodoItem | null = null
  if (request.todo) {
    const found = resolveTodo(request.todo, 'ligar à sessão')
    if ('error' in found) return found.error
    target = found.todo
    const held = target.session
    if (held && !request.force) {
      const label = held.name ? `${held.id.slice(0, 8)} (${held.name})` : held.id.slice(0, 8)
      return failure(`A tarefa já é da sessão ${label}. Use --force para transferir.`)
    }
  }

  // `--name` is somebody typing a name; without it the pane takes the task's
  // title when there is one, and falls back to the agent's own label.
  const requestedName = request.name?.trim()
  const paneName = requestedName || target?.title?.trim() || agent
  const paneNameSource = requestedName ? 'user' : target ? 'task' : 'auto'

  const terminal = await store.createAgentTerminal(projectId, {
    name: paneName,
    nameSource: paneNameSource,
    cwd,
    worktree: normalizeWorktree(request.worktree),
    firstTab: {
      type: agent,
      cwd,
      initialInput: request.prompt?.trim() || undefined,
      runtimeProfile: 'lean',
    },
  })
  if (!target) return { ok: true, message: `Sessão ${agent} criada.` }

  const linked = useProjectsStore.getState()
  linked.setTodoSession(target.id, {
    id: terminal.id,
    projectId,
    agent,
    ...(terminal.name?.trim() ? { name: terminal.name.trim() } : {}),
    ...(terminal.cwd?.trim() ? { cwd: terminal.cwd.trim() } : {}),
    linkedAt: Date.now(),
  })
  linked.linkTodoSession(target.id, {
    projectId,
    terminalId: terminal.id,
    agent,
    startedAt: Date.now(),
  })
  if (!target.projectId) linked.setTodoProject(target.id, projectId)
  return {
    ok: true,
    message: `Sessão ${agent} criada e ligada a ${target.id.slice(0, 8)} ${target.title}.`,
    data: { todo: todoSnapshot(target.id), sessionId: terminal.id },
  }
}

/**
 * `arco session rename` — the same write the sidebar's Rename does.
 *
 * `nameSource: 'user'` is what makes it stick: without the marker the name the
 * agent generates for the conversation wins on screen, and the rename looks
 * like it did nothing.
 */
function handleSessionRename(request: SessionRenameRequest): CliResult {
  const name = request.name?.trim() ?? ''
  if (!name) return failure('Informe o nome novo da sessão.')

  const match = matchSession(request)
  if ('error' in match) return match.error
  if ('orphanId' in match) {
    return failure(`A sessão ${match.orphanId.slice(0, 8)} não está aberta neste perfil.`)
  }

  const { terminal, projectId } = match.entry
  useProjectsStore.getState().renameTerminal(projectId, terminal.id, name)
  return {
    ok: true,
    message: `Sessão ${terminal.id.slice(0, 8)} renomeada para "${name}".`,
    data: { sessionId: terminal.id, name },
  }
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
  if (request.notes) {
    const problem = notesTooLong(request.notes)
    if (problem) return failure(problem)
  }
  const adoRef = resolveAdoRef(request.adoRefInput)
  // A rejected reference fails the whole creation: a task that silently lost
  // the card it was created for is worse than no task at all.
  if (request.adoRefInput && !adoRef) return failure(adoRefProblem(request.adoRefInput))
  // Resolved before the write, so a session that cannot be named fails the
  // creation instead of leaving a task nobody can trace back.
  let session: TodoSessionOwner | null = null
  if (request.session) {
    const resolved = resolveSession(request)
    if ('error' in resolved) return resolved.error
    session = resolved.owner
  }
  const store = useProjectsStore.getState()
  const todo = store.createTodo(title, request.tags ?? [], resolveProjectId(request) ?? undefined, {
    notes: request.notes,
    priority: request.priority,
    ...(status ? { status } : {}),
    ...(adoRef ? { adoRef } : {}),
  })
  if (!todo) return failure(`Não consegui criar a tarefa "${title}".`)
  if (session) store.setTodoSession(todo.id, session)
  return {
    ok: true,
    message: 'criada',
    data: { todo: todoSnapshot(todo.id) ?? todo },
  }
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
  if (request.notes !== undefined) {
    const problem = notesTooLong(request.notes)
    if (problem) return failure(problem)
    store.updateTodoNotes(todo.id, request.notes)
  }
  if (request.appendNotes !== undefined) {
    const problem = notesTooLong(request.appendNotes, todo.notes ?? '')
    if (problem) return failure(problem)
    store.appendTodoNotes(todo.id, request.appendNotes)
  }
  if (request.priority) store.setTodoPriority(todo.id, request.priority)
  if (request.project !== undefined) {
    store.setTodoProject(todo.id, request.project ? resolveProjectId(request) : null)
  }
  if (request.clearAdoRef) {
    store.setTodoAdoRef(todo.id, null)
  } else if (request.adoRefInput) {
    const ref = resolveAdoRef(request.adoRefInput)
    // Stopping here leaves the edits already applied in place, which is the
    // honest outcome: the answer names what failed instead of reporting a link
    // that was never written.
    if (!ref) return failure(adoRefProblem(request.adoRefInput))
    store.setTodoAdoRef(todo.id, ref, 'merge')
  }
  if (request.clearSession) {
    store.setTodoSession(todo.id, null)
  } else if (request.session) {
    const resolved = resolveSession(request)
    if ('error' in resolved) return resolved.error
    const conflict = sessionConflict(todo, resolved.owner, request.force)
    if (conflict) return conflict
    // Linking twice from the same session must not rewrite when it happened.
    if (todo.session?.id !== resolved.owner.id) store.setTodoSession(todo.id, resolved.owner)
  }

  const tags = nextTags(todo.tags, request)
  if (tags) store.updateTodoTags(todo.id, tags)
  return { ok: true, message: 'editada', data: { todo: todoSnapshot(todo.id) } }
}

/** `arco todo show <ref>` — the whole task, so nobody has to grep the JSON listing. */
function handleTodoShow(request: TodoRefRequest): CliResult {
  const found = resolveTodo(request.ref, 'mostrar')
  if ('error' in found) return found.error
  const projects = useProjectsStore.getState().projects
  const project = projects.find((item) => item.id === found.todo.projectId)
  return {
    ok: true,
    data: {
      todo: found.todo,
      projectName: project?.name ?? null,
      sessionId: found.todo.session?.id ?? null,
    },
  }
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
    listen<SessionRenameRequest & CliRequest>(
      'cli://session-rename',
      answer<SessionRenameRequest & CliRequest>(handleSessionRename),
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
