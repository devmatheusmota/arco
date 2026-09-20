import { nanoid } from 'nanoid'

import { normalizeAdoRef } from '../lib/adoRef'
import { normalizeEnabledFeatures } from '../lib/features'
import { generatePaneShortId, isPaneShortId } from '../lib/paneShortId'
import { isGenericSessionName } from '../lib/sessionLabel'
import {
  normalizeTodoNotes,
  normalizeTodoPriority,
  normalizeTodoSessionOwner,
  normalizeTodoSessions,
  normalizeTodoStatus,
  normalizeTodoTags,
  normalizeTodoTitle,
} from '../lib/todos'
import {
  DEFAULT_PREFERENCES,
  EMPTY_PROJECTS_FILE,
  type Preferences,
  type Project,
  type ProjectsFile,
  type Terminal,
  type TodoItem,
  type WorkspaceContainer,
  type WorkspaceRecentTab,
  type WorkspaceTab,
  type WorkspaceViewSnapshot,
} from '../lib/types'
import {
  cloneWorkspaceSnapshot,
  enforceTabScope,
  MAX_WORKSPACE_HISTORY,
  MAX_WORKSPACE_TABS,
  sanitizeWorkspaceSnapshot,
} from '../lib/workspaceNavigation'
import {
  clampSpawnConcurrency,
  clampUiZoom,
  MAX_RECENT_PROJECT_TABS,
} from './projectsStore.constants'

type LegacyPreferences = Partial<Preferences> & { showGitControl?: boolean }

/**
 * A file part-way up the chain: the current shape, but still carrying the
 * version number of the step that produced it.
 */
type PartiallyMigratedFile = Omit<ProjectsFile, 'version'> & { version: number }

function normalizeStoredAccent(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback
  return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : fallback
}

function normalizeStoredAccents(file: ProjectsFile): ProjectsFile {
  const normalizeTab = (tab: WorkspaceTab): WorkspaceTab => ({
    ...tab,
    color: normalizeStoredAccent(tab.color),
  })

  return {
    ...file,
    projects: file.projects.map((project) => ({
      ...project,
      color: normalizeStoredAccent(project.color),
    })),
    workspace: {
      ...file.workspace,
      tabs: file.workspace.tabs.map(normalizeTab),
      closedTabs: file.workspace.closedTabs?.map(normalizeTab),
    },
  }
}

