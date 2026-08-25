export type AgentType =
  'shell' | 'claude' | 'codex' | 'copilot' | 'opencode' | 'freebuff' | 'mimo' | 'antigravity'

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  mimo: 'Mimo',
  freebuff: 'Freebuff',
  shell: 'Shell',
}

export const ALL_AGENT_TYPES: AgentType[] = [
  'claude',
  'codex',
  'copilot',
  'antigravity',
  'opencode',
  'mimo',
  'freebuff',
  'shell',
]

export function agentCliCommand(agent: AgentType): string | undefined {
  if (agent === 'shell') return undefined
  return agent === 'antigravity' ? 'agy' : agent
}

export type Locale = 'en' | 'pt-BR'

export type Theme =
  | 'dark'
  | 'light'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'tokyo-night'
  | 'vscode'
  | 'min-dark'
  | 'min-light'
  | 'dark-lemon'
  | 'orca'
  | 'ember'
  | 'golden-premium'

/** Native desktop icon variants. The UI theme and app icon theme are independent. */
export type AppIconTheme =
  Exclude<Theme, 'ember' | 'golden-premium'> | 'arco-blue-gradient' | 'arco-pink-gradient'

export type VisualStyle = 'normal' | 'clean'

export type FeatureId = 'todos' | 'git' | 'browser' | 'graphify' | 'aiMemory' | 'mcp'

/** Task urgency. Drives the colored marker and the ordering hint in the sidebar. */
export type TodoPriority = 'low' | 'normal' | 'high'

export const TODO_PRIORITIES: TodoPriority[] = ['high', 'normal', 'low']

/**
 * Where a task stands. `completed` remains the flag the list is split by, and
 * `done` is its mirror: the two are always set together, so nothing that reads
 * the old field has to learn about this one.
 */
export type TodoStatus = 'todo' | 'in_progress' | 'review' | 'done'

export const TODO_STATUSES: TodoStatus[] = ['todo', 'in_progress', 'review', 'done']

/** An agent session that was launched from a task, kept so the task can jump back to it. */
export type TodoSessionLink = {
  projectId: string
  terminalId: string
  agent: AgentType
  startedAt: number
}

/**
 * The session a task belongs to, recorded from the command line.
 *
 * Not the same thing as `sessions`: those are jump-back links and are dropped
 * the moment the pane they point at closes. This one is provenance — it answers
 * "which session produced this task" long after the pane is gone, so it outlives
 * the pane and keeps the name and directory it was linked from.
 */
export type TodoSessionOwner = {
  /** Pane id, the same value `ARCO_SESSION_ID` carries inside the session. */
  id: string
  projectId?: string
  agent?: AgentType
  name?: string
  cwd?: string
  linkedAt: number
}

/** Structured link to an Azure DevOps work item and, optionally, its pull request. */
export type TodoAdoRef = {
  org: string
  project: string
  workItemId: number
  prId?: number
  repository?: string
  /**
   * The ADO project the pull request lives in, when it is not the work item's.
   * Boards and code routinely sit in different projects — a work item in
   * "Plataforma EMR" pointing at a pull request in "SOA" — and a single
   * `project` cannot address both. Absent means the two share a project.
   */
  prProject?: string
}

export type TodoItem = {
  id: string
  title: string
  completed: boolean
  tags: string[]

  projectId?: string
  /** Extra context handed to the agent when a session is started from this task. */
  notes?: string
  priority?: TodoPriority
  /** Kept in step with `completed`: `done` there, anything else here means open. */
  status?: TodoStatus
  createdAt?: number
  completedAt?: number
  /** Sessions launched from this task, newest first. */
  sessions?: TodoSessionLink[]
  /** The session that claimed this task. Survives the pane, unlike `sessions`. */
  session?: TodoSessionOwner
  /** Azure DevOps work item and pull request the task points at. Drawn as a chip on the row. */
  adoRef?: TodoAdoRef
}

export type SubTab = {
  id: string
  type: AgentType
  name: string
  cwd: string

  lastUsedAt?: number

  ptyId: string | null

  completionUnread?: boolean

  sessionId?: string
  /** Args extras passados pro launcher (ex: --dangerously-skip-permissions). */
  extraArgs?: string[]

  initialInput?: string
  /** One-shot context packet used to bootstrap a cross-provider session. */
  handoff?: AgentHandoffBootstrap

  runtimeProfile?: AgentRuntimeProfile
}

