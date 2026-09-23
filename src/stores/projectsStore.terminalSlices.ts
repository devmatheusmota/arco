/** Terminal and workspace-container actions extracted from the main store. */

import { nanoid } from 'nanoid'

import { getLocale, translate } from '../lib/i18n'
import { homeGroupId } from '../lib/paneHoming'
import { removePanesFromWorkspace } from '../lib/paneRemoval'
import { collectPaneShortIds, generatePaneShortId } from '../lib/paneShortId'
import {
  clearTerminalPtyIds,
  collectTerminalPtyIds,
  getProjectDefaultCwd,
  getProjectRepoRoot,
  isInsideArcoWorktree,
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
import type { PaneGroup, Terminal } from '../lib/types'
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
): Promise<number | null> {
  try {
    const status = await gitStatus(path)
    return (
      status.staged.length +
      status.changes.length +
      status.untracked.length +
      status.conflicts.length
    )
  } catch {
    // Not zero: removal runs with `--force`, so reading "I could not tell" as
    // "there is nothing there" is how a day's work goes without a question.
    return null
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

  /**
   * A reference has to be unique across the whole file, and `state.projects` is
   * the only place that sees every pane — which is why it is drawn here and not
   * inside the factories.
   */
  const freshShortId = (state: ProjectsState): string =>
    generatePaneShortId(collectPaneShortIds(state.projects))

  return {
    createTerminal: (projectId, args) => {
      let terminal = makeDefaultTerminal(args)
      update((state) => {
        const sourceProject = state.projects.find((p) => p.id === projectId)
        const inheritedCwd = getProjectDefaultCwd(sourceProject)
        const finalCwd = args.cwd.trim() || inheritedCwd
        // Every pane belongs to a front. Most routes in — a keybinding, the home
        // screen, a handoff, the scheduler — have no front to pass, and a pane
        // without one is invisible in the sidebar and steals the screen from the
        // front that was open.
        const home = homeGroupId({
          requested: args.groupId,
          ownsWorktree: Boolean(args.worktreeAgentId),
          project: sourceProject,
          workspace: state.workspace,
          projectId,
        })
        const bornGroup: PaneGroup | null = home
          ? null
          : {
              id: nanoid(),
              name: args.name?.trim() || translate(getLocale(), 'ui.group.untitled'),
              createdAt: Date.now(),
            }
        const groupId = home ?? bornGroup!.id
        terminal = makeDefaultTerminal({
          ...args,
          groupId,
          cwd: finalCwd,
          shortId: freshShortId(state),
          firstTab: {
            ...args.firstTab,
            cwd: args.firstTab.cwd.trim() || finalCwd,
          },
        })
        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                ...(bornGroup ? { groups: [...(p.groups ?? []), bornGroup] } : {}),
                // A worktree is never the project's home. The old guard asked
                // whether the pane owned one, which a session opened inside a
                // front's worktree does not — so the project's root quietly
                // became a directory that gets deleted with that front.
                ...(!args.worktreeAgentId && finalCwd && !isInsideArcoWorktree(finalCwd)
                  ? { defaultCwd: finalCwd }
                  : {}),
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
        // This value is where the worktree directory lands. `worktree_provision`
        // joins `.arco/worktrees/<id>` onto it verbatim — the Rust shell used to
        // resolve the real root with `--git-common-dir`, the Electron one never
        // did, so nothing downstream corrects a root that points into a worktree.
        const repo = getProjectRepoRoot(project) || getProjectDefaultCwd(project) || args.cwd.trim()
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
              nameSource: args.nameSource,
              cwd: info.path,
              firstTab: { ...args.firstTab, cwd: info.path },
              worktreeAgentId: agentId,
              ...(args.groupId ? { groupId: args.groupId } : {}),
              ...(args.pinned ? { pinned: true } : {}),
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
      let pane = makeFilePane(args)
      update((state) => {
        pane = makeFilePane({ ...args, shortId: freshShortId(state) })
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    createDiffPane: (projectId, args) => {
      let pane = makeDiffPane(args)
      update((state) => {
        pane = makeDiffPane({ ...args, shortId: freshShortId(state) })
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    createWebPane: (projectId, args) => {
      let pane = makeWebPane(args)
      update((state) => {
        pane = makeWebPane({ ...args, shortId: freshShortId(state) })
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
      let pane: Terminal = {
        id: `graphify-${nanoid()}`,
        name: 'Visualização de Grafo (Graphify)',
        cwd,
        tabs: [],
        activeTabId: '',
        disabled: false,
        kind: 'graphify',
      }
      update((state) => {
        pane = { ...pane, shortId: freshShortId(state) }
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        return revealNewPane(state, projects, projectId, pane.id)
      })
      return pane
    },

    // `nameSource` is what makes the rename visible: the sidebar prefers a name
    // someone typed over the title the agent generated, and without the marker
    // it cannot tell one from the other.
    renameTerminal: (projectId, terminalId, name) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, name, nameSource: 'user' })),

    markGsdSyncViewer: (projectId, terminalId) =>
      updateTerminal(projectId, terminalId, (t) =>
        t.gsdSyncViewer ? t : { ...t, gsdSyncViewer: true },
      ),

    deleteTerminal: (projectId, terminalId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        const terminal = project?.terminals.find((t) => t.id === terminalId)
        // The orchestrator goes when its front goes, never on its own. The
        // interface hides the delete for it; this is the backstop for every
        // other route in.
        if (terminal?.pinned) return
        // teardown da worktree inteira — arrasta junto o terminal "viewer" GSD

        const idsToRemove = new Set([terminalId])
        if (terminal?.worktreeAgentId && terminal.cwd) {
          for (const sibling of project?.terminals ?? []) {
            // A pinned sibling is not collateral: this sweep is the one route
            // by which an orchestrator would go without anybody asking.
            if (sibling.pinned) continue
            if (sibling.gsdSyncViewer && sibling.cwd === terminal.cwd) idsToRemove.add(sibling.id)
          }
        }
        const terminalsToClean = (project?.terminals ?? []).filter((t) => idsToRemove.has(t.id))
        if (terminalsToClean.length > 0) cleanupPtys(collectTerminalPtyIds(terminalsToClean))
        // Closing one pane and closing a whole front remove the same things
        // from the same four places; only the list of ids differs.
        return removePanesFromWorkspace({
          projects: state.projects,
          workspace: state.workspace,
          todos: state.todos,
          projectId,
          paneIds: idsToRemove,
        })
      }),

    deleteTerminalWithWorktreeCleanup: async (projectId, terminalId, options) => {
      const project = get().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals.find((t) => t.id === terminalId)
      // Before the confirm: asking about a removal that is going to be refused
      // anyway is worse than not asking.
      if (terminal?.pinned) return
      if (!terminal?.worktreeAgentId) {
        get().deleteTerminal(projectId, terminalId)
        return
      }
      const { killPtyTree, worktreeRemove, gitStatus } = await import('../lib/tauri')

      // Removal runs `git worktree remove --force`, which overrides the very guard
      // git raises for a dirty tree — modified and untracked files go with it. Ask
      // only when there is something to lose; a clean worktree is removed silently,
      // which is the common case.
      // `assumeConfirmed` comes from a caller that already asked — the terminal,
      // where `arco session close` puts the question. `window.confirm` blocks the
      // whole renderer, so a second dialog nobody is looking at would stop the
      // window answering anything at all.
      if (terminal.cwd && !options?.assumeConfirmed) {
        const pending = await countPendingChanges(gitStatus, terminal.cwd)
        if (pending === null || pending > 0) {
          // Cancel means cancel: the session stays open and the worktree stays on
          // disk. Closing the pane here instead would still lose the session the
          // user just chose to keep, and the work would only survive by accident.
          const confirmed = window.confirm(
            pending === null
              ? t('term.worktreeUnknownOnClose', { name: terminal.name, path: terminal.cwd })
              : t('term.worktreeDirtyOnClose', { count: pending, name: terminal.name }),
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
        // The orchestrator belongs to its front, and the front to its project.
        if (terminal.pinned) return
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
  | 'setActivePane'
  | 'setSidePane'
  | 'setContainerCollapsed'
  | 'setFullscreenContainer'
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
          .map((c) => {
            if (c.projectId !== projectId) return c
            const paneIds = c.paneIds.filter((id) => id !== terminalId)
            // Closing what is on screen hands it to the neighbour the tab bar
            // shows next, so the project never ends up showing nothing.
            const closedIndex = c.paneIds.indexOf(terminalId)
            const fallback = paneIds[Math.min(closedIndex, paneIds.length - 1)] ?? null
            return {
              ...c,
              paneIds,
              activePaneId: c.activePaneId === terminalId ? fallback : c.activePaneId,
              sidePaneId: c.sidePaneId === terminalId ? null : c.sidePaneId,
            }
          })
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

    setActivePane: (projectId, paneId) =>
      updateContainer(projectId, (c) => {
        if (!c.paneIds.includes(paneId) || c.activePaneId === paneId) return c
        // A session cannot be the one on screen and the terminal beside it.
        return {
          ...c,
          activePaneId: paneId,
          sidePaneId: c.sidePaneId === paneId ? null : c.sidePaneId,
        }
      }),

    setSidePane: (projectId, paneId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project) return
        if (paneId) {
          const pane = project.terminals.find((t) => t.id === paneId)
          // Only a terminal earns the space beside a session: the point is running
          // a command without leaving the one you are reading.
          if (!pane || (pane.kind && pane.kind !== 'terminal')) return
        }
        return {
          workspace: {
            ...state.workspace,
            containers: state.workspace.containers.map((c) => {
              if (c.projectId !== projectId) return c
              if (!paneId) return { ...c, sidePaneId: null }
              if (!c.paneIds.includes(paneId)) return c
              const activePaneId =
                c.activePaneId === paneId
                  ? (c.paneIds.find((id) => id !== paneId) ?? c.activePaneId)
                  : c.activePaneId
              return { ...c, sidePaneId: paneId, activePaneId }
            }),
          },
        }
      }),

    setContainerCollapsed: (projectId, collapsed) =>
      updateContainer(projectId, (c) => ({ ...c, collapsed })),

    setFullscreenContainer: (projectId) =>
      update((state) => ({
        preferences: { ...state.preferences, fullscreenContainerId: projectId },
      })),
  }
}