export function normalizePreferences(raw: LegacyPreferences | undefined): Preferences {
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...(raw ?? {}),
  } as Preferences & {
    showGitControl?: boolean
    workspaceFlat?: boolean
    workspaceGridLayout?: unknown
    workspaceGridLayoutHistory?: unknown
  }
  delete preferences.showGitControl
  // Removed in v8: these only existed to arrange several projects on one screen.
  delete preferences.workspaceFlat
  delete preferences.workspaceGridLayout
  delete preferences.workspaceGridLayoutHistory
  const rawResourcePolicy = raw?.resourcePolicy
  const resourcePolicy = {
    ...DEFAULT_PREFERENCES.resourcePolicy,
    ...(rawResourcePolicy ?? {}),
  }
  const memoryBudgetMb = Math.min(8192, Math.max(768, Math.round(resourcePolicy.memoryBudgetMb)))
  const warningThresholdMb = Math.min(
    memoryBudgetMb - 64,
    Math.max(512, Math.round(resourcePolicy.warningThresholdMb)),
  )
  const recoveryTargetMb = Math.min(
    warningThresholdMb - 64,
    Math.max(384, Math.round(resourcePolicy.recoveryTargetMb)),
  )
  const legacyAccountCreated =
    raw?.accountCreated ??
    Boolean(raw?.onboardingDone && raw?.displayName && raw.displayName.trim().length > 0)
  const rawWindowOpacity = Number(raw?.windowOpacity ?? 1)
  return {
    ...preferences,
    windowOpacity: Number.isFinite(rawWindowOpacity)
      ? Math.min(1, Math.max(0.6, rawWindowOpacity))
      : 1,

    enabledAgents: { ...DEFAULT_PREFERENCES.enabledAgents, ...preferences.enabledAgents },

    enabledFeatures: normalizeEnabledFeatures(raw),
    leftSidebarVisible: raw?.leftSidebarVisible ?? true,
    rightSidebarVisible: raw?.rightSidebarVisible ?? true,
    leftSidebarWidth: Math.min(380, Math.max(220, Math.round(raw?.leftSidebarWidth ?? 286))),
    rightSidebarWidth: Math.min(420, Math.max(260, Math.round(raw?.rightSidebarWidth ?? 300))),
    language: preferences.language === 'pt-BR' ? 'pt-BR' : 'en',
    visualStyle: raw?.visualStyle === 'clean' ? 'clean' : 'normal',
    accountCreated: legacyAccountCreated,
    topbarStyle: preferences.topbarStyle === 'three-areas' ? 'three-areas' : 'classic',
    gitControlPlacement: preferences.gitControlPlacement === 'right' ? 'right' : 'left',
    mcpDefaultScope: preferences.mcpDefaultScope === 'project' ? 'project' : 'global',
    mcpOnboardingSeen: Boolean(preferences.mcpOnboardingSeen),
    displayName: preferences.displayName.trim(),
    profileImageUrl: preferences.profileImageUrl.trim(),
    todoStoragePath: preferences.todoStoragePath.trim(),
    adoOrg: (preferences.adoOrg ?? '').trim(),
    adoProject: (preferences.adoProject ?? '').trim(),
    adoPat: (preferences.adoPat ?? '').trim(),
    uiZoom: clampUiZoom(preferences.uiZoom),
    spawnConcurrency: clampSpawnConcurrency(preferences.spawnConcurrency),
    resourcePolicy: {
      // Automatic parking was removed. Keep the legacy shape for file
      // compatibility, but normalize every installation to monitoring only.
      mode: 'manual',
      automaticParkingOptIn: false,
      memoryBudgetMb,
      warningThresholdMb,
      recoveryTargetMb,
      hiddenAgentIdleMinutes: Math.min(
        240,
        Math.max(5, Math.round(resourcePolicy.hiddenAgentIdleMinutes)),
      ),
      hiddenShellIdleMinutes: Math.min(
        480,
        Math.max(5, Math.round(resourcePolicy.hiddenShellIdleMinutes)),
      ),
      spawnGraceSeconds: Math.min(900, Math.max(30, Math.round(resourcePolicy.spawnGraceSeconds))),
    },
  }
}

export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: TodoItem[] = []
  for (const item of raw) {
    const id = typeof item?.id === 'string' ? item.id : ''
    const title = normalizeTodoTitle(item?.title)
    if (!id || !title || seen.has(id)) continue
    seen.add(id)
    const notes = normalizeTodoNotes(item?.notes)
    const sessions = normalizeTodoSessions(item?.sessions)
    const session = normalizeTodoSessionOwner(item?.session)
    const adoRef = normalizeAdoRef(item?.adoRef)
    const completed = Boolean(item?.completed)
    result.push({
      id,
      title,
      completed,
      tags: normalizeTodoTags(item?.tags),
      priority: normalizeTodoPriority(item?.priority),
      status: normalizeTodoStatus(item?.status, completed),
      createdAt: typeof item?.createdAt === 'number' ? item.createdAt : Date.now(),
      ...(completed && typeof item?.completedAt === 'number'
        ? { completedAt: item.completedAt }
        : {}),
      ...(typeof item?.projectId === 'string' && item.projectId
        ? { projectId: item.projectId }
        : {}),
      ...(notes ? { notes } : {}),
      ...(sessions.length > 0 ? { sessions } : {}),
      ...(session ? { session } : {}),
      ...(adoRef ? { adoRef } : {}),
    })
  }
  return [...result.filter((item) => !item.completed), ...result.filter((item) => item.completed)]
}

function normalizeStoredContainers(raw: unknown): WorkspaceContainer[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => typeof item?.projectId === 'string' && Array.isArray(item?.paneIds))
    .map((item) => ({
      projectId: item.projectId,
      paneIds: item.paneIds.filter((id: unknown) => typeof id === 'string'),
      lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : undefined,
      size: typeof item.size === 'number' ? item.size : 0,
      activePaneId: typeof item.activePaneId === 'string' ? item.activePaneId : null,
      sidePaneId: typeof item.sidePaneId === 'string' ? item.sidePaneId : null,
      collapsed: Boolean(item.collapsed),
    }))
    .map((container) => ({
      ...container,
      // A container written before v9 listed every pane of a grid and named none
      // of them: the first one takes the screen.
      activePaneId:
        container.activePaneId && container.paneIds.includes(container.activePaneId)
          ? container.activePaneId
          : (container.paneIds[0] ?? null),
      sidePaneId:
        container.sidePaneId && container.paneIds.includes(container.sidePaneId)
          ? container.sidePaneId
          : null,
    }))
}

