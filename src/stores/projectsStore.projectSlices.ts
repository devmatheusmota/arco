/** Project actions extracted from the main store. */

import { nanoid } from 'nanoid'

import { getLocale, translate } from '../lib/i18n'
import {
  collectTerminalPtyIds,
  getProjectRepoRoot,
  isInsideArcoWorktree,
} from '../lib/terminalFactory'
import { cleanupPtys } from '../lib/terminalLifecycle'
import { pruneTodoSessions } from '../lib/todos'
import type { OrphanWorktree, Project } from '../lib/types'
import { sanitizeWorkspaceSnapshot } from '../lib/workspaceNavigation'
import { anyWithin, heldWorktrees, worktreeRepoOf } from '../lib/worktreeOwnership'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

const migratingWorktreeProjectIds = new Set<string>()

/** How old an unheld worktree must be before a sweep calls it a leftover. */
const UNTRACKED_WORKTREE_GRACE_MS = 60 * 60 * 1000

type ProjectsSlice = Pick<
  ProjectsState,
  | 'createProject'
  | 'renameProject'
  | 'archiveProject'
  | 'unarchiveProject'
  | 'setProjectColor'
  | 'setProjectIconUrl'
  | 'addMarkdownComment'
  | 'removeMarkdownComment'
  | 'setWorktreeMode'
  | 'setValidationCommands'
  | 'setGsdWatcherEnabled'
  | 'setConflictAgentProvider'
  | 'setConflictAgentModel'
  | 'setReviewAgentProvider'
  | 'setReviewAgentModel'
  | 'setGraphifyEnabled'
  | 'setAutoWorktree'
  | 'migrateProjectTerminalsToWorktrees'
  | 'addOrphanWorktree'
  | 'removeOrphanWorktree'
  | 'setCleaningOrphans'
  | 'cleanupOrphanWorktrees'
  | 'sweepUntrackedWorktrees'
  | 'deleteProject'
  | 'reorderProject'
>

