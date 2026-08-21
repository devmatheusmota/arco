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
  /** Repository slug as it appears in a browser URL (`EGA`), not the GUID. */
  repositoryName?: string
  /** Project the repository lives in — the only one that resolves a PR URL. */
  projectName?: string
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

export type AdoPullRequestLink = {
  prId: number
  repositoryId: string
  projectId: string
}

/**
 * Reads the pull requests a work item points at through its `ArtifactLink`
 * relations. Used by the watcher to auto-attach a `prId` to a task whose
 * only reference so far was the work item — the moment someone opens the PR
 * on the ADO side, the sidebar starts tracking it too.
 */
export async function fetchWorkItemPullRequestLinks(
  ref: TodoAdoRef,
  pat: string,
): Promise<AdoPullRequestLink[]> {
  if (!ref.workItemId) return []
  const url = `${baseUrl(ref)}/_apis/wit/workitems/${ref.workItemId}?$expand=relations&api-version=7.0`
  const raw = (await request(url, pat)) as {
    relations?: Array<{ rel?: string; url?: string; attributes?: { name?: string } }>
  }
  const relations = raw.relations ?? []
  const links: AdoPullRequestLink[] = []
  for (const relation of relations) {
    if (relation.rel !== 'ArtifactLink' || !relation.url) continue
    const parsed = parsePullRequestArtifactLink(relation.url)
    if (parsed) links.push(parsed)
  }
  return links
}

/**
 * Decodes an ADO `vstfs:///Git/PullRequestId/{project}/{repo}/{pr}` link — the
 * shape used inside `ArtifactLink` relations. Non-PR links (commit, work item,
 * anything else) return null.
 */
export function parsePullRequestArtifactLink(url: string): AdoPullRequestLink | null {
  const match = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(url)
  if (!match) return null
  const decoded = decodeURIComponent(match[1])
  const [projectId, repositoryId, prId] = decoded.split('/')
  if (!projectId || !repositoryId || !prId) return null
  const numericPrId = Number(prId)
  if (!Number.isFinite(numericPrId) || numericPrId <= 0) return null
  return { projectId, repositoryId, prId: numericPrId }
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
  // Asked at the organization level on purpose: a pull request id is unique
  // across the org, and the project a task carries is the work item's, which is
  // routinely not the code's. Scoping the call to it answers 404 for every pull
  // request that lives elsewhere.
  const url = `https://dev.azure.com/${encodeURIComponent(ref.org)}/_apis/git/pullrequests/${ref.prId}?api-version=7.0`
  const raw = (await request(url, pat)) as {
    pullRequestId: number
    status: string
    isDraft?: boolean
    createdBy?: { uniqueName?: string }
    reviewers?: Array<{ uniqueName?: string; vote?: number; isRequired?: boolean }>
    lastMergeSourceCommit?: { commitId?: string; url?: string }
    repository?: { id?: string; name?: string; project?: { name?: string } }
    url?: string
  }
  // The self link already points at the right project and repository, so the
  // threads call inherits both instead of guessing them again.
  const threadsUrl = raw.url ? `${raw.url}/threads?api-version=7.0` : null
  const threads = threadsUrl
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
    repositoryName: raw.repository?.name,
    projectName: raw.repository?.project?.name,
  }
}