/** Reads a snapshot of any older shape, dropping the fields that no longer exist. */
function normalizeStoredSnapshot(raw: any): WorkspaceViewSnapshot {
  return {
    containers: normalizeStoredContainers(raw?.containers),
    activeProjectId: typeof raw?.activeProjectId === 'string' ? raw.activeProjectId : null,
    focusedTerminalId: typeof raw?.focusedTerminalId === 'string' ? raw.focusedTerminalId : null,
    fullscreenContainerId:
      typeof raw?.fullscreenContainerId === 'string' ? raw.fullscreenContainerId : null,
  }
}

/**
 * Splits every stored tab into one tab per project it held. Group and composition tabs — the two
 * kinds that mixed projects in a single view — become one tab per project, keeping the original id
 * on the first so history and pins survive.
 */
function explodeStoredTabs(rawTabs: unknown, projects: Project[]): WorkspaceTab[] {
  if (!Array.isArray(rawTabs)) return []
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const byKey = new Map<string, WorkspaceTab>()
  for (const rawTab of rawTabs) {
    const snapshot = sanitizeWorkspaceSnapshot(normalizeStoredSnapshot(rawTab?.snapshot), projects)
    const legacyTerminalId =
      rawTab?.kind === 'terminal'
        ? typeof rawTab?.terminalId === 'string'
          ? rawTab.terminalId
          : typeof rawTab?.sourceId === 'string'
            ? rawTab.sourceId
            : undefined
        : undefined
    snapshot.containers.forEach((container, index) => {
      const project = projectsById.get(container.projectId)
      if (!project) return
      const terminalId =
        legacyTerminalId && container.paneIds.includes(legacyTerminalId)
          ? legacyTerminalId
          : undefined
      const key = `${container.projectId}::${terminalId ?? 'project'}`
      const scoped = enforceTabScope({ ...snapshot, containers: [container] }, container.projectId)
      const stamp = typeof rawTab?.updatedAt === 'number' ? rawTab.updatedAt : Date.now()
      const previous = byKey.get(key)
      if (previous) {
        // Two old tabs held the same project: keep one and union their panes.
        byKey.set(key, {
          ...previous,
          snapshot: {
            ...previous.snapshot,
            containers: previous.snapshot.containers.map((existing) => ({
              ...existing,
              paneIds: [...new Set([...existing.paneIds, ...container.paneIds])],
            })),
          },
          pinned: previous.pinned || Boolean(rawTab?.pinned),
          updatedAt: Math.max(previous.updatedAt, stamp),
        })
        return
      }
      byKey.set(key, {
        id: index === 0 && typeof rawTab?.id === 'string' ? rawTab.id : nanoid(),
        kind: terminalId ? 'terminal' : 'project',
        projectId: container.projectId,
        ...(terminalId ? { terminalId } : {}),
        label: terminalId
          ? (project.terminals.find((terminal) => terminal.id === terminalId)?.name ?? project.name)
          : project.name,
        color: project.color,
        iconUrl: project.iconUrl,
        ...(index === 0 && rawTab?.pinned ? { pinned: true } : {}),
        snapshot: scoped,
        createdAt: typeof rawTab?.createdAt === 'number' ? rawTab.createdAt : stamp,
        updatedAt: stamp,
      })
    })
  }
  return [...byKey.values()].slice(0, MAX_WORKSPACE_TABS)
}

