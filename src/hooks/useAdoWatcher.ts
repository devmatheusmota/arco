import { useEffect, useRef } from 'react'

import {
  AdoApiError,
  type AdoPullRequestSnapshot,
  type AdoWorkItemSnapshot,
  fetchPullRequest,
  fetchWorkItem,
} from '../lib/adoApi'
import { planTaskTransition, type WatcherIdentity } from '../lib/adoWatcher'
import { getLocale, translate } from '../lib/i18n'
import type { TodoItem } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Runs the Azure DevOps watcher for every task marked with `watch: true`.
 *
 * Poll cadence is fixed by `preferences.adoPollSecs`, and the fetch fleet is
 * bounded by how many tasks the user opted in — no PAT, no polling, no traffic.
 * Errors are reported as a single toast per interval, not per failed request,
 * so a stale PAT does not turn into a stream of notifications.
 */
export function useAdoWatcher(): void {
  const identityRef = useRef<WatcherIdentity>({})
  const identityFetchedForPat = useRef<string | null>(null)
  const lastErrorAt = useRef(0)

  useEffect(() => {
    let cancelled = false

    async function ensureIdentity(pat: string): Promise<void> {
      if (identityFetchedForPat.current === pat) return
      identityFetchedForPat.current = pat
      try {
        const response = await fetch(
          'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.0',
          { headers: { Accept: 'application/json', Authorization: `Basic ${btoa(`:${pat}`)}` } },
        )
        if (!response.ok) return
        const raw = (await response.json()) as { emailAddress?: string; publicAlias?: string }
        identityRef.current = { uniqueName: raw.emailAddress?.trim() || undefined }
      } catch {
        /* Silent — the watcher still works with an empty identity, just less refined. */
      }
    }

    async function reconcileTask(todo: TodoItem, pat: string): Promise<void> {
      if (!todo.adoRef) return
      let workItem: AdoWorkItemSnapshot | null = null
      let pullRequest: AdoPullRequestSnapshot | null = null
      try {
        ;[workItem, pullRequest] = await Promise.all([
          fetchWorkItem(todo.adoRef, pat),
          fetchPullRequest(todo.adoRef, pat),
        ])
      } catch (error) {
        if (error instanceof AdoApiError && error.status === 401) {
          reportPatFailure()
        }
        return
      }
      if (cancelled) return
      const event = planTaskTransition(
        todo,
        { workItem, pullRequest },
        identityRef.current,
      )
      if (!event?.status) return
      const store = useProjectsStore.getState()
      store.setTodoStatus(todo.id, event.status)
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'toast.adoTransitionTitle'),
        body: translate(getLocale(), 'toast.adoTransitionBody', {
          title: todo.title,
          reason: event.reason,
        }),
      })
    }

    function reportPatFailure(): void {
      const now = Date.now()
      if (now - lastErrorAt.current < 15 * 60 * 1000) return
      lastErrorAt.current = now
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'toast.adoAuthTitle'),
        body: translate(getLocale(), 'toast.adoAuthBody'),
      })
    }

    async function tick(): Promise<void> {
      const state = useProjectsStore.getState()
      const pat = state.preferences.adoPat?.trim()
      if (!pat) return
      const watched = state.todos.filter((todo) => todo.watch && todo.adoRef && !todo.completed)
      if (watched.length === 0) return
      await ensureIdentity(pat)
      await Promise.all(watched.map((todo) => reconcileTask(todo, pat)))
    }

    // First run right after subscribe so a task marked as watch reacts within
    // seconds, not after a full interval.
    void tick()
    const interval = window.setInterval(() => {
      const secs = useProjectsStore.getState().preferences.adoPollSecs
      if (Number.isFinite(secs) && secs > 0) void tick()
    }, Math.max(60_000, Math.round((useProjectsStore.getState().preferences.adoPollSecs ?? 300) * 1000)))

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])
}
