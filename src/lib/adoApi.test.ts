import { describe, expect, it } from 'vitest'

import { parsePullRequestArtifactLink } from './adoApi'

describe('parsePullRequestArtifactLink', () => {
  it('decodes the ADO PullRequestId artifact link', () => {
    expect(
      parsePullRequestArtifactLink(
        'vstfs:///Git/PullRequestId/project-guid%2Frepo-guid%2F10681',
      ),
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