/** Rebuilds tabs from the open containers, for files old enough to predate the tab bar. */
function tabsFromContainers(containers: WorkspaceContainer[], projects: Project[]): WorkspaceTab[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const now = Date.now()
  return containers
    .flatMap((container, index) => {
      const project = projectsById.get(container.projectId)
      if (!project) return []
      return [
        {
          id: nanoid(),
          kind: 'project' as const,
          projectId: project.id,
          label: project.name,
          color: project.color,
          iconUrl: project.iconUrl,
          snapshot: enforceTabScope(
            {
              containers: [container],
              activeProjectId: project.id,
              focusedTerminalId: null,
              fullscreenContainerId: null,
            },
            project.id,
          ),
          createdAt: now + index,
          updatedAt: now + index,
        },
      ]
    })
    .slice(0, MAX_WORKSPACE_TABS)
}

export function migrateWorkspaceNavigation(base: {
  workspace?: any
  projects: Project[]
  activeProjectId: string | null
  preferences: Preferences
}) {
  const rawWorkspace = base.workspace ?? {}
  const storedContainers = sanitizeWorkspaceSnapshot(
    normalizeStoredSnapshot({
      containers: rawWorkspace.containers,
      activeProjectId: base.activeProjectId,
      focusedTerminalId: rawWorkspace.focusedTerminalId,
      fullscreenContainerId: base.preferences.fullscreenContainerId,
    }),
    base.projects,
  ).containers

  const tabs = Array.isArray(rawWorkspace.tabs)
    ? explodeStoredTabs(rawWorkspace.tabs, base.projects)
    : tabsFromContainers(storedContainers, base.projects)

  const closedTabs = explodeStoredTabs(rawWorkspace.closedTabs, base.projects)
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
  const activeTab =
    tabsById.get(rawWorkspace.activeTabId) ??
    tabs.find((tab) => tab.projectId === base.activeProjectId) ??
    tabs[0] ??
    null

  const history = (Array.isArray(rawWorkspace.history) ? rawWorkspace.history : [])
    .flatMap((entry: any) => {
      const tab = tabsById.get(entry?.tabId)
      if (!tab) return []
      return [
        {
          id: typeof entry.id === 'string' ? entry.id : nanoid(),
          tabId: tab.id,
          label: tab.label,
          snapshot: enforceTabScope(
            sanitizeWorkspaceSnapshot(normalizeStoredSnapshot(entry.snapshot), base.projects),
            tab.projectId,
          ),
          visitedAt: typeof entry.visitedAt === 'number' ? entry.visitedAt : Date.now(),
        },
      ]
    })
    .slice(-MAX_WORKSPACE_HISTORY)
  const seededHistory =
    history.length > 0 || !activeTab
      ? history
      : [
          {
            id: nanoid(),
            tabId: activeTab.id,
            label: activeTab.label,
            snapshot: cloneWorkspaceSnapshot(activeTab.snapshot),
            visitedAt: Date.now(),
          },
        ]

  return {
    containers: activeTab ? cloneWorkspaceSnapshot(activeTab.snapshot).containers : [],
    recentProjectIds: (rawWorkspace.recentProjectIds ?? []).slice(0, MAX_RECENT_PROJECT_TABS),
    recentTabs: (
      rawWorkspace.recentTabs ??
      (rawWorkspace.recentProjectIds ?? []).map((id: string) => ({ kind: 'project', id }))
    ).slice(0, MAX_RECENT_PROJECT_TABS) as WorkspaceRecentTab[],
    tabs,
    closedTabs,
    activeTabId: activeTab?.id ?? null,
    focusedTerminalId: activeTab?.snapshot.focusedTerminalId ?? null,
    history: seededHistory,
    historyIndex: seededHistory.length - 1,
  }
}

/**
 * v8 — a workspace tab shows a single project. Group and composition tabs are split into one tab
 * per project, and the layout state that only existed to arrange several projects on one screen
 * (workspace grid, group grid, flat mode) is dropped.
 */
function migrateToV8(parsed: any): any {
  const preferences = normalizePreferences(parsed.preferences)
  const projects = (parsed.projects ?? []).map((project: any) => ({
    ...project,
    gridLayoutHistory: project.gridLayoutHistory ?? [],
  }))
  return {
    ...parsed,
    version: 8,
    // Tasks gained priority, notes and session links; normalizing here backfills
    // files written before those fields existed.
    todos: normalizeTodos(parsed.todos),
    projects,
    preferences,
    workspace: migrateWorkspaceNavigation({
      workspace: parsed.workspace,
      projects,
      activeProjectId: parsed.activeProjectId ?? null,
      preferences,
    }),
  }
}

