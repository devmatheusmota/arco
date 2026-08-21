import { useEffect, useRef } from 'react'

import {
  AdoApiError,
  type AdoPullRequestSnapshot,
  type AdoWorkItemSnapshot,
  fetchPullRequest,
  fetchWorkItem,
  fetchWorkItemPullRequestLinks,
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
  const repairedTodoIds = useRef(new Set<string>())

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

    async function autoAttachPullRequest(todo: TodoItem, pat: string): Promise<TodoItem> {
      if (!todo.adoRef || todo.adoRef.prId || !todo.adoRef.workItemId) return todo
      try {
        const links = await fetchWorkItemPullRequestLinks(todo.adoRef, pat)
        if (links.length === 0) return todo
        // Newest first — ADO does not order the relations, but the largest id is
        // the most recent by construction.
        const ordered = [...links].sort((a, b) => b.prId - a.prId)
        // A work item keeps its pull request links forever, so the newest one
        // can be a merge from months ago. Attaching that puts a dead PR on a
        // card that is still being refined, which is what #19394 showed: the
        // chip pointed at !10398, completed back in July.
        let latest: (typeof ordered)[number] | undefined
        let latestSnapshot: AdoPullRequestSnapshot | null = null
        for (const link of ordered) {
          const snapshot = await fetchPullRequest({ ...todo.adoRef, prId: link.prId }, pat)
          if (snapshot && snapshot.status === 'active') {
            latest = link
            latestSnapshot = snapshot
            break
          }
        }
        if (!latest) return todo
        // The link only carries GUIDs, and a GUID in a browser URL is not what
        // the user reads on a chip. The pull request itself answers with the
        // repository slug and the project it lives in — usually not the work
        // item's, and keeping the board's project there builds a URL that
        // resolves to nothing ("Repository not found").
        const merged = {
          ...todo.adoRef,
          prId: latest.prId,
          repository: latestSnapshot?.repositoryName ?? latest.repositoryId,
          prProject: latestSnapshot?.projectName ?? latest.projectId,
        }
        useProjectsStore.getState().setTodoAdoRef(todo.id, merged, 'merge')
        return { ...todo, adoRef: merged }
      } catch (error) {
        if (error instanceof AdoApiError && error.status === 401) reportPatFailure()
        return todo
      }
    }

    async function reconcileTask(rawTodo: TodoItem, pat: string): Promise<void> {
      if (!rawTodo.adoRef) return
      const todo = await autoAttachPullRequest(rawTodo, pat)
      if (cancelled || !todo.adoRef) return
      let snapshot: [AdoWorkItemSnapshot | null, AdoPullRequestSnapshot | null]
      try {
        snapshot = await Promise.all([
          fetchWorkItem(todo.adoRef, pat),
          fetchPullRequest(todo.adoRef, pat),
        ])
      } catch (error) {
        if (error instanceof AdoApiError && error.status === 401) {
          reportPatFailure()
        }
        return
      }
      const [workItem, pullRequest] = snapshot
      if (cancelled) return
      realignPullRequestLocation(todo, pullRequest)
      const event = planTaskTransition(todo, { workItem, pullRequest }, identityRef.current)
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

    /**
     * Repairs a reference whose pull request coordinates point at the wrong
     * place. A task created from a work item URL inherits the board's project,
     * and one attached by an older build stored the repository GUID — both
     * render a chip that opens "Repository not found". The pull request is the
     * authority on where it lives, so its answer overwrites what was guessed.
     */
    function realignPullRequestLocation(
      todo: TodoItem,
      pullRequest: AdoPullRequestSnapshot | null,
    ): void {
      const ref = todo.adoRef
      if (!ref || !pullRequest?.repositoryName || !pullRequest.projectName) return
      const projectMatches = (ref.prProject?.trim() || ref.project) === pullRequest.projectName
      if (ref.repository === pullRequest.repositoryName && projectMatches) return
      useProjectsStore.getState().setTodoAdoRef(
        todo.id,
        {
          ...ref,
          repository: pullRequest.repositoryName,
          prProject: pullRequest.projectName,
        },
        'merge',
      )
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

    /**
     * Checks every task that carries a pull request once per app run, so a chip
     * stored with the wrong project — or with a repository GUID — starts opening
     * the pull request without waiting for the task to be watched. Watching is
     * opt-in because it drives status transitions; a link that points at nothing
     * is a defect, and repairing it costs one call per task, once.
     */
    async function repairPullRequestChips(todos: TodoItem[], pat: string): Promise<void> {
      const pending = todos.filter(
        (todo) => todo.adoRef?.prId && !repairedTodoIds.current.has(todo.id),
      )
      if (pending.length === 0) return
      await Promise.all(
        pending.map(async (todo) => {
          repairedTodoIds.current.add(todo.id)
          try {
            realignPullRequestLocation(todo, await fetchPullRequest(todo.adoRef!, pat))
          } catch (error) {
            if (error instanceof AdoApiError && error.status === 401) reportPatFailure()
          }
        }),
      )
    }

    async function tick(): Promise<void> {
      const state = useProjectsStore.getState()
      const pat = state.preferences.adoPat?.trim()
      if (!pat) return
      await repairPullRequestChips(state.todos, pat)
      const watched = state.todos.filter((todo) => todo.watch && todo.adoRef && !todo.completed)
      if (watched.length === 0) return
      await ensureIdentity(pat)
      await Promise.all(watched.map((todo) => reconcileTask(todo, pat)))
    }

    // First run right after subscribe so a task marked as watch reacts within
    // seconds, not after a full interval.
    void tick()
    const interval = window.setInterval(
      () => {
        const secs = useProjectsStore.getState().preferences.adoPollSecs
        if (Number.isFinite(secs) && secs > 0) void tick()
      },
      Math.max(
        60_000,
        Math.round((useProjectsStore.getState().preferences.adoPollSecs ?? 300) * 1000),
      ),
    )

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])
}