export type AgentHandoffBootstrap = {
  id: string
  contextDir: string
  contextPath: string
  sourceProvider: 'claude' | 'codex'
  sourceSessionId: string
}

export type AgentRuntimeProfile = 'full' | 'lean' | 'diagnostic'

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */
export const UNRESTRICTED_FLAG: Record<AgentType, string | null> = {
  shell: null,
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  copilot: '--allow-all',
  opencode: '--dangerously-skip-permissions',

  freebuff: null,
  mimo: null,
  antigravity: '--dangerously-skip-permissions',
}

export type PaneKind =
  'terminal' | 'markdown' | 'file' | 'image' | 'video' | 'web' | 'graphify' | 'diff'

export type BrowserResourceMode = 'app-first' | 'balanced' | 'keep-alive'

export type BrowserPaneConfig = {
  /** Whether scripts may run in the private webview. Defaults to true. */
  javascriptEnabled?: boolean
  /** Page zoom applied to the private webview. Defaults to 1. */
  zoom?: number
  /** How aggressively a hidden native webview is released. Defaults to app-first. */
  resourceMode?: BrowserResourceMode
}

export type BrowserPaneOptions = BrowserPaneConfig & {
  url: string
  name?: string
}

export type Terminal = {
  id: string
  name: string
  cwd: string
  tabs: SubTab[]
  activeTabId: string
  disabled: boolean

  lastUsedAt?: number

  kind?: PaneKind

  filePath?: string

  url?: string
  /** Runtime settings for a private native browser pane. */
  browserConfig?: BrowserPaneConfig

  worktreeAgentId?: string

  staged?: boolean

  gsdSyncViewer?: boolean
  /** Hides this terminal and its output from every paired remote device. */
  remoteExcluded?: boolean
}

export type OrphanWorktree = {
  path: string
  mode: 'gitWorktree' | 'localCopy'

  requiresRawDeletion?: boolean

  pruneOnly?: boolean

  cleanAttempts?: number
  /** Motivo do lock administrativo (`git worktree lock`), se for esse o bloqueio atual. */
  adminLockReason?: string
}

export type Project = {
  id: string
  name: string
  /** Determines which workspace opens when the project is selected. */
  mode?: 'standard' | 'agentSandbox'
  color?: string

  iconUrl?: string

  defaultCwd?: string
  terminals: Terminal[]

  markdownComments?: MarkdownComment[]
  collapsed: boolean
  /** Hidden from the sidebar until restored from Preferences. */
  archived?: boolean
  createdAt: number
  // --- RFC-009 / RFC-003 — Multi-Agent settings ---
  worktreeMode?: 'gitWorktree' | 'localCopy'
  validationCommands?: string[]
  gsdWatcherEnabled?: boolean

  conflictAgentProvider?: AgentType

  conflictAgentModel?: string

  reviewAgentProvider?: AgentType

  reviewAgentModel?: string

  graphifyEnabled?: boolean

  /**
   * Whether a new agent session gets its own worktree. Absent means yes: an
   * agent editing the checkout everything else shares is the costly default,
   * and unchecking the box is one click for the times it is wanted.
   */
  autoWorktree?: boolean

  githubUrl?: string

  firstBootPending?: boolean

  orphanWorktrees?: OrphanWorktree[]
}

export type MarkdownComment = {
  id: string
  path: string
  quote: string
  note: string
  start: number
  end: number
  createdAt: number
}

export type WorkspaceContainer = {
  projectId: string

  /** Every session open in this project, in the order the tab bar shows them. */
  paneIds: string[]

  /** The session filling the screen. Null only while the project has no panes. */
  activePaneId: string | null

  /**
   * A second terminal next to the active session, for running a command without
   * leaving it. At most one, and only ever a pane of kind `terminal`.
   */
  sidePaneId?: string | null

  lastUsedAt?: number

  size: number
  collapsed: boolean
}

export type WorkspaceRecentTab = {
  kind: 'project'
  id: string
}

export type WorkspaceTabKind = 'project' | 'terminal'