/**
 * v9 — a project shows one session at a time, and projects are a flat list.
 *
 * The grid, the layout modes and the pane blocks are gone, so everything that
 * only described how several panes shared one screen is dropped. The panes
 * themselves are kept: they are the tabs now, and the first one takes the screen.
 *
 * Groups go with them. A project that lived inside one has to land somewhere the
 * sidebar actually renders, so the groups are walked in their own order and their
 * projects pushed into the flat list — the order on screen survives even though
 * the grouping does not.
 */
function migrateToV9(parsed: any): ProjectsFile {
  const v8 = migrateToV8(parsed)
  const projects: Project[] = v8.projects.map((project: any) => {
    const { layoutMode, gridLayout, gridLayoutHistory, paneGroups, groupId, ...rest } = project
    return rest as Project
  })

  const known = new Set(projects.map((project) => project.id))
  const order: string[] = []
  const push = (id: unknown) => {
    if (typeof id !== 'string' || !known.has(id) || order.includes(id)) return
    order.push(id)
  }
  for (const id of v8.ungroupedOrder ?? v8.projectOrder ?? []) push(id)
  for (const group of v8.groups ?? []) for (const id of group?.projectIds ?? []) push(id)
  for (const project of projects) push(project.id)

  const { isolatedPaneId, ...preferences } = v8.preferences as Preferences & {
    isolatedPaneId?: string | null
  }
  const { groups, ungroupedOrder, ...rest } = v8

  return normalizeStoredAccents({
    ...rest,
    version: 9,
    projects,
    projectOrder: order,
    preferences,
    workspace: {
      ...v8.workspace,
      containers: normalizeStoredContainers(v8.workspace.containers),
      // A tab's group tint and the `group` entries of the recent list point at
      // something that no longer exists.
      tabs: v8.workspace.tabs.map((tab: any) => {
        const { groupId, ...tabRest } = tab
        return { ...tabRest, snapshot: normalizeStoredSnapshot(tab.snapshot) }
      }),
      recentTabs: (v8.workspace.recentTabs ?? []).filter((entry: any) => entry?.kind === 'project'),
    },
  })
}

/**
 * v9 -> v10: drops the unread marks left over from a previous run.
 *
 * `completionUnread` lives in `projects.json` and comes back on load, while the
 * PTY runtime that produced it does not — `useTerminalsStore` is in-memory. So
 * every restart restored a wall of "response ready" badges pointing at agents
 * that had died with the last session, and the sidebar showed them for panes
 * that could not have anything to read. The mark only means something while the
 * process that raised it is still around.
 *
 * It also records where each pane's name came from. Until now nothing did, so
 * the sidebar could not tell a name someone typed from the placeholder the app
 * picked, and preferred the agent's generated title over both. Existing panes
 * are backfilled as `'auto'`: the file does not say who named them, and
 * assuming a deliberate name would pin a placeholder like "Claude Code" to the
 * top of the precedence for good.
 */
function migrateToV10(parsed: any): PartiallyMigratedFile {
  const v9 = migrateToV9(parsed)
  return {
    ...v9,
    version: 10,
    // Defensive on both levels: an older file can carry a project with no
    // `terminals` array at all, and a pane with no `tabs`.
    projects: v9.projects.map((project) => ({
      ...project,
      terminals: (project.terminals ?? []).map((terminal) => ({
        ...terminal,
        nameSource: terminal.nameSource ?? 'auto',
        tabs: (terminal.tabs ?? []).map(({ completionUnread, ...tab }) => tab),
      })),
    })),
  }
}

/**
 * v10 -> v11: every pane gets a short reference (`pa-3576`).
 *
 * `id` stays the internal key, but it is 21 characters of mixed case and nobody
 * types or dictates one. The short reference is what a person puts into
 * `arco session send` or says out loud, so panes written before it existed have
 * to get one.
 *
 * The walk is deterministic in file order and idempotent: a reference that is
 * well formed and not yet seen is kept, and only a missing, malformed or
 * duplicated one is replaced. Running this over its own output changes nothing,
 * which matters because `migrate()` runs on every load, not once.
 */
