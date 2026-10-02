import { useEffect } from 'react'

import { getLocale, translate } from '../lib/i18n'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Waits this long after the workspace loads, so the sweep never competes with
 * restoring the sessions the user opened the app to get back to.
 */
const SWEEP_DELAY_MS = 30_000

/**
 * Looks once per app run for worktrees no front or session holds, and says so.
 *
 * Worktrees only reached the leftover list when a removal failed, and dozens
 * whose fronts disappeared some other way sat on disk, gigabytes each, with
 * nothing pointing at them. This lists them on their project and raises one
 * notice per project; nothing is removed until the user cleans them up there.
 */
export function useWorktreeSweep(hydrated: boolean): void {
  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void useProjectsStore
        .getState()
        .sweepUntrackedWorktrees()
        .then((gained) => {
          if (cancelled) return
          const projects = useProjectsStore.getState().projects
          for (const { projectId, count } of gained) {
            const project = projects.find((item) => item.id === projectId)
            if (!project) continue
            useUiStore.getState().pushToast({
              title: translate(getLocale(), 'toast.untrackedWorktreesTitle'),
              body: translate(getLocale(), 'toast.untrackedWorktreesBody', {
                count,
                project: project.name,
              }),
              action: {
                label: translate(getLocale(), 'toast.untrackedWorktreesAction'),
                run: () =>
                  useUiStore.getState().openModal_('editProject', { projectId, tab: 'worktrees' }),
              },
            })
          }
        })
        .catch(() => {})
    }, SWEEP_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hydrated])
}
