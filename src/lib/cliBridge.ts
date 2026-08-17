import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
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
function resolveProjectId(request: SessionRequest | TodoRequest): string | null {
  const { projects, activeProjectId } = useProjectsStore.getState()
  const wanted = request.project?.trim().toLowerCase()
  if (wanted) {
    const match = projects.find(
      (project) =>
        project.id === request.project || project.name.trim().toLowerCase() === wanted,
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
  const store = useProjectsStore.getState()
  store.createTodo(title, request.tags ?? [], resolveProjectId(request) ?? undefined, {
    notes: request.notes,
    priority: request.priority,
  })
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
  ])
  return () => unlisteners.forEach((dispose) => dispose())
}