function migrateToV11(parsed: any): PartiallyMigratedFile {
  const v10 = migrateToV10(parsed)
  const taken = new Set<string>()
  return {
    ...v10,
    version: 11,
    projects: v10.projects.map((project) => ({
      ...project,
      terminals: (project.terminals ?? []).map((terminal) => {
        const current = terminal.shortId
        if (isPaneShortId(current) && !taken.has(current)) {
          taken.add(current)
          return terminal
        }
        const shortId = generatePaneShortId(taken)
        taken.add(shortId)
        return { ...terminal, shortId }
      }),
    })),
  }
}

/** Whether a name says which work a pane is doing, or is the agent's own placeholder. */
function namesTheWork(name: unknown): name is string {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value) return false
  return !isGenericSessionName(value)
}

/**
 * What a group formed out of existing panes gets called.
 *
 * The most recently used pane that carries a real name wins: those are the ones
 * the user or a task named, and they say which work this is. When every pane in
 * the group is called after its agent — which is most of them — the worktree id
 * is the only thing left that tells one group from another. It is a poor name
 * and it is meant to be replaced; a group is renameable precisely for this.
 */
function nameForGroup(panes: Terminal[], worktreeAgentId: string | undefined): string {
  const byRecency = [...panes].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  const named = byRecency.find((pane) => namesTheWork(pane.name))
  return named?.name.trim() ?? worktreeAgentId ?? ''
}

/**
 * v11 -> v12: a project is a list of fronts of work, not a flat list of panes.
 *
 * Groups are formed from what the file already says: panes that share a
 * worktree were one piece of work, so they become one group that owns it.
 * Everything running on the project's own tree lands in a single group named
 * after the project, which is the group a project has when it has no isolated
 * work at all.
 *
 * Idempotent by adoption rather than by skipping: a group already in the file
 * is kept as it is, and only a pane with no group — or one pointing at a group
 * that no longer exists — is placed. That is what makes this safe to run on
 * every load, and what picks up a pane created by a build that did not know
 * about groups yet.
 *
 * The worktree is copied to the group and left on the pane. Nothing reads it
 * from the group yet, and the code that provisions and removes worktrees still
 * reads `Terminal.worktreeAgentId`; moving that is its own change.
 */
function migrateToV12(parsed: any): ProjectsFile {
  const v11 = migrateToV11(parsed)
  return {
    ...v11,
    version: 12,
    projects: v11.projects.map((project) => {
      const terminals = project.terminals ?? []
      const groups = [...(project.groups ?? [])]
      const byId = new Map(groups.map((group) => [group.id, group]))
      const byWorktree = new Map(
        groups
          .filter((group) => group.worktreeAgentId)
          .map((group) => [group.worktreeAgentId as string, group]),
      )
      // Formed lazily: a project with no loose pane must not gain an empty
      // group, and one with no group at all must not stay without any.
      let loose = groups.find((group) => !group.worktreeAgentId) ?? null
      const createdAt = project.createdAt ?? Date.now()

      // A pane pointing at a group that is no longer in the file counts as an
      // orphan: leaving the stale id would put it in a group nothing renders.
      const pending = terminals.filter(
        (terminal) => !terminal.groupId || !byId.has(terminal.groupId),
      )
      if (pending.length === 0) return project

      const assignment = new Map<string, string>()
      const worktreeMembers = new Map<string, Terminal[]>()
      for (const terminal of pending) {
        const worktree = terminal.worktreeAgentId
        if (!worktree) continue
        worktreeMembers.set(worktree, [...(worktreeMembers.get(worktree) ?? []), terminal])
      }
      for (const [worktree, members] of worktreeMembers) {
        let group = byWorktree.get(worktree)
        if (!group) {
          group = {
            id: nanoid(),
            name: nameForGroup(members, worktree),
            worktreeAgentId: worktree,
            ...(members[0]?.cwd ? { cwd: members[0].cwd } : {}),
            createdAt,
          }
          groups.push(group)
          byWorktree.set(worktree, group)
        }
        for (const member of members) assignment.set(member.id, group.id)
      }

      const orphans = pending.filter((terminal) => !terminal.worktreeAgentId)
      if (orphans.length > 0) {
        if (!loose) {
          loose = { id: nanoid(), name: project.name, createdAt }
          groups.push(loose)
        }
        for (const orphan of orphans) assignment.set(orphan.id, loose.id)
      }

      return {
        ...project,
        groups,
        terminals: terminals.map((terminal) => {
          const groupId = assignment.get(terminal.id)
          return groupId ? { ...terminal, groupId } : terminal
        }),
      }
    }),
  }
}