export type WorkspaceViewSnapshot = {
  /** Always a single container, owned by the tab's project. */
  containers: WorkspaceContainer[]
  activeProjectId: string | null
  focusedTerminalId: string | null
  fullscreenContainerId: string | null
}

export type WorkspaceTab = {
  id: string
  kind: WorkspaceTabKind
  /** Project that owns the tab. Every pane inside it belongs to this project. */
  projectId: string
  /** Terminal the tab was opened for. Only set when `kind` is 'terminal'. */
  terminalId?: string
  label: string
  color?: string
  iconUrl?: string

  pinned?: boolean
  snapshot: WorkspaceViewSnapshot
  createdAt: number
  updatedAt: number
}

export type WorkspaceHistoryEntry = {
  id: string
  tabId: string
  label: string
  snapshot: WorkspaceViewSnapshot
  visitedAt: number
}

/** Per-session worktree choice. `inherit` defers to the project's autoWorktree flag. */
export type WorktreeChoice = 'inherit' | 'new' | 'none'

export type TerminalCreationPreset = {
  name: string
  cwd: string
  firstTab: {
    type: AgentType
    cwd: string
    extraArgs?: string[]
    runtimeProfile?: AgentRuntimeProfile
  }
}

export type Preferences = {
  /** Idioma da UI. Default 'en'. */
  language: Locale
  uiTheme: Theme
  /** Application-wide visual language. Normal preserves the production UI. */
  visualStyle: VisualStyle
  /** Native desktop icon theme. Defaults to Dark independently from the UI theme. */
  appIconTheme: AppIconTheme
  /** Zoom global da WebView. 1 = 100%. */
  uiZoom: number

  windowOpacity: number
  terminalTheme: Theme | null
  enabledAgents: Record<AgentType, boolean>
  onboardingDone: boolean
  /** Project id of the container rendered fullscreen, or null. */
  fullscreenContainerId: string | null

  firstLaunchAt: number | null
  /** Nome exibido no welcome modal. */
  displayName: string
  /** URL da foto de perfil escolhida no cadastro local. */
  profileImageUrl: string

  accountCreated: boolean

  alwaysStartOnHome: boolean

  alwaysStartUnrestricted: boolean
  /** Last terminal configuration submitted through the creation modal. */
  lastTerminalCreation: TerminalCreationPreset | null

  topbarStyle: 'classic' | 'three-areas'
  /** Local do controle Git: sidebar esquerda ou direita. */
  gitControlPlacement: 'left' | 'right'

  /** Itens opcionais exibidos no canto direito da topbar. */
  topbarShowClaudeUsage: boolean
  topbarShowCodexUsage: boolean
  topbarShowAntigravityUsage: boolean
  topbarShowSync: boolean
  topbarShowProfile: boolean
  topbarShowMemory: boolean
  /** Starts the LAN remote listener on launch. Off until the user opts in. */
  remoteEnabled: boolean
  /** Maximum number of authenticated LAN remote devices. Default 1. */
  remoteMaxDevices: number
  /** Remote session lifetime in seconds. Default 1 hour. */
  remoteSessionExpirySecs: number
  /** Paired devices can read terminals but never send input. Default true. */
  remoteReadOnly: boolean
  /** Allows remote input on plain shell tabs, not only agent tabs. Default false. */
  remoteAllowShellInput: boolean

  enabledFeatures: Record<FeatureId, boolean>
  /** Folder configured as the base location for the global Todo list. */
  todoStoragePath: string
  /** Scope the MCP panel opens on. */
  mcpDefaultScope: McpScope
  /** True once the MCP setup prompt has been shown or dismissed. */
  mcpOnboardingSeen: boolean

  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  leftSidebarWidth: number
  rightSidebarWidth: number

  notifyOnLimitReset: boolean
  /**
   * Tells agents started here that the `arco` command exists and what it can do,
   * so they can keep their own task up to date. Default true; off leaves the
   * session exactly as the agent would start it outside Arco.
   */
  cliContextInjection: boolean
  /**
   * Azure DevOps defaults used when a task reference is a bare id (`#22447`).
   * A full URL carries its own organization and project; the CLI shorthand needs
   * somewhere to resolve them from.
   */
  adoOrg: string
  adoProject: string
  /**
   * Personal Access Token, used by one thing only: asking Azure DevOps where a
   * linked pull request lives, so a chip stored with the wrong project stops
   * opening "Repository not found". Nothing polls with it. Kept in plaintext
   * alongside the other tokens.
   */
  adoPat: string
  /** Ditado por voz (speech-to-text) escreve no terminal ativo. Default false. */
  dictationEnabled: boolean
  /** Hold dita enquanto o atalho fica pressionado; toggle liga e desliga a cada toque. */
  dictationMode?: 'hold' | 'toggle'
  /** Atalho do ditado, normalizado como `ctrl+shift+e`. Default `ctrl+e`. */
  dictationShortcut?: string
  /** Id do modelo de voz ativo, do catálogo em `lib/speechCatalog.ts`. */
  dictationModel?: string
  /** Quantos PTYs podem ser spawnados em paralelo (fila global). Default 3. */
  spawnConcurrency: number

  resourcePolicy: ResourcePolicyPreferences

  nativeTerminalMacos?: boolean
  /**
   * v3 — perfil de heap do Node.js para agentes (Claude, Codex, OpenCode).
   * Injeta --max-old-space-size e UV_THREADPOOL_SIZE no ambiente do PTY.
   */
  nodeHeapProfile?: 'conservative' | 'balanced' | 'performance'

  gsdSyncModelChain?: string[]
}

