/** Fronts of work inside a project: create, rename, collapse and close. */

import { nanoid } from 'nanoid'

import { getLocale, translate } from '../lib/i18n'
import { removePanesFromWorkspace } from '../lib/paneRemoval'
import { collectTerminalPtyIds } from '../lib/terminalFactory'
import { cleanupPtys } from '../lib/terminalLifecycle'
import type { PaneGroup, Project, Terminal } from '../lib/types'
import { dropPaneInbox } from './paneInboxStore'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

type GroupsSlice = Pick<
  ProjectsState,
  | 'createGroup'
  | 'renameGroup'
  | 'setGroupCollapsed'
  | 'closeGroup'
  | 'closeGroupWithWorktree'
  | 'adoptGroupWorktree'
>

/** Panes belonging to a group, including any left without one by an older build. */
export function panesOfGroup(project: Project | undefined, groupId: string): Terminal[] {
  return (project?.terminals ?? []).filter((terminal) => terminal.groupId === groupId)
}

/**
 * Staged, unstaged, untracked and conflicted entries in a worktree, or `null`
 * when git could not say.
 *
 * `null` is not zero, and conflating the two is how a front gets deleted
 * without asking: removal runs with `--force`, so "I could not read the tree"
 * must not take the same path as "the tree is clean". A repository in a state
 * the command does not understand, a half-broken worktree or an unreadable
 * `.git` are exactly the cases where there is most to lose.
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
    return null
  }
}

export function createGroupsSlice({ get, update, updateProject }: SliceCtx): GroupsSlice {
  /** Drops the panes and the group itself from every place that remembers them. */
  const dropGroup = (projectId: string, groupId: string) =>
    update((state) => {
      const project = state.projects.find((p) => p.id === projectId)
      if (!project) return
      const panes = panesOfGroup(project, groupId)
      const paneIds = new Set(panes.map((pane) => pane.id))
      if (panes.length > 0) cleanupPtys(collectTerminalPtyIds(panes))
      for (const id of paneIds) dropPaneInbox(id)
      return removePanesFromWorkspace({
        projects: state.projects,
        workspace: state.workspace,
        todos: state.todos,
        projectId,
        paneIds,
        groupIds: new Set([groupId]),
      })
    })

  return {
    createGroup: (projectId, args) => {
      const group: PaneGroup = {
        id: nanoid(),
        name: args.name.trim() || t('ui.group.untitled'),
        ...(args.worktreeAgentId ? { worktreeAgentId: args.worktreeAgentId } : {}),
        ...(args.cwd?.trim() ? { cwd: args.cwd.trim() } : {}),
        createdAt: Date.now(),
      }
      updateProject(projectId, (project) => ({
        ...project,
        groups: [...(project.groups ?? []), group],
      }))
      return group
    },

    /**
     * Records the worktree a group's first session provisioned.
     *
     * The provisioning lives in `createAgentTerminal`, which knows nothing
     * about groups; this is how the front takes ownership of what came back,
     * and it is what makes closing the front able to remove it.
     */
    adoptGroupWorktree: (projectId, groupId, worktree) =>
      updateProject(projectId, (project) => ({
        ...project,
        groups: (project.groups ?? []).map((group) =>
          group.id === groupId
            ? {
                ...group,
                worktreeAgentId: worktree.worktreeAgentId,
                ...(worktree.cwd?.trim() ? { cwd: worktree.cwd.trim() } : {}),
              }
            : group,
        ),
      })),

    renameGroup: (projectId, groupId, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      updateProject(projectId, (project) => ({
        ...project,
        groups: (project.groups ?? []).map((group) =>
          group.id === groupId ? { ...group, name: trimmed } : group,
        ),
      }))
    },

    setGroupCollapsed: (projectId, groupId, collapsed) =>
      updateProject(projectId, (project) => ({
        ...project,
        groups: (project.groups ?? []).map((group) =>
          group.id === groupId ? { ...group, collapsed } : group,
        ),
      })),

    /** Closes a group without touching disk. The worktree-aware path is below. */
    closeGroup: (projectId, groupId) => dropGroup(projectId, groupId),

    /**
     * Closes a front of work and removes the worktree it created.
     *
     * A group that works on the project's own tree owns nothing on disk, so it
     * closes straight away — removing anything there would take the checkout
     * everything else shares.
     *
     * `assumeConfirmed` is for a caller that already asked, which the command
     * line does. `window.confirm` blocks the entire renderer while it is up:
     * a second question nobody can see stops the window answering anything at
     * all, including the commands queued behind it.
     */
    closeGroupWithWorktree: async (projectId, groupId, options) => {
      const project = get().projects.find((p) => p.id === projectId)
      const group = (project?.groups ?? []).find((item) => item.id === groupId)
      if (!project || !group) return

      const worktreePath = group.cwd?.trim()
      if (!group.worktreeAgentId || !worktreePath) {
        dropGroup(projectId, groupId)
        return
      }

      const { killPtyTree, worktreeRemove, worktreeList, gitStatus } = await import('../lib/tauri')

      const repo = project.defaultCwd?.trim() ?? ''
      // A worktree the repository no longer lists is already gone, and nothing
      // that does not exist can be holding work worth asking about. Most fronts
      // in a migrated workspace are exactly this: the pane outlived the tree it
      // was opened in. A listing that fails says nothing either way, so that
      // falls through to the careful path.
      const stillOnDisk =
        repo.length > 0 &&
        (await worktreeList(repo)
          .then((list) => list.some((entry) => entry.agentId === group.worktreeAgentId))
          .catch(() => true))

      if (stillOnDisk && !options?.assumeConfirmed) {
        // Removal runs `git worktree remove --force`, which overrides the very
        // guard git raises for a dirty tree — modified and untracked files go
        // with it. Ask only when there is something to lose; a clean worktree
        // goes silently, which is the common case.
        const pending = await countPendingChanges(gitStatus, worktreePath)
        // Ask when there is something to lose, and ask again when it is not
        // even possible to tell — a click costs less than the day's work.
        if (pending === null || pending > 0) {
          const confirmed = window.confirm(
            pending === null
              ? t('ui.group.unknownOnClose', { name: group.name, path: worktreePath })
              : t('ui.group.dirtyOnClose', { count: pending, name: group.name }),
          )
          // Cancel means cancel: the group stays open and the worktree stays on
          // disk. Closing the panes anyway would lose the sessions the user
          // just chose to keep, and the work would only survive by accident.
          if (!confirmed) return
        }
      }

      const panes = panesOfGroup(
        get().projects.find((p) => p.id === projectId),
        groupId,
      )
      await Promise.all(collectTerminalPtyIds(panes).map((id) => killPtyTree(id).catch(() => [])))

      let removed = !stillOnDisk
      if (repo && stillOnDisk) {
        try {
          await worktreeRemove(repo, group.worktreeAgentId, true)
          removed = true
        } catch (firstError) {
          if (String(firstError).includes('worktree_not_found')) {
            removed = true
          } else {
            // The processes above have just been killed; git sees their locks
            // for a moment longer.
            await new Promise((resolve) => setTimeout(resolve, 400))
            try {
              await worktreeRemove(repo, group.worktreeAgentId, true)
              removed = true
            } catch (secondError) {
              removed = String(secondError).includes('worktree_not_found')
              if (!removed) {
                console.warn('[groups] could not remove the worktree on close:', secondError)
              }
            }
          }
        }
      }

      // A worktree left on disk is not a reason to keep the group: it goes to
      // the list the app already sweeps, so the pane stops standing in for it.
      if (!removed) {
        get().addOrphanWorktree(projectId, { path: worktreePath, mode: 'gitWorktree' })
        useUiStore.getState().pushToast({
          title: t('ui.group.worktreeLeftTitle'),
          body: t('ui.group.worktreeLeftBody', { path: worktreePath }),
        })
      }

      dropGroup(projectId, groupId)
    },
  }
}
