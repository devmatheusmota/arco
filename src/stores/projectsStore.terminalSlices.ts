/** Terminal and workspace-container actions extracted from the main store. */

import { nanoid } from 'nanoid'

import { getLocale, translate } from '../lib/i18n'
import {
  clearTerminalPtyIds,
  collectTerminalPtyIds,
  getProjectDefaultCwd,
  getProjectRepoRoot,
  makeDefaultTerminal,
  makeDiffPane,
  makeFilePane,
  makeWebPane,
  rememberProjectTab,
  rememberWorkspaceTab,
  resetTerminalRuntime,
  touchTerminalUsage,
} from '../lib/terminalFactory'
import { cleanupPtys } from '../lib/terminalLifecycle'
import { pruneTodoSessions } from '../lib/todos'
import type { Terminal } from '../lib/types'
import { sanitizeWorkspaceSnapshot } from '../lib/workspaceNavigation'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

type TerminalsSlice = Pick<
  ProjectsState,
  | 'createTerminal'
  | 'createAgentTerminal'
  | 'createFilePane'
  | 'createDiffPane'
  | 'createWebPane'
  | 'createGraphifyPane'
  | 'renameTerminal'
  | 'markGsdSyncViewer'
  | 'deleteTerminal'
  | 'deleteTerminalWithWorktreeCleanup'
  | 'killTerminal'
  | 'moveTerminal'
  | 'setTerminalDisabled'
  | 'setProjectDisabled'
  | 'setLaneVisible'
  | 'setTerminalRemoteExcluded'
  | 'markTerminalUsed'
>

/**
 * Total of staged, unstaged, untracked and conflicted entries in a worktree.
 * A failure counts as zero: an unreadable status must not block closing a pane.
 */
async function countPendingChanges(
  gitStatus: (path: string) => Promise<{
    staged: unknown[]
    changes: unknown[]
    untracked: unknown[]
    conflicts: unknown[]
  }>,
  path: string,
): Promise<number> {
  try {
    const status = await gitStatus(path)
    return (
      status.staged.length +
      status.changes.length +
      status.untracked.length +
      status.conflicts.length
    )
  } catch {
    return 0
  }
}