/** Migrates older files and normalizes restorable snapshots. */
export function migrate(parsed: any): ProjectsFile {
  if (parsed.version === 12) return migrateToV12(parsed)
  if (parsed.version === 11) return migrateToV12(parsed)
  if (parsed.version === 10) return migrateToV12(parsed)
  if (parsed.version === 9) return migrateToV12(parsed)
  if (parsed.version === 8) return migrateToV12(parsed)
  if (parsed.version === 7) return migrateToV12(parsed)
  if (parsed.version === 6) return migrateToV12(parsed)

  const v5Result = parsed.version === 5 ? parsed : migrateToV5(parsed)

  // Migrate v5 -> v6: track worktrees whose cleanup did not finish.
  const v6Projects = (v5Result.projects ?? []).map((p: any) => ({
    ...p,
    orphanWorktrees: p.orphanWorktrees ?? [],
  }))

  return migrateToV12({
    ...v5Result,
    version: 6,
    projects: v6Projects,
    preferences: normalizePreferences(v5Result.preferences),
  })
}

function migrateToV5(parsed: any): any {
  let v4Result: any
  if (parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
    // backfill parentGroupId (v2.1) — grupos antigos viram raiz.
    const groups = (parsed.groups ?? []).map((g: any) => ({
      ...g,
      parentGroupId: g.parentGroupId ?? null,
    }))
    const preferences = normalizePreferences(parsed.preferences)
    const base = {
      ...EMPTY_PROJECTS_FILE,
      ...parsed,
      version: 6 as const,
      preferences,
      groups,
      ungroupedOrder: parsed.ungroupedOrder ?? [],
      todos: normalizeTodos(parsed.todos),
    }
    v4Result = {
      ...base,
      workspace: migrateWorkspaceNavigation({
        workspace: parsed.workspace,
        projects: base.projects,
        activeProjectId: base.activeProjectId,
        preferences,
      }),
    }
  } else {
    // legacy v1 -> v4
    const oldProjects: any[] = parsed.projects ?? []
    const projects: Project[] = oldProjects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      groupId: null,
      terminals: p.terminals ?? [],
      collapsed: p.collapsed ?? false,
      createdAt: p.createdAt ?? Date.now(),
    }))

    const containers: WorkspaceContainer[] = oldProjects
      .filter((p) => Array.isArray(p.activeTerminalIds) && p.activeTerminalIds.length > 0)
      .map((p) => ({
        projectId: p.id,
        paneIds: p.activeTerminalIds,
        activePaneId: p.activeTerminalIds[0] ?? null,
        sidePaneId: null,
        size: 0,
        collapsed: false,
      }))

    v4Result = {
      version: 4,
      groups: [],
      ungroupedOrder: projects.map((p) => p.id),
      projects,
      todos: [],
      activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
      workspace: migrateWorkspaceNavigation({
        workspace: {
          containers,
          recentProjectIds: containers.map((c) => c.projectId).slice(0, MAX_RECENT_PROJECT_TABS),
          recentTabs: containers
            .map((c) => ({ kind: 'project' as const, id: c.projectId }))
            .slice(0, MAX_RECENT_PROJECT_TABS),
        },
        projects,
        activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
        preferences: normalizePreferences(parsed.preferences),
      }),
      preferences: normalizePreferences(parsed.preferences),
      cliPaths: parsed.cliPaths ?? {},
    }
  }

  // Migrate v4 -> v5
  const projects = (v4Result.projects ?? []).map((p: any) => ({
    ...p,
    worktreeMode: p.worktreeMode ?? 'gitWorktree',
    validationCommands: p.validationCommands ?? [],
    gsdWatcherEnabled: p.gsdWatcherEnabled ?? false,
    conflictAgentProvider: p.conflictAgentProvider ?? 'claude',
  }))

  return {
    ...v4Result,
    version: 5,
    projects,
  }
}
