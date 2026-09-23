import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { useUiStore } from '../stores/uiStore'
import { parseAdoRef } from './adoRef'
import { deliverToPty, submitKeyFor } from './paneDelivery'
import { normalizePaneRef } from './paneShortId'
import { cliReply, type CliResult } from './tauri/cli'
import { findTodoByRef, parseTodoStatus, TODO_NOTES_MAX_LENGTH } from './todos'
import type {
  AgentType,
  PtyStatus,
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
  /** Open in another front than the one the command was run from. */
  group?: string
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
/** `arco session send <ref>` — text for a pane that is already running. */
type SessionSendRequest = {
  target?: string
  text?: string
  /** Deliver the text alone, with no line saying where it came from. */
  raw?: boolean
}

/**
 * The line that says who is talking, and how to answer.
 *
 * Text arriving on its own reads like something the user typed, so an agent
 * has no idea a conversation is open or who to reply to — it answers into its
 * own pane and the reply goes nowhere. Naming the sender and the exact command
 * that reaches it back turns a delivery into a two-way channel.
 *
 * Kept to one line, and skipped when the sender has no reference to give, so
 * the text stays what it was.
 */
export function withSenderLine(text: string, senderRef: string | undefined): string {
  if (!senderRef) return text
  const header = `[de ${senderRef} · responda com: arco session send ${senderRef} <texto>]`
  // Inline for a single line, on its own for anything longer: a header glued
  // to the first line of a block reads as part of it.
  return text.includes('\n') ? `${header}\n${text}` : `${header} ${text}`
}

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
  // The short reference is the only name for a pane that appears anywhere else:
  // the session list, the sender line, `arco session send`. Naming the pane by a
  // slice of its id here handed the reader a word the rest of the app never uses
  // — and this string is printed exactly where someone has to pick one pane out
  // of several, which is the worst moment to change vocabulary.
  const ref = entry.terminal.shortId?.trim() || entry.terminal.id.slice(0, 8)
  const name = entry.terminal.name?.trim()
  return name ? `${ref} ${name}` : ref
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
    // The short reference is the name a person has, so it answers first. It
    // still falls through on a miss: the digits could prefix a nanoid, and
    // refusing outright would make a valid id unreachable.
    const ref = normalizePaneRef(wanted)
    const byRef = ref ? entries.find((entry) => entry.terminal.shortId === ref) : undefined
    if (byRef) return { entry: byRef }
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
    return {
      error: failure(
        ref
          ? `Nenhuma sessão do Arco com a referência ${ref}.`
          : `Nenhuma sessão do Arco com o id "${wanted}".`,
      ),
    }
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
    // Deepest root wins. A project rooted at the home directory is a prefix of
    // every other one, so taking the first match hands it every session opened
    // anywhere on the machine.
    const match = projects
      .map((project) => ({ project, root: project.defaultCwd?.trim() ?? '' }))
      .filter(({ root }) => root && (cwd === root || cwd.startsWith(`${root}/`)))
      .sort((a, b) => b.root.length - a.root.length)[0]
    if (match) return match.project.id
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

/**
 * The front a new session belongs to.
 *
 * Asking for a session from inside a pane means asking for one *here*: the
 * front you are working in, sharing its worktree. That is the whole point of a
 * front, and a session that lands outside it comes back as a loose tab beside
 * the fronts rather than beside its siblings.
 *
 * `--group` names another one, by front name or by the reference of any session
 * in it. A name that matches no front opens one: the flag is the only way the
 * command line has to say "somewhere else", and answering it by landing in the
 * caller's front is how an agent ends up working in another front's worktree.
 * With neither, and no pane to inherit from, the session has no front — which
 * the next load adopts into the project's own.
 */
type GroupChoice = { id?: string; createName?: string; error?: CliResult }

function resolveGroup(request: SessionRequest & SessionScope, projectId: string): GroupChoice {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const groups = project?.groups ?? []

  const wanted = request.group?.trim()
  if (wanted) {
    const ref = normalizePaneRef(wanted)
    if (ref) {
      // A reference names a pane that exists or nothing at all. Opening a front
      // called `pa-1234` because the pane is gone helps nobody.
      const byRef = project?.terminals.find((pane) => pane.shortId === ref)?.groupId
      return byRef ? { id: byRef } : { error: failure(`Nenhum pane com a referência ${ref}.`) }
    }
    const lowered = wanted.toLowerCase()
    const byName = groups.find((group) => group.name.toLowerCase() === lowered)
    return byName ? { id: byName.id } : { createName: wanted }
  }

  if (groups.length === 0) return {}

  // No flag: inherit from the pane the command ran in.
  const match = matchSession(request)
  if ('entry' in match) return { id: match.entry.terminal.groupId }

  // The `arco` on PATH is whatever build is installed, and an older one sends
  // no session scope at all — the working directory is the one thing every
  // version has always sent. A directory inside a front's worktree, or inside
  // a pane of one, is that front: the session is already standing in it.
  const cwd = request.cwd?.trim() ?? ''
  if (!cwd) return {}
  const within = (root: string | undefined) =>
    Boolean(root) && (cwd === root || cwd.startsWith(`${root}/`))

  const byWorktree = groups.find((group) => within(group.cwd?.trim()))
  if (byWorktree) return { id: byWorktree.id }
  // Deepest first: a pane in a worktree under the project root must not match
  // the project root's own front.
  const byPane = [...(project?.terminals ?? [])]
    .filter((pane) => pane.groupId && within(pane.cwd?.trim()))
    .sort((a, b) => (b.cwd?.length ?? 0) - (a.cwd?.length ?? 0))[0]
  return byPane?.groupId ? { id: byPane.groupId } : {}
}

async function handleSession(request: SessionRequest & SessionScope): Promise<CliResult> {
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

  const choice = resolveGroup(request, projectId)
  if (choice.error) return choice.error
  let groupId = choice.id
  let group = groupId ? (project?.groups ?? []).find((item) => item.id === groupId) : undefined
  if (!group && choice.createName) {
    group = store.createGroup(projectId, { name: choice.createName })
    groupId = group.id
  }

  // A front that owns a worktree shares it: a second session there editing a
  // checkout of its own would not be in the same piece of work at all. That is
  // the right default, and the wrong answer to someone who typed `--worktree`:
  // overriding it in silence is what let an agent run in another front's tree.
  const requested = normalizeWorktree(request.worktree)
  if (group?.worktreeAgentId && requested === 'new') {
    return failure(
      `A frente "${group.name}" já trabalha na worktree ${group.worktreeAgentId}, e uma sessão dela não abre outra. ` +
        'Use --group com um nome novo para abrir uma frente com worktree própria, ou tire o --worktree para entrar nesta.',
    )
  }
  const worktree = group?.worktreeAgentId ? 'none' : requested
  const paneCwd = group?.cwd?.trim() || cwd

  const terminal = await store.createAgentTerminal(projectId, {
    name: paneName,
    nameSource: paneNameSource,
    cwd: paneCwd,
    worktree,
    firstTab: {
      type: agent,
      cwd: paneCwd,
      initialInput: request.prompt?.trim() || undefined,
      runtimeProfile: 'lean',
    },
    ...(groupId ? { groupId } : {}),
  })

  // The front takes the worktree its first session provisioned, the same way the
  // interface does it. Left on the pane alone, the worktree is invisible to
  // `arco group list` and, worse, `closeGroupWithWorktree` has nothing to remove:
  // closing the front leaves the checkout on disk with nobody to answer for it.
  if (groupId && terminal.worktreeAgentId && !group?.worktreeAgentId) {
    useProjectsStore.getState().adoptGroupWorktree(projectId, groupId, {
      worktreeAgentId: terminal.worktreeAgentId,
      cwd: terminal.cwd,
    })
  }

  const where = group ? ` na frente "${group.name}"` : ''
  if (!target) return { ok: true, message: `Sessão ${agent} criada${where}.` }

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
 * What the pane's active tab is doing, as the app itself labels it.
 *
 * The status lives in `useTerminalsStore`, keyed by PTY, so a pane that has not
 * been opened since the app started has no runtime at all — which is `offline`,
 * the same answer as a process that has exited. `parked` is reported separately
 * because it is not a state of the agent: the pane is alive and its runtime was
 * released to save memory.
 */
function paneStatus(terminal: Terminal): { status: PtyStatus; parked: boolean } {
  if (terminal.disabled) return { status: 'disabled', parked: false }
  const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
  const ptyId = tab?.ptyId
  if (!ptyId) return { status: 'offline', parked: false }
  const runtime = useTerminalsStore.getState().byPtyId[ptyId]
  if (!runtime?.alive) return { status: 'offline', parked: false }
  return { status: runtime.status, parked: runtime.parked }
}

/**
 * `arco session list` — every pane the command line can address.
 *
 * Read from the store and nowhere else: a pane exists in the running window, so
 * there is nothing on disk to fall back to. An app that is not up answers 504,
 * which is the truthful answer rather than a stale listing.
 */
function handleSessionList(request: SessionScope = {}): CliResult {
  const { projects, todos } = useProjectsStore.getState()
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const groupsById = new Map(
    projects.flatMap((project) => (project.groups ?? []).map((group) => [group.id, group])),
  )
  const sessions = sessionEntries().map(({ terminal, projectId }) => {
    const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
    const todo = todos.find((item) => item.session?.id === terminal.id)
    const { status, parked } = paneStatus(terminal)
    const worktree =
      terminal.worktreeAgentId ?? groupsById.get(terminal.groupId ?? '')?.worktreeAgentId
    return {
      ref: terminal.shortId ?? '',
      id: terminal.id,
      project: projectNames.get(projectId) ?? '',
      projectId,
      name: terminal.name?.trim() ?? '',
      agent: tab?.type ?? '',
      cwd: tab?.cwd?.trim() || terminal.cwd?.trim() || '',
      status,
      parked,
      ...(terminal.groupId
        ? { group: groupsById.get(terminal.groupId)?.name ?? '', groupId: terminal.groupId }
        : {}),
      pinned: Boolean(terminal.pinned),
      // The caller exports its own id, so the listing can point at the row that
      // is asking — without it, an agent cannot tell itself apart.
      current: terminal.id === request.sessionId,
      ...(todo ? { todo: todo.id, todoTitle: todo.title } : {}),
      // The worktree belongs to the front now: a session opened inside one runs
      // in it without owning it, and reporting only what the pane owns makes it
      // read as loose when it is not.
      ...(worktree ? { worktree } : {}),
    }
  })
  return { ok: true, data: { sessions } }
}

/**
 * `arco session send <ref> <texto>` — types text into a pane that is running.
 *
 * Written straight into the PTY, inside the request. The agents keep a queue of
 * their own for what arrives mid-turn, and theirs lives in the agent's process.
 * The one Arco used to keep lived in this window's memory, so any reload emptied
 * it without a word after the command line had already answered `ok`.
 *
 * A pane with no process is refused rather than waited for: nothing here lasts
 * long enough to promise a later delivery. A shell pane runs the text as soon as
 * it lands, the same as a paste followed by Enter.
 *
 * There is no check for a pane that is not a terminal: `sessionEntries()` only
 * ever yields those, so a markdown or browser pane cannot be matched here.
 */
async function handleSessionSend(request: SessionSendRequest & SessionScope): Promise<CliResult> {
  const text = request.text?.trim() ?? ''
  if (!text) return failure('Sem texto para entregar.')

  const target = request.target?.trim() ?? ''
  if (!target) return failure('Informe o pane de destino.')

  const match = matchSession({ ...request, session: target })
  if ('error' in match) return match.error
  if ('orphanId' in match) {
    return failure(`A sessão ${match.orphanId.slice(0, 8)} não está aberta neste perfil.`)
  }

  const { terminal } = match.entry
  const label = terminal.shortId || terminal.id.slice(0, 8)
  if (terminal.disabled) {
    return failure(`O pane ${label} está desativado. Reative-o antes de mandar texto.`)
  }

  const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
  const { status, parked } = paneStatus(terminal)

  // A pane that has not been on screen since the app started has no process,
  // and a parked one gave its runtime back. Opening it is what brings either up.
  if (!tab?.ptyId || status === 'offline' || parked) {
    const why = parked ? 'foi estacionado para liberar memória' : 'não está rodando'
    return failure(`O pane ${label} ${why}. Abra-o no app e mande de novo.`)
  }

  // Who sent it, when the sender is a pane of this workspace. The exported id is
  // the reliable answer, but a pane started before that existed does not export
  // one, and without a fallback its messages arrive anonymous — the receiving
  // agent then has no address to answer, which is the whole point of the header.
  // The directory is the same evidence `current` is resolved from; an ambiguous
  // one names nobody rather than guessing wrong.
  const senderScope: SessionScope = request.sessionId
    ? { sessionId: request.sessionId }
    : { sessionCwd: request.sessionCwd }
  const senderMatch = request.sessionId || request.sessionCwd ? matchSession(senderScope) : null
  const sender = senderMatch && 'entry' in senderMatch ? senderMatch.entry : undefined
  const body = request.raw ? text : withSenderLine(text, sender?.terminal.shortId)

  try {
    await deliverToPty(tab.ptyId, body, submitKeyFor(tab.type, body))
  } catch (error) {
    return failure(`Não consegui escrever no pane ${label}: ${String(error).slice(0, 160)}`)
  }

  const data = { sessionId: terminal.id, ref: terminal.shortId ?? null, status }
  if (tab.type === 'shell') {
    return { ok: true, message: `${label}: entregue ao shell, que executa na hora.`, data }
  }
  if (status === 'working') {
    return {
      ok: true,
      message: `${label}: entregue. O agente está trabalhando e lê a mensagem quando puder.`,
      data,
    }
  }
  return { ok: true, message: `${label}: entregue.`, data }
}

/** `arco group list` — the fronts of work open in every project. */
function handleGroupList(): CliResult {
  const projects = useProjectsStore.getState().projects
  const groups = projects.flatMap((project) =>
    (project.groups ?? []).map((group) => {
      const panes = project.terminals.filter((terminal) => terminal.groupId === group.id)
      // A front created before the command line adopted worktrees carries none
      // of its own, while a pane inside it does. Reading only the front told
      // whoever asked — the `morning` skill among them — that the front occupies
      // no disk, which is the opposite of true.
      const owner = panes.find((pane) => pane.worktreeAgentId)
      const worktree = group.worktreeAgentId ?? owner?.worktreeAgentId
      const cwd = group.cwd ?? (group.worktreeAgentId ? undefined : owner?.cwd)
      return {
        id: group.id,
        name: group.name,
        project: project.name,
        projectId: project.id,
        panes: panes.length,
        refs: panes.map((pane) => pane.shortId ?? '').filter(Boolean),
        ...(worktree ? { worktree } : {}),
        ...(cwd ? { cwd } : {}),
      }
    }),
  )
  return { ok: true, data: { groups } }
}

type SessionCloseRequest = {
  target?: string
  /** The terminal already asked, so the window must not block on a second one. */
  confirmed?: boolean
}

/**
 * `arco session close <ref>` — closes one pane and leaves the front standing.
 *
 * The only way out of a pane used to be the interface or `arco group close`,
 * which takes the whole front with it. An agent asked to close the pane it just
 * opened had nothing to run.
 *
 * Two panes are refused rather than closed. The orchestrator goes when its front
 * goes — `deleteTerminal` refuses it anyway, and a silent no-op reads like a bug.
 * And a pane does not close itself: the process that would die is the one still
 * waiting to print the answer.
 */
function handleSessionClose(request: SessionCloseRequest & SessionScope): CliResult {
  const target = request.target?.trim() ?? ''
  if (!target) return failure('Informe o pane que quer fechar.')

  const match = matchSession({ ...request, session: target })
  if ('error' in match) return match.error
  if ('orphanId' in match) {
    return failure(`A sessão ${match.orphanId.slice(0, 8)} não está aberta neste perfil.`)
  }

  const { terminal, projectId } = match.entry
  const label = terminal.shortId ?? terminal.id.slice(0, 8)

  if (terminal.pinned) {
    return failure(
      `${label} é o orquestrador da frente e fecha junto com ela: arco group close ${label}.`,
    )
  }
  if (request.sessionId && terminal.id === request.sessionId) {
    return failure(
      `${label} é este pane. Feche-o pela interface, ou peça a outro pane: arco session send <ref> "fecha o ${label}".`,
    )
  }

  // A worktree of the pane's own is the pre-front shape, and it goes with the
  // pane the way the interface does it — `git worktree remove --force`, which
  // takes uncommitted work with it. The window would ask, but `window.confirm`
  // blocks the whole renderer and nobody is looking at it, so the question is
  // refused back to the terminal instead and `--yes` is the answer.
  const ownsWorktree = Boolean(terminal.worktreeAgentId)
  if (ownsWorktree && !request.confirmed) {
    return failure(
      `${label} tem worktree própria (${terminal.worktreeAgentId}) e fechá-lo apaga ela com --force. Repita com --yes se for isso mesmo.`,
    )
  }
  void useProjectsStore.getState().deleteTerminalWithWorktreeCleanup(projectId, terminal.id, {
    assumeConfirmed: request.confirmed,
  })

  return {
    ok: true,
    message: ownsWorktree
      ? `Fechando ${label} e a worktree ${terminal.worktreeAgentId}.`
      : `Fechando ${label}. A frente segue aberta.`,
    data: {
      sessionId: terminal.id,
      ref: terminal.shortId ?? null,
      worktree: terminal.worktreeAgentId ?? null,
    },
  }
}

type GroupCloseRequest = {
  target?: string
  /** The terminal already asked, so the window must not block on a second one. */
  confirmed?: boolean
}

/**
 * `arco group close <ref>` — closes a front of work and what it owns.
 *
 * The front is named by the reference of any session inside it, because that
 * is the id a person has at hand; a group id is a nanoid nobody reads.
 *
 * The command answers as soon as the decision is made. Removing a worktree
 * runs git twice with a wait in between and can outlast the eight seconds the
 * request has, and a front that closed is not made less closed by the CLI
 * having stopped listening.
 */
function handleGroupClose(request: GroupCloseRequest & SessionScope): CliResult {
  const target = request.target?.trim() ?? ''
  if (!target) return failure('Informe uma sessão da frente que quer fechar.')

  const match = matchSession({ ...request, session: target })
  if ('error' in match) return match.error
  if ('orphanId' in match) {
    return failure(`A sessão ${match.orphanId.slice(0, 8)} não está aberta neste perfil.`)
  }

  const { terminal, projectId } = match.entry
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const group = (project?.groups ?? []).find((item) => item.id === terminal.groupId)
  if (!group) {
    return failure(
      `A sessão ${terminal.shortId ?? terminal.id.slice(0, 8)} não está em nenhuma frente de trabalho.`,
    )
  }

  const panes = (project?.terminals ?? []).filter((item) => item.groupId === group.id)
  void useProjectsStore
    .getState()
    .closeGroupWithWorktree(projectId, group.id, { assumeConfirmed: request.confirmed })
  return {
    ok: true,
    message: group.worktreeAgentId
      ? `Fechando "${group.name}": ${panes.length} sessão(ões) e a worktree ${group.worktreeAgentId}.`
      : `Fechando "${group.name}": ${panes.length} sessão(ões). Nada sai do disco.`,
    data: { groupId: group.id, name: group.name, panes: panes.length },
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

  // The task comes first. A reference is bare digits far more often than it is
  // a pane — a PR number, an issue, a piece of a title — and answering "that is
  // a pane" to `arco todo edit 11299` refuses a task that exists.
  const { todo, ambiguous } = findTodoByRef(useProjectsStore.getState().todos, ref)
  if (todo) return { todo }
  if (ambiguous.length > 0) {
    const names = ambiguous
      .slice(0, 3)
      .map((item) => `${item.id.slice(0, 8)} ${item.title}`)
      .join('; ')
    return { error: failure(`"${ref}" corresponde a ${ambiguous.length} tarefas: ${names}…`) }
  }

  // Nothing answers as a task. `pa-3576` is a pane, and the agent that typed it
  // was told to send something there; saying only "no task found" sends it
  // hunting through files for what the reference means, which is what happened.
  const asPane = normalizePaneRef(ref)
  const pane = asPane
    ? sessionEntries().find((entry) => entry.terminal.shortId === asPane)
    : undefined
  if (pane) {
    return {
      error: failure(
        `${asPane} é um pane, não uma tarefa. Para mandar texto: arco session send ${asPane} <texto>. Para ver os panes: arco session list.`,
      ),
    }
  }
  // Bare digits that match no pane are just a reference that missed. Only the
  // written `pa-` prefix says the person meant a pane.
  if (asPane && ref.toLowerCase().startsWith('pa-')) {
    return {
      error: failure(
        `${asPane} tem cara de referência de pane, não de tarefa, e nenhum pane atende por ela. Veja os panes abertos com arco session list.`,
      ),
    }
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
    listen<SessionRequest & SessionScope & CliRequest>(
      'cli://session-new',
      answer<SessionRequest & SessionScope & CliRequest>(handleSession),
    ),
    listen<SessionScope & CliRequest>(
      'cli://session-list',
      answer<SessionScope & CliRequest>(handleSessionList),
    ),
    listen<CliRequest>('cli://group-list', answer<CliRequest>(handleGroupList)),
    listen<GroupCloseRequest & SessionScope & CliRequest>(
      'cli://group-close',
      answer<GroupCloseRequest & SessionScope & CliRequest>(handleGroupClose),
    ),
    listen<SessionCloseRequest & SessionScope & CliRequest>(
      'cli://session-close',
      answer<SessionCloseRequest & SessionScope & CliRequest>(handleSessionClose),
    ),
    listen<SessionSendRequest & SessionScope & CliRequest>(
      'cli://session-send',
      answer<SessionSendRequest & SessionScope & CliRequest>(handleSessionSend),
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
