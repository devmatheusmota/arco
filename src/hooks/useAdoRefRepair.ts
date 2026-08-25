import { useEffect, useRef } from 'react'

import { AdoApiError, fetchPullRequestLocation, realignedRef } from '../lib/adoApi'
import { getLocale, translate } from '../lib/i18n'
import type { TodoItem } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Repairs pull request chips that point at the wrong place, once per app run.
 *
 * This is not a watcher: it reads no state, moves no task and runs on no timer.
 * It answers one question per linked task — where does this pull request
 * actually live — and rewrites the reference only when the stored one is wrong.
 * A chip that opens "Repository not found" is a defect, and leaving it there
 * until someone notices costs more than one call per task.
 *
 * Needs the personal access token in Preferences. Without it the pass does
 * nothing at all, silently: a missing token is a choice, not a failure.
 */
export function useAdoRefRepair(hydrated: boolean): void {
  const repaired = useRef(new Set<string>())
  const reported = useRef(false)

  useEffect(() => {
    if (!hydrated) return
    let cancelled = false

    async function repair(todo: TodoItem, pat: string): Promise<void> {
      const ref = todo.adoRef
      if (!ref) return
      try {
        const next = realignedRef(ref, await fetchPullRequestLocation(ref, pat))
        if (!next || cancelled) return
        useProjectsStore.getState().setTodoAdoRef(todo.id, next)
      } catch (error) {
        // One notice per run: a token that is refused is refused for every task,
        // and a toast per linked task would bury the window.
        if (error instanceof AdoApiError && error.status === 401 && !reported.current) {
          reported.current = true
          useUiStore.getState().pushToast({
            title: translate(getLocale(), 'toast.adoAuthTitle'),
            body: translate(getLocale(), 'toast.adoAuthBody'),
          })
        }
      }
    }

    const state = useProjectsStore.getState()
    const pat = state.preferences.adoPat?.trim()
    if (!pat) return

    const pending = state.todos.filter(
      (todo) => todo.adoRef?.prId && !repaired.current.has(todo.id),
    )
    if (pending.length === 0) return
    for (const todo of pending) repaired.current.add(todo.id)
    void Promise.all(pending.map((todo) => repair(todo, pat)))

    return () => {
      cancelled = true
    }
  }, [hydrated])
}
