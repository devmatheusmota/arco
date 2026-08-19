import type { TodoAdoRef } from './types'

/**
 * Read-only Azure DevOps client used by the watcher.
 *
 * Every call carries a PAT as HTTP Basic (with an empty username), which is
 * the shape ADO's REST API accepts. The client is deliberately narrow: only
 * what the watcher needs to decide a transition on a task lives here — the
 * rest of the API is out of scope.
 */

export type AdoWorkItemSnapshot = {
  id: number
  state: string
  assignedToUniqueName?: string
  changedDate?: string
}

export type AdoPullRequestSnapshot = {
  id: number
  status: 'active' | 'abandoned' | 'completed'
  isDraft: boolean
  createdByUniqueName?: string
  reviewers: AdoReviewerSnapshot[]
  hasActiveThreads: boolean
  latestCommitDate?: string
  repositoryId?: string
}

export type AdoReviewerSnapshot = {
  uniqueName?: string
  vote: number
  isRequired: boolean
}

export class AdoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message)
    this.name = 'AdoApiError'
  }
}

function authHeader(pat: string): string {
  const token = btoa(`:${pat}`)
  return `Basic ${token}`
}

function baseUrl(ref: Pick<TodoAdoRef, 'org' | 'project'>): string {
  return `https://dev.azure.com/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.project)}`
}

async function request<T>(url: string, pat: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(pat),
    },
  })
  if (!response.ok) {
    throw new AdoApiError(`ADO API returned ${response.status}`, response.status, url)
  }
  return (await response.json()) as T
}

export async function fetchWorkItem(
  ref: TodoAdoRef,
  pat: string,
): Promise<AdoWorkItemSnapshot | null> {
  if (!ref.workItemId) return null
  const url = `${baseUrl(ref)}/_apis/wit/workitems/${ref.workItemId}?fields=System.State,System.AssignedTo,System.ChangedDate&api-version=7.0`
  const raw = (await request(url, pat)) as {
    id: number
    fields?: Record<string, unknown>
  }
  const fields = raw.fields ?? {}
  const state = typeof fields['System.State'] === 'string' ? (fields['System.State'] as string) : ''
  const assignedTo = fields['System.AssignedTo']
  const changedDate =
    typeof fields['System.ChangedDate'] === 'string'
      ? (fields['System.ChangedDate'] as string)
      : undefined
  return {
    id: raw.id,
    state,
    assignedToUniqueName:
      typeof assignedTo === 'object' && assignedTo !== null && 'uniqueName' in assignedTo
        ? String((assignedTo as { uniqueName?: unknown }).uniqueName ?? '')
        : undefined,
    changedDate,
  }
}

export async function fetchPullRequest(
  ref: TodoAdoRef,
  pat: string,
): Promise<AdoPullRequestSnapshot | null> {
  if (!ref.prId) return null
  const url = `${baseUrl(ref)}/_apis/git/pullrequests/${ref.prId}?api-version=7.0`
  const raw = (await request(url, pat)) as {
    pullRequestId: number
    status: string
    isDraft?: boolean
    createdBy?: { uniqueName?: string }
    reviewers?: Array<{ uniqueName?: string; vote?: number; isRequired?: boolean }>
    lastMergeSourceCommit?: { commitId?: string; url?: string }
    repository?: { id?: string }
  }
  const threadsUrl = `${baseUrl(ref)}/_apis/git/repositories/${encodeURIComponent(raw.repository?.id ?? '')}/pullRequests/${ref.prId}/threads?api-version=7.0`
  const threads = raw.repository?.id
    ? ((await request(threadsUrl, pat)) as {
        value?: Array<{ status?: string; isDeleted?: boolean }>
      })
    : { value: [] }
  const hasActiveThreads =
    (threads.value ?? []).some(
      (thread) => !thread.isDeleted && (thread.status ?? '').toLowerCase() === 'active',
    ) ?? false

  return {
    id: raw.pullRequestId,
    status:
      raw.status === 'completed' || raw.status === 'abandoned' || raw.status === 'active'
        ? raw.status
        : 'active',
    isDraft: Boolean(raw.isDraft),
    createdByUniqueName: raw.createdBy?.uniqueName,
    reviewers: (raw.reviewers ?? []).map((reviewer) => ({
      uniqueName: reviewer.uniqueName,
      vote: typeof reviewer.vote === 'number' ? reviewer.vote : 0,
      isRequired: Boolean(reviewer.isRequired),
    })),
    hasActiveThreads,
    repositoryId: raw.repository?.id,
  }
}
