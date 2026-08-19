import { nanoid } from 'nanoid'

import { normalizeAdoRef } from '../lib/adoRef'
import { normalizeEnabledFeatures } from '../lib/features'
import {
  normalizeTodoNotes,
  normalizeTodoPriority,
  normalizeTodoSessions,
  normalizeTodoStatus,
  normalizeTodoTags,
  normalizeTodoTitle,
} from '../lib/todos'
import {
  DEFAULT_PREFERENCES,
  EMPTY_PROJECTS_FILE,
  type Group,
  GROUP_COLORS,
  type Preferences,
  type Project,
  type ProjectsFile,
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
    groups: file.groups.map((group) => ({
      ...group,
      color: normalizeStoredAccent(group.color, GROUP_COLORS[0])!,
    })),
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
    spotifyClientId: preferences.spotifyClientId.trim(),
    spotifyClientSecret: preferences.spotifyClientSecret.trim(),
    adoOrg: (preferences.adoOrg ?? '').trim(),
    adoProject: (preferences.adoProject ?? '').trim(),
    adoPat: (preferences.adoPat ?? '').trim(),
    adoPollSecs: Math.min(3600, Math.max(60, Math.round(Number(preferences.adoPollSecs ?? 300)))),
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
      ...(adoRef ? { adoRef } : {}),
      ...(item?.watch ? { watch: true } : {}),
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
      internalLayout: item.internalLayout ?? 'auto',
      collapsed: Boolean(item.collapsed),
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
        ...(project.groupId ? { groupId: project.groupId } : {}),
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
          ...(project.groupId ? { groupId: project.groupId } : {}),
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
  groups: Group[]
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
function migrateToV8(parsed: any): ProjectsFile {
  const preferences = normalizePreferences(parsed.preferences)
  const projects = (parsed.projects ?? []).map((project: any) => ({
    ...project,
    gridLayoutHistory: project.gridLayoutHistory ?? [],
  }))
  const groups = (parsed.groups ?? []).map((group: any) => {
    const { layoutMode, gridLayout, gridLayoutHistory, ...rest } = group
    return rest
  })
  return normalizeStoredAccents({
    ...parsed,
    version: 8,
    // Tasks gained priority, notes and session links; normalizing here backfills
    // files written before those fields existed.
    todos: normalizeTodos(parsed.todos),
    projects,
    groups,
    preferences,
    workspace: migrateWorkspaceNavigation({
      workspace: parsed.workspace,
      projects,
      groups,
      activeProjectId: parsed.activeProjectId ?? null,
      preferences,
    }),
  })
}

/** Migrates older files and normalizes restorable snapshots. */
export function migrate(parsed: any): ProjectsFile {
  if (parsed.version === 8) return migrateToV8(parsed)
  if (parsed.version === 7) return migrateToV8(parsed)
  if (parsed.version === 6) return migrateToV8(parsed)

  const v5Result = parsed.version === 5 ? parsed : migrateToV5(parsed)

  // Migrate v5 -> v6: track worktrees whose cleanup did not finish.
  const v6Projects = (v5Result.projects ?? []).map((p: any) => ({
    ...p,
    orphanWorktrees: p.orphanWorktrees ?? [],
  }))

  return migrateToV8({
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
        groups,
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
      layoutMode: p.layoutMode ?? 'auto',
      collapsed: p.collapsed ?? false,
      createdAt: p.createdAt ?? Date.now(),
    }))

    const containers: WorkspaceContainer[] = oldProjects
      .filter((p) => Array.isArray(p.activeTerminalIds) && p.activeTerminalIds.length > 0)
      .map((p) => ({
        projectId: p.id,
        paneIds: p.activeTerminalIds,
        size: 0,
        internalLayout: p.layoutMode ?? 'auto',
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
        groups: [],
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

export function collectGroupProjectIds(groupId: string, groups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const g = groups.find((gr) => gr.id === cur)
    if (!g) continue
    for (const pid of g.projectIds) result.add(pid)
    for (const sg of groups) {
      if (sg.parentGroupId === cur) queue.push(sg.id)
    }
  }
  return result
}
