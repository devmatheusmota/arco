/**
 * Structured link from a task to an Azure DevOps work item (and, optionally, the
 * pull request it lives in). The morning briefing skill and any external tool
 * that creates tasks through the CLI encode the reference here rather than
 * shoving it into the title or the notes as free text, so the sidebar can render
 * a clickable chip and the watcher can poll the right endpoints.
 */
export type AdoRef = {
  /** Organization slug (`EuMedicoResidente`) or the full org URL — normalized on parse. */
  org: string
  /** Project name as it appears in the URL, decoded (`Plataforma EMR`, not `Plataforma%20EMR`). */
  project: string
  workItemId: number
  prId?: number
  /** Repository slug for `_git/<repo>/pullrequest/<id>` URLs. Missing for pure work-item refs. */
  repository?: string
  /**
   * Project the pull request lives in, when it differs from the work item's.
   * Boards and code sit in separate ADO projects here — a work item in
   * "Plataforma EMR" pointing at a pull request in "SOA" — and one `project`
   * field cannot address both endpoints.
   */
  prProject?: string
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
    return {
      org: decodeSlug(pr[1]),
      project: decodeSlug(pr[2]),
      repository: decodeSlug(pr[3]),
      workItemId: 0,
      prId: Number(pr[4]),
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
          prId: numericId,
          ...(defaults.repository ? { repository: defaults.repository } : {}),
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
        prId: numericId,
        ...(defaults.repository ? { repository: defaults.repository } : {}),
      }
    }
    return { org: defaults.org, project: defaults.project, workItemId: numericId }
  }

  return null
}

/**
 * Merges two references from the same source, so a PR-only URL later paired
 * with a work-item id keeps both — the CLI is expected to hand in one at a time.
 */
export function mergeAdoRef(base: AdoRef | undefined, next: AdoRef): AdoRef {
  if (!base) return next
  return {
    ...base,
    ...next,
    workItemId: next.workItemId || base.workItemId,
    ...(next.prId || base.prId ? { prId: next.prId ?? base.prId } : {}),
    ...(next.repository || base.repository
      ? { repository: next.repository ?? base.repository }
      : {}),
    ...(next.prProject || base.prProject ? { prProject: next.prProject ?? base.prProject } : {}),
  }
}

/** Best-effort validation used when reading a stored file: drops garbage silently. */
export function normalizeAdoRef(value: unknown): AdoRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AdoRef>
  const org = typeof raw.org === 'string' ? raw.org.trim() : ''
  const project = typeof raw.project === 'string' ? raw.project.trim() : ''
  const workItemId = typeof raw.workItemId === 'number' && raw.workItemId >= 0 ? raw.workItemId : 0
  const prId = typeof raw.prId === 'number' && raw.prId > 0 ? raw.prId : undefined
  if (!org || !project) return null
  if (workItemId === 0 && !prId) return null
  const ref: AdoRef = { org, project, workItemId }
  if (prId) ref.prId = prId
  if (typeof raw.repository === 'string' && raw.repository.trim()) {
    ref.repository = raw.repository.trim()
  }
  if (typeof raw.prProject === 'string' && raw.prProject.trim()) {
    ref.prProject = raw.prProject.trim()
  }
  return ref
}

/** Public URL for a work item, used by the sidebar chip. */
export function workItemUrl(ref: AdoRef): string {
  return `https://dev.azure.com/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.project)}/_workitems/edit/${ref.workItemId}`
}

/**
 * Public URL for a pull request; requires the repository, which is captured on parse.
 *
 * The project is the pull request's own when it has one. A work item in
 * "Plataforma EMR" routinely points at a pull request in "SOA", and pairing the
 * board's project with the code's repository produces a URL that resolves to
 * nothing — ADO answers "Repository not found".
 */
export function pullRequestUrl(ref: AdoRef): string | null {
  if (!ref.prId || !ref.repository) return null
  const project = ref.prProject?.trim() || ref.project
  return `https://dev.azure.com/${encodeURIComponent(ref.org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(ref.repository)}/pullrequest/${ref.prId}`
}

/** Decodes `%20` back into spaces so a stored project name reads as the user sees it. */
function decodeSlug(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'))
  } catch {
    return value
  }
}