export function createTerminalsSlice({
  get,
  update,
  updateTerminal,
  openPanesInProjectTab,
}: SliceCtx): TerminalsSlice {
  /**
   * Shared tail of every pane-creating action: the new pane lands in the tab of its own project,
   * and that project is remembered as recent.
   */
  const revealNewPane = (
    state: ProjectsState,
    projects: ProjectsState['projects'],
    projectId: string,
    paneId: string,
  ): Partial<ProjectsState> => {
    const nextState = { ...state, projects } as ProjectsState
    const navigation = openPanesInProjectTab(nextState, projectId, [paneId])
    return {
      projects,
      ...navigation,
      workspace: {
        ...(navigation?.workspace ?? state.workspace),
        recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
        recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
          kind: 'project',
          id: projectId,
        }),
      },
    }
  }

  return {
    createTerminal: (projectId, args) => {
      let terminal = makeDefaultTerminal(args)
      update((state) => {
        const sourceProject = state.projects.find((p) => p.id === projectId)
        const inheritedCwd = getProjectDefaultCwd(sourceProject)
        const finalCwd = args.cwd.trim() || inheritedCwd
        terminal = makeDefaultTerminal({
          ...args,
          cwd: finalCwd,
          firstTab: {
            ...args.firstTab,
            cwd: args.firstTab.cwd.trim() || finalCwd,
          },
        })
        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                ...(!args.worktreeAgentId && finalCwd ? { defaultCwd: finalCwd } : {}),
                terminals: [...p.terminals, terminal],
              }
            : p,
        )
        return revealNewPane(state, projects, projectId, terminal.id)
      })
      return terminal
    },

    createAgentTerminal: async (projectId, args) => {
      const state = get()
      const project = state.projects.find((p) => p.id === projectId)
      // The project flag is the default; a session can override it either way, from
      // the new-terminal modal or from the CLI payload. Shell panes never isolate:
      // a worktree is only useful to an agent that edits code.
      const isolationChoice = args.worktree ?? 'inherit'
      const wantsIsolation =
        args.firstTab.type !== 'shell' &&
        (isolationChoice === 'new' ||
          (isolationChoice === 'inherit' && Boolean(project?.autoWorktree)))
      if (project && wantsIsolation) {
        // worktree_provision resolve a raiz de verdade via `--git-common-dir`

        const repo =
          getProjectRepoRoot(project) ||
          getProjectDefaultCwd(project, state.projects) ||
          args.cwd.trim()
        if (repo) {
          const agentId = `${args.firstTab.type.slice(0, 2)}-${nanoid(6)}`.replace(
            /[^A-Za-z0-9_-]/g,
            'x',
          )
          try {
            const { worktreeProvision, gitInit } = await import('../lib/tauri')

            try {
              await gitInit(repo)
            } catch (initErr) {
              console.warn('[projectsStore] auto-gitInit no spawn falhou:', initErr)
            }
            const info = await worktreeProvision(
              repo,
              agentId,
              project.worktreeMode ?? 'gitWorktree',
            )
            return get().createTerminal(projectId, {
              name: args.name,
              cwd: info.path,
              firstTab: { ...args.firstTab, cwd: info.path },
              worktreeAgentId: agentId,
            })
          } catch (error) {
            console.warn('[projectsStore] autoWorktree falhou; terminal normal:', error)
            useUiStore.getState().pushToast({
              title: t('term.autoIsolationFailedTitle'),
              body: t('term.autoIsolationFailedBody', { error: String(error).slice(0, 200) }),
            })
          }
        }
      }
      return get().createTerminal(projectId, args)
    },

    createFilePane: (projectId, args) => {
      const pane = makeFilePane(args)
      update((state) => {
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    createDiffPane: (projectId, args) => {
      const pane = makeDiffPane(args)
      update((state) => {
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    createWebPane: (projectId, args) => {
      const pane = makeWebPane(args)
      update((state) => {
        const projects = state.projects.map((project) =>
          project.id === projectId
            ? { ...project, terminals: [...project.terminals, pane] }
            : project,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    createGraphifyPane: (projectId, cwd) => {
      const pane: Terminal = {
        id: `graphify-${nanoid()}`,
        name: 'Visualização de Grafo (Graphify)',
        cwd,
        tabs: [],
        activeTabId: '',
        disabled: false,
        laneVisible: true,
        kind: 'graphify',
      }
      update((state) => {
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    renameTerminal: (projectId, terminalId, name) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, name })),

    markGsdSyncViewer: (projectId, terminalId) =>
      updateTerminal(projectId, terminalId, (t) =>
        t.gsdSyncViewer ? t : { ...t, gsdSyncViewer: true },
      ),

    deleteTerminal: (projectId, terminalId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        const terminal = project?.terminals.find((t) => t.id === terminalId)

        // teardown da worktree inteira — arrasta junto o terminal "viewer" GSD

        const idsToRemove = new Set([terminalId])
        if (terminal?.worktreeAgentId && terminal.cwd) {
          for (const sibling of project?.terminals ?? []) {
            if (sibling.gsdSyncViewer && sibling.cwd === terminal.cwd) idsToRemove.add(sibling.id)
          }
        }
        const terminalsToClean = (project?.terminals ?? []).filter((t) => idsToRemove.has(t.id))
        if (terminalsToClean.length > 0) cleanupPtys(collectTerminalPtyIds(terminalsToClean))
        const projects = state.projects.map((p) => {
          if (p.id !== projectId) return p
          const paneGroups = (p.paneGroups ?? [])
            .map((group) => ({
              ...group,
              paneIds: group.paneIds.filter((id) => !idsToRemove.has(id)),
            }))
            .filter((group) => group.paneIds.length > 1)
          return {
            ...p,
            terminals: p.terminals.filter((t) => !idsToRemove.has(t.id)),
            paneGroups: paneGroups.length > 0 ? paneGroups : undefined,
          }
        })
        // remove pane do container; se container ficou vazio, remove container
        const containers = state.workspace.containers
          .map((c) => {
            if (c.projectId !== projectId) return c
            return { ...c, paneIds: c.paneIds.filter((id) => !idsToRemove.has(id)) }
          })
          .filter((c) => c.paneIds.length > 0)
        const tabs = state.workspace.tabs
          .filter(
            (tab) =>
              !(
                tab.kind === 'terminal' &&
                tab.projectId === projectId &&
                idsToRemove.has(tab.terminalId ?? '')
              ),
          )
          .map((tab) => ({
            ...tab,
            snapshot: sanitizeWorkspaceSnapshot(tab.snapshot, projects),
          }))
        const tabIds = new Set(tabs.map((tab) => tab.id))
        const history = state.workspace.history
          .filter((entry) => tabIds.has(entry.tabId))
          .map((entry) => ({
            ...entry,
            snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, projects),
          }))
        return {
          projects,
          // A task that launched one of these panes must not keep pointing at it.
          todos: pruneTodoSessions(state.todos, (link) => !idsToRemove.has(link.terminalId)),
          workspace: {
            ...state.workspace,
            containers,
            tabs,
            activeTabId: tabIds.has(state.workspace.activeTabId ?? '')
              ? state.workspace.activeTabId
              : (tabs[0]?.id ?? null),
            focusedTerminalId: idsToRemove.has(state.workspace.focusedTerminalId ?? '')
              ? null
              : state.workspace.focusedTerminalId,
            history,
            historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
          },
        }
      }),

    deleteTerminalWithWorktreeCleanup: async (projectId, terminalId) => {
      const project = get().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals.find((t) => t.id === terminalId)
      if (!terminal?.worktreeAgentId) {
        get().deleteTerminal(projectId, terminalId)
        return
      }
      const { killPtyTree, worktreeRemove, gitStatus } = await import('../lib/tauri')

      // Removal runs `git worktree remove --force`, which overrides the very guard
      // git raises for a dirty tree — modified and untracked files go with it. Ask
      // only when there is something to lose; a clean worktree is removed silently,
      // which is the common case.
      if (terminal.cwd) {
        const pending = await countPendingChanges(gitStatus, terminal.cwd)
        if (pending > 0) {
          // Cancel means cancel: the session stays open and the worktree stays on
          // disk. Closing the pane here instead would still lose the session the
          // user just chose to keep, and the work would only survive by accident.
          const confirmed = window.confirm(
            t('term.worktreeDirtyOnClose', { count: pending, name: terminal.name }),
          )
          if (!confirmed) return
        }
      }

      const ptyIds = collectTerminalPtyIds([terminal])

      await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))
      const repo = getProjectRepoRoot(project)
      if (repo) {
        try {
          await worktreeRemove(repo, terminal.worktreeAgentId, true)
        } catch (firstErr) {
          if (!String(firstErr).includes('worktree_not_found')) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            try {
              await worktreeRemove(repo, terminal.worktreeAgentId, true)
            } catch (secondErr) {
              if (!String(secondErr).includes('worktree_not_found')) {
                get().addOrphanWorktree(projectId, {
                  path: terminal.cwd ?? '',
                  mode: 'gitWorktree',
                })
              }
              console.warn(
                '[projectsStore] falha removendo worktree ao deletar terminal:',
                secondErr,
              )
            }
          }
        }
      }
      get().deleteTerminal(projectId, terminalId)
    },

    killTerminal: (projectId, terminalId) =>
      update((state) => {
        const terminal = state.projects
          .find((p) => p.id === projectId)
          ?.terminals.find((t) => t.id === terminalId)
        if (terminal) cleanupPtys(collectTerminalPtyIds([terminal]))

        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? resetTerminalRuntime(t) : t,
                ),
              }
            : p,
        )
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === projectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            focusedTerminalId:
              state.workspace.focusedTerminalId === terminalId
                ? null
                : state.workspace.focusedTerminalId,
          },
        }
      }),

    moveTerminal: (fromProjectId, terminalId, toProjectId) => {
      if (fromProjectId === toProjectId) return
      update((state) => {
        const from = state.projects.find((p) => p.id === fromProjectId)
        if (!from) return
        const terminal = from.terminals.find((t) => t.id === terminalId)
        if (!terminal) return
        const projects = state.projects.map((p) => {
          if (p.id === fromProjectId) {
            return { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) }
          }
          if (p.id === toProjectId) {
            return { ...p, terminals: [...p.terminals, terminal] }
          }
          return p
        })
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === fromProjectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return { projects, workspace: { ...state.workspace, containers } }
      })
    },

    setTerminalDisabled: (projectId, terminalId, disabled) =>
      updateTerminal(projectId, terminalId, (t) => {
        if (disabled) {
          cleanupPtys(collectTerminalPtyIds([t]))
          return { ...clearTerminalPtyIds(t), disabled }
        }
        return { ...t, disabled }
      }),

    setProjectDisabled: (projectId, disabled) =>
      update((state) => {
        const projects = state.projects.map((p) => {
          if (p.id !== projectId) return p
          if (disabled) cleanupPtys(collectTerminalPtyIds(p.terminals))
          return {
            ...p,
            terminals: p.terminals.map((t) => ({
              ...(disabled ? clearTerminalPtyIds(t) : t),
              disabled,
            })),
          }
        })
        if (disabled) {
          const containers = state.workspace.containers.filter((c) => c.projectId !== projectId)
          return { projects, workspace: { ...state.workspace, containers } }
        }
        return { projects }
      }),

    setLaneVisible: (projectId, terminalId, visible) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, laneVisible: visible })),

    setTerminalRemoteExcluded: (projectId, terminalId, excluded) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, remoteExcluded: excluded })),

    markTerminalUsed: (projectId, terminalId) =>
      updateTerminal(projectId, terminalId, (t) => touchTerminalUsage(t)),

    /* ------------ workspace containers ------------ */
  }
}