export type ResourcePolicyMode = 'smart-lru' | 'manual'

export type ResourcePolicyPreferences = {
  mode: ResourcePolicyMode
  /** True only after the user explicitly enables automatic runtime parking. */
  automaticParkingOptIn: boolean
  memoryBudgetMb: number
  warningThresholdMb: number
  recoveryTargetMb: number
  hiddenAgentIdleMinutes: number
  hiddenShellIdleMinutes: number
  spawnGraceSeconds: number
}

export type ProjectsFile = {
  version: 9
  /** Project order in the sidebar. */
  projectOrder: string[]
  projects: Project[]

  todos: TodoItem[]
  activeProjectId: string | null

  workspace: {
    containers: WorkspaceContainer[]

    recentProjectIds: string[]

    recentTabs: WorkspaceRecentTab[]

    tabs: WorkspaceTab[]

    closedTabs?: WorkspaceTab[]
    activeTabId: string | null
    focusedTerminalId: string | null
    history: WorkspaceHistoryEntry[]
    historyIndex: number
  }
  preferences: Preferences
  cliPaths: Partial<Record<AgentType, string>>
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: 'en',
  uiTheme: 'dark',
  visualStyle: 'normal',
  appIconTheme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
  terminalTheme: null,
  enabledAgents: {
    shell: true,
    claude: true,
    codex: true,
    copilot: true,
    antigravity: true,
    opencode: true,
    freebuff: true,
    mimo: true,
  },
  onboardingDone: false,
  fullscreenContainerId: null,
  firstLaunchAt: null,
  displayName: '',
  profileImageUrl: '',
  accountCreated: false,
  alwaysStartOnHome: false,
  alwaysStartUnrestricted: false,
  lastTerminalCreation: null,
  topbarStyle: 'classic',
  gitControlPlacement: 'left',
  topbarShowClaudeUsage: true,
  topbarShowCodexUsage: true,
  topbarShowAntigravityUsage: true,
  topbarShowSync: true,
  topbarShowProfile: true,
  topbarShowMemory: true,
  remoteEnabled: false,
  remoteMaxDevices: 1,
  remoteSessionExpirySecs: 3600,
  remoteReadOnly: true,
  remoteAllowShellInput: false,
  enabledFeatures: {
    todos: true,
    git: true,
    browser: true,
    graphify: true,
    aiMemory: false,
    mcp: true,
  },
  todoStoragePath: '',
  mcpDefaultScope: 'global',
  mcpOnboardingSeen: false,
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  leftSidebarWidth: 286,
  rightSidebarWidth: 300,
  notifyOnLimitReset: true,
  cliContextInjection: true,
  adoOrg: '',
  adoProject: '',
  adoPat: '',
  dictationEnabled: false,
  dictationMode: 'hold',
  dictationShortcut: 'ctrl+e',
  dictationModel: 'parakeet-tdt-0.6b-v3-int8',
  spawnConcurrency: 3,
  resourcePolicy: {
    mode: 'manual',
    automaticParkingOptIn: false,
    memoryBudgetMb: 1536,
    warningThresholdMb: 1229,
    recoveryTargetMb: 1152,
    hiddenAgentIdleMinutes: 15,
    hiddenShellIdleMinutes: 30,
    spawnGraceSeconds: 120,
  },
  nodeHeapProfile: 'balanced',
}

