import type { TodoAdoRef } from './types'

/**
 * The one Azure DevOps call Arco makes: where does this pull request live?
 *
 * Nothing here polls and nothing here moves a task. A reference is written by
 * hand or by the command line, and both can only guess the pull request's
 * project — a task created from a work item URL inherits the board's, and this
 * organisation keeps boards and code in separate projects. The guess renders a
 * chip that opens "Repository not found", and the pull request itself is the
 * only authority on the answer.
 */

export class AdoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'AdoApiError'
  }
}

export type AdoPullRequestLocation = {
  /** Repository slug as it appears in a browser URL (`EGA`), never the GUID. */
  repositoryName: string
  /** Project the repository lives in — the only one that resolves a PR URL. */
  projectName: string
}

/** A PAT travels as HTTP Basic with an empty username, which is what ADO accepts. */
function authHeader(pat: string): string {
  return `Basic ${btoa(`:${pat}`)}`
}

export async function fetchPullRequestLocation(
  ref: TodoAdoRef,
  pat: string,
): Promise<AdoPullRequestLocation | null> {
  if (!ref.prId) return null
  // Asked at the organization level on purpose: a pull request id is unique
  // across the org, while the project the task carries is the work item's, which
  // is routinely not the code's. Scoping the call to it answers 404 for every
  // pull request that lives somewhere else — the exact case worth repairing.
  const url = `https://dev.azure.com/${encodeURIComponent(ref.org)}/_apis/git/pullrequests/${ref.prId}?api-version=7.0`
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: authHeader(pat) },
  })
  if (!response.ok) throw new AdoApiError(`ADO API returned ${response.status}`, response.status)
  const raw = (await response.json()) as {
    repository?: { name?: string; project?: { name?: string } }
  }
  const repositoryName = raw.repository?.name
  const projectName = raw.repository?.project?.name
  if (!repositoryName || !projectName) return null
  return { repositoryName, projectName }
}

/**
 * The reference a task should carry, or null when the stored one is already
 * right. Kept apart from the request so the decision is testable without a
 * network, and so a repair never writes a reference identical to the old one.
 */
export function realignedRef(
  ref: TodoAdoRef,
  location: AdoPullRequestLocation | null,
): TodoAdoRef | null {
  if (!location) return null
  const projectMatches = (ref.prProject?.trim() || ref.project) === location.projectName
  if (ref.repository === location.repositoryName && projectMatches) return null
  return {
    ...ref,
    repository: location.repositoryName,
    // Dropped rather than stored when the two sides agree: a `prProject` equal
    // to `project` is noise that the URL builder would ignore anyway.
    ...(location.projectName === ref.project
      ? { prProject: undefined }
      : { prProject: location.projectName }),
  }
}
