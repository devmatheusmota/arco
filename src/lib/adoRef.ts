/** One pull request under a reference. Several can hang off the same work item. */
export type AdoPullRequest = {
  id: number
  /** Repository slug for `_git/<repo>/pullrequest/<id>` URLs. Missing means no link. */
  repository?: string
  /**
   * Project the pull request lives in, when it differs from the work item's.
   * Boards and code sit in separate ADO projects here — a work item in
   * "Plataforma EMR" pointing at a pull request in "SOA" — and the reference's
   * own `project` addresses the board.
   */
  project?: string
}

/**
 * Structured link from a task to an Azure DevOps work item and the pull requests
 * opened under it. The morning briefing skill and any external tool that creates
 * tasks through the CLI encode the reference here rather than shoving it into
 * the title or the notes as free text, so the sidebar can render clickable chips
 * and the watcher can poll the right endpoints.
 */
export type AdoRef = {
  /** Organization slug (`EuMedicoResidente`) or the full org URL — normalized on parse. */
  org: string
  /** Project name as it appears in the URL, decoded (`Plataforma EMR`, not `Plataforma%20EMR`). */
  project: string
  workItemId: number
  /** Pull requests linked to the task, in the order they were linked. */
  prs?: AdoPullRequest[]
}

/** Defaults filled in when the input is just an id (`#22447`, `!10681`, or `22447`). */
export type AdoRefDefaults = {
  org?: string
  project?: string
  repository?: string
}