export const EMPTY_PROJECTS_FILE: ProjectsFile = {
  version: 9,
  projectOrder: [],
  projects: [],
  todos: [],
  activeProjectId: null,
  workspace: {
    containers: [],
    recentProjectIds: [],
    recentTabs: [],
    tabs: [],
    closedTabs: [],
    activeTabId: null,
    focusedTerminalId: null,
    history: [],
    historyIndex: -1,
  },
  preferences: DEFAULT_PREFERENCES,
  cliPaths: {},
}

export type PtyStatus = 'working' | 'waiting' | 'stopped' | 'disabled' | 'offline'

export const PROJECT_COLORS = [
  '#6ea8ff',
  '#22d3ee',
  '#a78bfa',
  '#34d399',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#10b981',
] as const

export const PROVIDER_MODELS: Record<AgentType, { id: string; label: string }[]> = {
  claude: [
    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet (Padrão)' },
    { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus', label: 'Claude 3 Opus' },
  ],
  codex: [
    { id: 'gpt-4o', label: 'GPT-4o (Padrão)' },
    { id: 'o3-mini', label: 'o3-mini (Raciocínio)' },
    { id: 'o1', label: 'o1 (Avançado)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  ],
  copilot: [],
  opencode: [
    { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (Raciocínio)' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
    { id: 'qwen/qwen-2.5-coder-32b', label: 'Qwen 2.5 Coder 32B' },
    { id: 'meta-llama/llama-3.3-70b', label: 'Llama 3.3 70B' },
  ],
  antigravity: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Padrão)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
  ],
  mimo: [
    { id: 'mimo-pro', label: 'Mimo Pro' },
    { id: 'mimo-flash', label: 'Mimo Flash' },
  ],
  freebuff: [{ id: 'freebuff-auto', label: 'Freebuff Auto' }],
  shell: [{ id: 'default', label: 'Shell Padrão' }],
}

export type McpScope = 'global' | 'project'

export type McpAgent = Extract<AgentType, 'claude' | 'codex' | 'opencode' | 'antigravity'>

export const MCP_AGENTS: McpAgent[] = ['claude', 'codex', 'opencode', 'antigravity']

/** Literal values never leave Rust: `preview` is masked, use mcpRevealEnv for the real one. */
export type McpEnvEntry = {
  literal: { preview: string; empty: boolean } | null
  passthroughFrom: string | null
}

export type McpTransport =
  | { kind: 'stdio'; command: string; args: string[]; cwd: string | null }
  | { kind: 'http'; url: string; headers: Record<string, McpEnvEntry> }
  | { kind: 'sse'; url: string; headers: Record<string, McpEnvEntry> }

export type McpTimeouts = {
  startupSecs: number | null
  toolSecs: number | null
}

export type McpServer = {
  name: string
  transport: McpTransport
  env: Record<string, McpEnvEntry>
  enabled: boolean
  timeouts: McpTimeouts
  bearerTokenEnvVar: string | null
}

/**
 * `local` is Claude's default `claude mcp add` target: the servers it keeps inside
 * `~/.claude.json` under `projects.<cwd>` rather than in the repo's `.mcp.json`.
 */
export type McpSourceKind = 'user' | 'local' | 'project'

export type McpSourceState = {
  kind: McpSourceKind
  path: string
  exists: boolean
  writable: boolean
  parseError: string | null
  mtimeMs: number
}

export type McpServerRecord = {
  server: McpServer
  agent: McpAgent
  scope: McpScope
  sourceKind: McpSourceKind
  sourcePath: string
  managedByImport: string | null
}

export type McpAgentSnapshot = {
  agent: McpAgent
  scope: McpScope
  sources: McpSourceState[]
  servers: McpServerRecord[]
}

export type McpCapability = {
  agent: McpAgent
  projectScope: boolean
  enabledFlag: boolean
  envPassthrough: boolean
  timeouts: boolean
  headers: boolean
  remote: boolean
}