type ContainersSlice = Pick<
  ProjectsState,
  | 'openPane'
  | 'closePane'
  | 'togglePane'
  | 'openContainerWithAllPanes'
  | 'closeContainer'
  | 'closeOtherContainers'
  | 'reorderPaneInContainer'
  | 'groupPanes'
  | 'ungroupPanes'
  | 'setContainerCollapsed'
  | 'setContainerInternalLayout'
  | 'setFullscreenContainer'
  | 'setFullscreenPane'
>

export function createContainersSlice({
  get,
  update,
  updateContainer,
  openPanesInProjectTab,
}: SliceCtx): ContainersSlice {
  return {
    openPane: (projectId, terminalId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project) return
        const now = Date.now()
        const projects = state.projects.map((p) =>
          p.id !== projectId
            ? p
            : {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? touchTerminalUsage(t) : t,
                ),
              },
        )
        const navigation = openPanesInProjectTab(
          { ...state, projects } as ProjectsState,
          projectId,
          [terminalId],
          { layout: project.layoutMode },
        )
        return {
          projects,
          ...navigation,
          workspace: {
            ...(navigation?.workspace ?? state.workspace),
            containers: (navigation?.workspace ?? state.workspace).containers.map((c) =>
              c.projectId === projectId ? { ...c, lastUsedAt: now } : c,
            ),
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    closePane: (projectId, terminalId) =>
      update((state) => {
        const terminal = state.projects
          .find((p) => p.id === projectId)
          ?.terminals.find((t) => t.id === terminalId)
        if (terminal) cleanupPtys(collectTerminalPtyIds([terminal]))
        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? clearTerminalPtyIds(t) : t,
                ),
              }
            : p,
        )
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === projectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return { projects, workspace: { ...state.workspace, containers } }
      }),

    togglePane: (projectId, terminalId) => {
      const state = get()
      const c = state.workspace.containers.find((x) => x.projectId === projectId)
      if (c?.paneIds.includes(terminalId)) {
        get().closePane(projectId, terminalId)
      } else {
        get().openPane(projectId, terminalId)
      }
    },

    openContainerWithAllPanes: (projectId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.terminals.length === 0) return
        const allPanes = project.terminals.map((t) => t.id)
        // Leaves fullscreen when another container was covering the view.
        const fsId = state.preferences.fullscreenContainerId
        const preferences =
          fsId && fsId !== projectId
            ? { ...state.preferences, fullscreenContainerId: null }
            : state.preferences
        const navigation = openPanesInProjectTab(
          { ...state, preferences } as ProjectsState,
          projectId,
          allPanes,
          { layout: project.layoutMode },
        )
        return {
          preferences,
          ...navigation,
          workspace: {
            ...(navigation?.workspace ?? state.workspace),
            containers: (navigation?.workspace ?? state.workspace).containers.map((c) =>
              c.projectId === projectId ? { ...c, collapsed: false, lastUsedAt: Date.now() } : c,
            ),
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    closeContainer: (projectId) =>
      update((state) => {
        const closingPaneIds = new Set(
          state.workspace.containers.find((c) => c.projectId === projectId)?.paneIds ?? [],
        )
        const project = state.projects.find((p) => p.id === projectId)
        const closingTerminals = project?.terminals.filter((t) => closingPaneIds.has(t.id)) ?? []
        cleanupPtys(collectTerminalPtyIds(closingTerminals))
        return {
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  terminals: p.terminals.map((t) =>
                    closingPaneIds.has(t.id) ? clearTerminalPtyIds(t) : t,
                  ),
                }
              : p,
          ),
          workspace: {
            ...state.workspace,
            containers: state.workspace.containers.filter((c) => c.projectId !== projectId),
          },
        }
      }),

    closeOtherContainers: (keepProjectId) =>
      update((state) => {
        const closingContainers = state.workspace.containers.filter(
          (c) => c.projectId !== keepProjectId,
        )
        const closingByProject = new Map(
          closingContainers.map((c) => [c.projectId, new Set(c.paneIds)]),
        )
        const closingTerminals = state.projects.flatMap((project) => {
          const paneIds = closingByProject.get(project.id)
          if (!paneIds) return []
          return project.terminals.filter((terminal) => paneIds.has(terminal.id))
        })
        cleanupPtys(collectTerminalPtyIds(closingTerminals))
        return {
          projects: state.projects.map((project) => {
            const paneIds = closingByProject.get(project.id)
            if (!paneIds) return project
            return {
              ...project,
              terminals: project.terminals.map((terminal) =>
                paneIds.has(terminal.id) ? clearTerminalPtyIds(terminal) : terminal,
              ),
            }
          }),
          workspace: {
            ...state.workspace,
            containers: state.workspace.containers.filter((c) => c.projectId === keepProjectId),
          },
        }
      }),

    reorderPaneInContainer: (projectId, fromIndex, toIndex) =>
      updateContainer(projectId, (c) => {
        const next = [...c.paneIds]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { ...c, paneIds: next }
      }),

    groupPanes: (projectId, paneIds) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        const validIds = [...new Set(paneIds)].filter((id) =>
          project?.terminals.some((t) => t.id === id),
        )
        if (!project || validIds.length < 2) return
        const selected = new Set(validIds)
        const groups = project.paneGroups ?? []
        const absorbed = groups.filter((group) => group.paneIds.some((id) => selected.has(id)))
        const expandedIds = [
          ...new Set(absorbed.flatMap((group) => group.paneIds).concat(validIds)),
        ]
        const remaining = groups.filter((group) => !absorbed.includes(group))
        remaining.push({ id: `pane-group-${Date.now()}`, paneIds: expandedIds })
        return {
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, paneGroups: remaining } : p,
          ),
        }
      }),

    ungroupPanes: (projectId, groupId) =>
      update((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId
            ? { ...p, paneGroups: (p.paneGroups ?? []).filter((group) => group.id !== groupId) }
            : p,
        ),
      })),

    setContainerCollapsed: (projectId, collapsed) =>
      updateContainer(projectId, (c) => ({ ...c, collapsed })),

    setContainerInternalLayout: (projectId, layout) =>
      updateContainer(projectId, (c) => ({ ...c, internalLayout: layout })),

    setFullscreenContainer: (projectId) =>
      update((state) => ({
        preferences: {
          ...state.preferences,
          fullscreenContainerId: projectId,
          isolatedPaneId: null,
        },
      })),

    setFullscreenPane: (terminalId) =>
      update((state) => {
        if (!terminalId) {
          return {
            preferences: {
              ...state.preferences,
              fullscreenContainerId: null,
              isolatedPaneId: null,
            },
          }
        }
        const owner = state.projects.find((p) => p.terminals.some((term) => term.id === terminalId))
        if (!owner) return
        return {
          preferences: {
            ...state.preferences,
            fullscreenContainerId: owner.id,
            isolatedPaneId: terminalId,
          },
        }
      }),
  }
}