const WORK_ITEM_URL = new RegExp(
  '^https?://dev\\.azure\\.com/([^/]+)/([^/]+)/(?:_workitems/edit|_boards/board/[^/]+/backlogs)/(\\d+)',
  'i',
)
const PR_URL = new RegExp(
  '^https?://dev\\.azure\\.com/([^/]+)/([^/]+)/_git/([^/]+)/pullrequest/(\\d+)',
  'i',
)
const SHORT_REF = /^([!#])?(\d{1,7})$/
const ORG_PROJECT_ID = /^([^/#]+)\/([^#!]+)([#!])(\d{1,7})$/

/**
 * Parses a task's Azure DevOps reference from a URL, a short id or a compact
 * `org/project#id` form.
 *
 * The morning briefing hands in fully-qualified URLs; a human typing `--ado
 * #22447` in the terminal expects the current project's defaults to fill in.
 * Returns `null` when the input carries no id at all, so a caller can tell a
 * typo apart from a deliberate detach.
 */
export function parseAdoRef(input: string, defaults: AdoRefDefaults = {}): AdoRef | null {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value) return null

  const pr = PR_URL.exec(value)
  if (pr) {
    const project = decodeSlug(pr[2])
    return {
      org: decodeSlug(pr[1]),
      project,
      workItemId: 0,
      prs: [{ id: Number(pr[4]), repository: decodeSlug(pr[3]), project }],
    }
  }

  const workItem = WORK_ITEM_URL.exec(value)
  if (workItem) {
    return {
      org: decodeSlug(workItem[1]),
      project: decodeSlug(workItem[2]),
      workItemId: Number(workItem[3]),
    }
  }

  const compact = ORG_PROJECT_ID.exec(value)
  if (compact) {
    const [, org, project, marker, id] = compact
    const numericId = Number(id)
    return marker === '!'
      ? {
          org: decodeSlug(org),
          project: project.trim(),
          workItemId: 0,
          prs: [pullRequest(numericId, project.trim(), defaults.repository)],
        }
      : { org: decodeSlug(org), project: project.trim(), workItemId: numericId }
  }

  const short = SHORT_REF.exec(value)
  if (short) {
    if (!defaults.org || !defaults.project) return null
    const [, marker, id] = short
    const numericId = Number(id)
    if (marker === '!') {
      return {
        org: defaults.org,
        project: defaults.project,
        workItemId: 0,
        prs: [pullRequest(numericId, defaults.project, defaults.repository)],
      }
    }
    return { org: defaults.org, project: defaults.project, workItemId: numericId }
  }

  return null
}

/**
 * Merges two references from the same source, so a PR-only URL later paired with
 * a work-item id keeps both — the CLI is expected to hand in one at a time.
 *
 * Pull requests accumulate rather than replace each other: a task routinely
 * carries more than one, and linking the second used to erase the first.
 */
export function mergeAdoRef(base: AdoRef | undefined, next: AdoRef): AdoRef {
  if (!base) return next
  // The work item's project addresses the board, each pull request carries the
  // one that addresses its code, and here the two routinely differ. Whichever
  // side brought the work item decides the reference's project; the rest travels
  // with the pull request it belongs to.
  const fromWorkItem = [next, base].find((ref) => ref.workItemId > 0)
  const merged: AdoRef = {
    org: next.org || base.org,
    project: fromWorkItem?.project ?? next.project ?? base.project,
    workItemId: next.workItemId || base.workItemId,
  }
  // A pull request project equal to the work item's is noise the URL builder
  // would ignore anyway, so it is dropped rather than stored on every entry.
  const prs = mergePullRequests(base.prs, next.prs).map((pr) => {
    if (!pr.project || pr.project !== merged.project) return pr
    const { project: _project, ...rest } = pr
    return rest
  })
  if (prs.length > 0) merged.prs = prs
  return merged
}

/** Union by id, first link first; a repeat refines what the earlier one knew. */
function mergePullRequests(base: AdoPullRequest[] = [], next: AdoPullRequest[] = []) {
  const byId = new Map<number, AdoPullRequest>()
  for (const pr of [...base, ...next]) {
    const current = byId.get(pr.id)
    byId.set(pr.id, current ? { ...current, ...pr } : pr)
  }
  return [...byId.values()]
}

/** Best-effort validation used when reading a stored file: drops garbage silently. */
export function normalizeAdoRef(value: unknown): AdoRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AdoRef> & LegacyPullRequest
  const org = typeof raw.org === 'string' ? raw.org.trim() : ''
  const project = typeof raw.project === 'string' ? raw.project.trim() : ''
  const workItemId = typeof raw.workItemId === 'number' && raw.workItemId >= 0 ? raw.workItemId : 0
  if (!org || !project) return null
  const prs = normalizePullRequests(raw)
  if (workItemId === 0 && prs.length === 0) return null
  const ref: AdoRef = { org, project, workItemId }
  if (prs.length > 0) ref.prs = prs
  return ref
}

/**
 * Shape of a reference written before a task could carry more than one pull
 * request: the single id sat at the top level next to the work item's fields.
 */
type LegacyPullRequest = { prId?: unknown; repository?: unknown; prProject?: unknown }

/**
 * The pull requests of a stored reference, reading the pre-list shape as the
 * first entry — which is the whole migration an old `projects.json` needs.
 */
function normalizePullRequests(raw: Partial<AdoRef> & LegacyPullRequest): AdoPullRequest[] {
  const source: unknown[] = Array.isArray(raw.prs)
    ? raw.prs
    : [{ id: raw.prId, repository: raw.repository, project: raw.prProject }]
  const result: AdoPullRequest[] = []
  const seen = new Set<number>()
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const entry = item as { id?: unknown; repository?: unknown; project?: unknown }
    const id = typeof entry.id === 'number' && entry.id > 0 ? entry.id : 0
    if (!id || seen.has(id)) continue
    seen.add(id)
    const pr: AdoPullRequest = { id }
    if (typeof entry.repository === 'string' && entry.repository.trim()) {
      pr.repository = entry.repository.trim()
    }
    if (typeof entry.project === 'string' && entry.project.trim()) {
      pr.project = entry.project.trim()
    }
    result.push(pr)
  }
  return result
}

/** The pull requests a reference carries, in the order they were linked. */
export function adoPullRequests(ref: AdoRef | undefined | null): AdoPullRequest[] {
  return ref?.prs ?? []
}

/** A pull request entry, keeping only the fields that were actually known. */
function pullRequest(id: number, project?: string, repository?: string): AdoPullRequest {
  return {
    id,
    ...(project ? { project } : {}),
    ...(repository ? { repository } : {}),
  }
}

/** Public URL for a work item, used by the sidebar chip. */
export function workItemUrl(ref: AdoRef): string {
  return `https://dev.azure.com/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.project)}/_workitems/edit/${ref.workItemId}`
}

/**
 * Public URL for one of a reference's pull requests; requires the repository,
 * which is captured on parse.
 *
 * The project is the pull request's own when it has one. A work item in
 * "Plataforma EMR" routinely points at a pull request in "SOA", and pairing the
 * board's project with the code's repository produces a URL that resolves to
 * nothing — ADO answers "Repository not found".
 */
export function pullRequestUrl(ref: AdoRef, pr: AdoPullRequest): string | null {
  if (!pr.id || !pr.repository) return null
  const project = pr.project?.trim() || ref.project
  return `https://dev.azure.com/${encodeURIComponent(ref.org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(pr.repository)}/pullrequest/${pr.id}`
}

/** Decodes `%20` back into spaces so a stored project name reads as the user sees it. */
function decodeSlug(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'))
  } catch {
    return value
  }
}
