import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPullRequest, parsePullRequestArtifactLink } from './adoApi'

describe('parsePullRequestArtifactLink', () => {
  it('decodes the ADO PullRequestId artifact link', () => {
    expect(
      parsePullRequestArtifactLink('vstfs:///Git/PullRequestId/project-guid%2Frepo-guid%2F10681'),
    ).toEqual({
      projectId: 'project-guid',
      repositoryId: 'repo-guid',
      prId: 10681,
    })
  })

  it('returns null for non-PR artifact links', () => {
    expect(parsePullRequestArtifactLink('vstfs:///Git/Commit/abc')).toBeNull()
    expect(parsePullRequestArtifactLink('vstfs:///Wit/WorkItem/22447')).toBeNull()
    expect(parsePullRequestArtifactLink('')).toBeNull()
  })

  it('refuses malformed ids instead of storing 0', () => {
    expect(parsePullRequestArtifactLink('vstfs:///Git/PullRequestId/p%2Fr%2Fnope')).toBeNull()
  })
})

describe('fetchPullRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the organization, not the work item project, and reports where the PR lives', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('/threads')) {
          return { ok: true, json: async () => ({ value: [{ status: 'active' }] }) }
        }
        return {
          ok: true,
          json: async () => ({
            pullRequestId: 10928,
            status: 'completed',
            url: 'https://dev.azure.com/EuMedicoResidente/project-guid/_apis/git/repositories/repo-guid/pullRequests/10928',
            repository: { id: 'repo-guid', name: 'EGA', project: { name: 'Eduardo' } },
          }),
        }
      }),
    )

    const snapshot = await fetchPullRequest(
      { org: 'EuMedicoResidente', project: 'Plataforma EMR', workItemId: 22312, prId: 10928 },
      'pat',
    )

    expect(calls[0]).toBe(
      'https://dev.azure.com/EuMedicoResidente/_apis/git/pullrequests/10928?api-version=7.0',
    )
    expect(calls[1]).toContain('/repositories/repo-guid/pullRequests/10928/threads')
    expect(snapshot).toMatchObject({
      repositoryName: 'EGA',
      projectName: 'Eduardo',
      hasActiveThreads: true,
    })
  })
})