export function createProjectsSlice({ set, get, update, updateProject }: SliceCtx): ProjectsSlice {
  return {
    createProject: ({
      name,
      mode = 'standard',
      color,
      iconUrl,
      defaultCwd,
      githubUrl,
      firstBootPending,
    }) => {
      const project: Project = {
        id: nanoid(),
        name,
        mode,
        color,
        iconUrl,
        ...(defaultCwd?.trim() ? { defaultCwd: defaultCwd.trim() } : {}),
        githubUrl,
        firstBootPending,
        terminals: [],
        collapsed: false,
        createdAt: Date.now(),
      }
      update((state) => ({
        projects: [...state.projects, project],
        projectOrder: [...state.projectOrder, project.id],
        activeProjectId: state.activeProjectId ?? project.id,
      }))
      return project
    },

    renameProject: (id, name) => updateProject(id, (p) => ({ ...p, name })),

    archiveProject: (id) => updateProject(id, (p) => ({ ...p, archived: true })),

    unarchiveProject: (id) => updateProject(id, (p) => ({ ...p, archived: false })),

    setProjectColor: (id, color) => updateProject(id, (p) => ({ ...p, color })),

    setProjectIconUrl: (id, iconUrl) => updateProject(id, (p) => ({ ...p, iconUrl })),

    addMarkdownComment: (projectId, comment) =>
      updateProject(projectId, (p) => ({
        ...p,
        markdownComments: [
          ...(p.markdownComments ?? []),
          { ...comment, id: nanoid(), createdAt: Date.now() },
        ],
      })),

    removeMarkdownComment: (projectId, commentId) =>
      updateProject(projectId, (p) => ({
        ...p,
        markdownComments: (p.markdownComments ?? []).filter((comment) => comment.id !== commentId),
      })),

    setWorktreeMode: (id, worktreeMode) => updateProject(id, (p) => ({ ...p, worktreeMode })),

    setValidationCommands: (id, validationCommands) =>
      updateProject(id, (p) => ({ ...p, validationCommands })),

    setGsdWatcherEnabled: (id, gsdWatcherEnabled) =>
      updateProject(id, (p) => ({ ...p, gsdWatcherEnabled })),

    setConflictAgentProvider: (id, conflictAgentProvider) =>
      updateProject(id, (p) => ({ ...p, conflictAgentProvider })),

    setConflictAgentModel: (id, conflictAgentModel) =>
      updateProject(id, (p) => ({ ...p, conflictAgentModel })),

    setReviewAgentProvider: (id, reviewAgentProvider) =>
      updateProject(id, (p) => ({ ...p, reviewAgentProvider })),

    setReviewAgentModel: (id, reviewAgentModel) =>
      updateProject(id, (p) => ({ ...p, reviewAgentModel })),

    setGraphifyEnabled: (id, graphifyEnabled) =>
      updateProject(id, (p) => ({ ...p, graphifyEnabled })),

    setAutoWorktree: (id, autoWorktree) => updateProject(id, (p) => ({ ...p, autoWorktree })),

    migrateProjectTerminalsToWorktrees: async (projectId, gsdWatcherEnabledOverride) => {
      if (migratingWorktreeProjectIds.has(projectId)) return
      const project = get().projects.find((p) => p.id === projectId)
      if (!project) return
      const repo = getProjectRepoRoot(project)
      if (!repo) {
        useUiStore.getState().pushToast({
          title: t('multiAgent.migrateNoRepoTitle'),
          body: t('multiAgent.migrateNoRepoBody'),
        })
        return
      }

      migratingWorktreeProjectIds.add(projectId)
      try {
        const { worktreeProvision, gitStatus, gsdOpenCodePluginWrite } =
          await import('../lib/tauri')
        const { restartPaneAgent } = await import('../lib/ptyRestart')
        const { paneAgentRequest } = await import('../lib/agentProcessLaunch')

        // o erro cru not_a_git_repository vazando pro toast final).
        let status: Awaited<ReturnType<typeof gitStatus>> | null = null
        try {
          status = await gitStatus(repo)
        } catch {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateNoRepoTitle'),
            body: t('multiAgent.migrateNoRepoBody'),
          })
          return
        }
        const dirty = status.staged.length + status.changes.length + status.untracked.length > 0
        if (dirty) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateDirtyTitle'),
            body: t('multiAgent.migrateDirtyBody'),
          })
          return
        }

        const targets = project.terminals.filter(
          (terminal) =>
            !terminal.worktreeAgentId && terminal.kind !== 'web' && terminal.kind !== 'file',
        )
        const succeeded: string[] = []
        const failed: { name: string; error: string }[] = []

        for (const terminal of targets) {
          try {
            const agentId = `${terminal.name.toLowerCase().slice(0, 8)}-${nanoid(6)}`.replace(
              /[^A-Za-z0-9_-]/g,
              'x',
            )
            const info = await worktreeProvision(
              repo,
              agentId,
              project.worktreeMode ?? 'gitWorktree',
            )

            // Terminal migrado com watcher GSD ligado e rodando OpenCode nunca

            const gsdWatcherEnabled = gsdWatcherEnabledOverride ?? project.gsdWatcherEnabled
            if (gsdWatcherEnabled && terminal.tabs.some((tab) => tab.type === 'opencode')) {
              const modelChain = get().preferences.gsdSyncModelChain ?? []
              await gsdOpenCodePluginWrite(info.path, modelChain).catch((error) => {
                console.error(
                  `[projectsStore] gsdOpenCodePluginWrite falhou pra ${info.path}:`,
                  error,
                )
              })
            }

            for (const tab of terminal.tabs) {
              if (!tab.ptyId) continue
              // The pane as it reads once it moves into the worktree below.
              const request = paneAgentRequest(
                project,
                { ...terminal, cwd: info.path },
                { ...tab, cwd: info.path },
              )
              try {
                await restartPaneAgent({ id: tab.ptyId, cwd: info.path }, request)
              } catch (restartErr) {
                console.warn(
                  `[projectsStore] falha reiniciando aba na worktree nova (${terminal.name}):`,
                  restartErr,
                )
              }
            }

            updateProject(projectId, (p) => ({
              ...p,
              terminals: p.terminals.map((t) => {
                if (t.id !== terminal.id) return t
                return {
                  ...t,
                  cwd: info.path,
                  worktreeAgentId: agentId,
                  tabs: t.tabs.map((tab) => ({
                    ...tab,
                    cwd: info.path,
                    sessionId: undefined,
                  })),
                }
              }),
            }))
            succeeded.push(terminal.name)
          } catch (err) {
            failed.push({ name: terminal.name, error: String(err) })
          }
        }

        if (succeeded.length === 0 && failed.length === 0) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateEmptyTitle'),
            body: t('multiAgent.migrateEmptyBody'),
          })
        } else if (failed.length === 0) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateDoneTitle'),
            body: t('multiAgent.migrateDoneBody', { count: succeeded.length }),
          })
        } else if (succeeded.length === 0) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateFailedTitle'),
            body: t('multiAgent.migrateFailedBody', { error: failed[0].error.slice(0, 200) }),
          })
        } else {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migratePartialTitle'),
            body: t('multiAgent.migratePartialBody', {
              succeeded: succeeded.length,
              failed: failed.length,
              names: failed.map((f) => f.name).join(', '),
            }),
          })
        }
      } finally {
        migratingWorktreeProjectIds.delete(projectId)
      }
    },

    addOrphanWorktree: (projectId, entry) =>
      updateProject(projectId, (p) => {
        const existing = p.orphanWorktrees ?? []
        const index = existing.findIndex((o) => o.path === entry.path)
        if (index === -1) {
          return { ...p, orphanWorktrees: [...existing, entry] }
        }
        const next = [...existing]
        next[index] = {
          ...existing[index],
          ...entry,

          adminLockReason: entry.adminLockReason,
        }
        return { ...p, orphanWorktrees: next }
      }),

    removeOrphanWorktree: (projectId, path) =>
      updateProject(projectId, (p) => ({
        ...p,
        orphanWorktrees: (p.orphanWorktrees ?? []).filter((o) => o.path !== path),
      })),

    setCleaningOrphans: (isCleaningOrphans) => update(() => ({ isCleaningOrphans })),

    cleanupOrphanWorktrees: async (projectId) => {
      const summary = { cleaned: 0, kept: 0, partial: 0, awaitingUnlock: 0, failed: 0 }
      const project = get().projects.find((p) => p.id === projectId)
      const orphans = project?.orphanWorktrees ?? []
      if (!project || orphans.length === 0) return summary
      // Each leftover names its own repository in its path. The first pane's
      // directory used to stand in for it, and when that pane worked in a
      // worktree every removal looked inside the wrong tree and failed.
      const fallbackRepo = getProjectRepoRoot(project) || project.defaultCwd?.trim() || ''

      const { worktreeCleanup, worktreeInspect, worktreeRemove } = await import('../lib/tauri')
      set({ isCleaningOrphans: true })

      for (const orphan of orphans) {
        const repoPath = worktreeRepoOf(orphan.path, fallbackRepo)
        try {
          if (!repoPath) throw new Error('no repository for this worktree')
          if (orphan.pruneOnly) {
            // A registration git keeps for a directory that is already gone.
            await worktreeCleanup(repoPath)
            get().removeOrphanWorktree(projectId, orphan.path)
            summary.cleaned++
            continue
          }

          const agentId = orphan.path.split(/[\\/]/).filter(Boolean).pop() ?? ''
          // Removal runs with --force, and nobody confirmed these one by one.
          // Work that would be lost keeps the worktree, and the list says why.
          const loss = await worktreeInspect(repoPath, agentId).catch((error: unknown) =>
            String(error).includes('worktree_not_found') ? 'gone' : null,
          )
          if (loss !== 'gone') {
            const pending = loss?.pendingChanges ?? null
            const unpushed = loss?.unpushedCommits ?? null
            if (pending !== 0 || unpushed !== 0) {
              get().addOrphanWorktree(projectId, {
                ...orphan,
                pendingChanges: pending,
                unpushedCommits: unpushed,
              })
              summary.kept++
              continue
            }
            await worktreeRemove(repoPath, agentId, true)
          }

          try {
            await worktreeCleanup(repoPath)
            get().removeOrphanWorktree(projectId, orphan.path)
            summary.cleaned++
          } catch {
            get().addOrphanWorktree(projectId, {
              path: orphan.path,
              mode: orphan.mode,
              pruneOnly: true,
              requiresRawDeletion: undefined,
              cleanAttempts: 0,
              adminLockReason: undefined,
            })
            summary.partial++
          }
        } catch (error) {
          const message = String(error)
          const adminLockMatch = message.match(/admin_locked:(.*)$/)
          if (adminLockMatch) {
            get().addOrphanWorktree(projectId, {
              ...orphan,
              adminLockReason: adminLockMatch[1],
            })
            summary.awaitingUnlock++
          } else {
            get().addOrphanWorktree(projectId, {
              ...orphan,
              adminLockReason: undefined,
              cleanAttempts: (orphan.cleanAttempts ?? 0) + 1,
            })
            summary.failed++
          }
        }
      }

      set({ isCleaningOrphans: false })
      return summary
    },

    /**
     * Finds the worktrees nothing in the workspace answers for any more.
     *
     * A worktree only reached the leftover list when a removal failed. One whose
     * front simply vanished from the workspace — a reset profile, a removal bug,
     * a crash between closing and cleaning — stayed on disk with nobody to
     * report it, and dozens of them piled up unseen. This reads the folders
     * themselves, once per repository, and lists the ones no front or pane
     * holds. It removes nothing: cleanup is the user's click, and it still
     * keeps any worktree with work that would be lost.
     */
    sweepUntrackedWorktrees: async () => {
      const { worktreeInspect, worktreeList } = await import('../lib/tauri')
      const projects = get().projects
      const held = heldWorktrees(projects)
      const listed = new Set(
        projects.flatMap((project) => (project.orphanWorktrees ?? []).map((item) => item.path)),
      )
      // One project answers for each repository: two projects can share one.
      const repos = new Map<string, string>()
      for (const project of projects) {
        const root = getProjectRepoRoot(project) || project.defaultCwd?.trim() || ''
        if (root && !isInsideArcoWorktree(root) && !repos.has(root)) repos.set(root, project.id)
      }

      const now = Date.now()
      const gained = new Map<string, number>()
      for (const [repo, projectId] of repos) {
        const entries = await worktreeList(repo).catch(() => [])
        for (const entry of entries) {
          if (held.ids.has(entry.agentId) || anyWithin(held.dirs, entry.path)) continue
          if (listed.has(entry.path)) continue
          // A worktree exists for a moment before the pane opened in it is
          // saved; a young one is somebody's session still starting.
          if (!entry.createdAt || now - entry.createdAt < UNTRACKED_WORKTREE_GRACE_MS) continue
          const loss = await worktreeInspect(repo, entry.agentId).catch(() => null)
          const orphan: OrphanWorktree = {
            path: entry.path,
            mode: entry.mode,
            untracked: true,
            pendingChanges: loss?.pendingChanges ?? null,
            unpushedCommits: loss?.unpushedCommits ?? null,
          }
          get().addOrphanWorktree(projectId, orphan)
          gained.set(projectId, (gained.get(projectId) ?? 0) + 1)
        }
      }
      return [...gained].map(([projectId, count]) => ({ projectId, count }))
    },

    deleteProject: (id) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === id)
        if (!project) return
        cleanupPtys(collectTerminalPtyIds(project.terminals))
        const projects = state.projects.filter((p) => p.id !== id)
        // The project is gone, so every pane it owned is gone with it: unlink the
        // sessions first, then drop the project link from the task itself.
        const todos = pruneTodoSessions(state.todos, (link) => link.projectId !== id).map(
          (item) => {
            if (item.projectId !== id) return item
            const next = { ...item }
            delete next.projectId
            return next
          },
        )
        const projectOrder = state.projectOrder.filter((pid) => pid !== id)
        const containers = state.workspace.containers.filter((c) => c.projectId !== id)
        const recentProjectIds = (state.workspace.recentProjectIds ?? []).filter(
          (pid) => pid !== id,
        )
        const recentTabs = (state.workspace.recentTabs ?? []).filter(
          (tab) => !(tab.kind === 'project' && tab.id === id),
        )
        const activeProjectId =
          state.activeProjectId === id ? (projects[0]?.id ?? null) : state.activeProjectId
        const tabs = state.workspace.tabs
          .filter((tab) => tab.projectId !== id)
          .map((tab) => ({
            ...tab,
            snapshot: sanitizeWorkspaceSnapshot(tab.snapshot, projects),
          }))
        const tabIds = new Set(tabs.map((tab) => tab.id))
        const activeTabId = tabIds.has(state.workspace.activeTabId ?? '')
          ? state.workspace.activeTabId
          : (tabs[0]?.id ?? null)
        const history = state.workspace.history
          .filter((entry) => tabIds.has(entry.tabId))
          .map((entry) => ({
            ...entry,
            snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, projects),
          }))
        return {
          projects,
          todos,
          projectOrder,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds,
            recentTabs,
            tabs,
            activeTabId,
            history,
            historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
          },
          activeProjectId,
        }
      }),

    reorderProject: (_projectId, fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.projectOrder]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { projectOrder: next }
      }),
  }
}
