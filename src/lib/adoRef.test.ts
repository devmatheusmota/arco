import { describe, expect, it } from 'vitest'

import { mergeAdoRef, normalizeAdoRef, parseAdoRef, pullRequestUrl, workItemUrl } from './adoRef'

describe('parseAdoRef', () => {
  it('reads a work-item URL and decodes the project name', () => {
    expect(
      parseAdoRef('https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_workitems/edit/22447'),
    ).toEqual({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      workItemId: 22447,
    })
  })

  it('reads a pull-request URL and keeps the repository slug', () => {
    expect(
      parseAdoRef(
        'https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_git/SOA/pullrequest/10681',
      ),
    ).toEqual({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      repository: 'SOA',
      workItemId: 0,
      prId: 10681,
    })
  })

  it('accepts the compact `org/project#id` form', () => {
    expect(parseAdoRef('EuMedicoResidente/Plataforma EMR#22447')).toEqual({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      workItemId: 22447,
    })
    expect(parseAdoRef('EuMedicoResidente/Plataforma EMR!10681')).toMatchObject({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      prId: 10681,
    })
  })

  it('resolves a short id against the caller defaults', () => {
    expect(parseAdoRef('#22447', { org: 'EuMedicoResidente', project: 'Plataforma EMR' })).toEqual({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      workItemId: 22447,
    })
    expect(
      parseAdoRef('!10681', {
        org: 'EuMedicoResidente',
        project: 'Plataforma EMR',
        repository: 'SOA',
      }),
    ).toMatchObject({ prId: 10681, repository: 'SOA' })
  })

  it('refuses a short id when no defaults are configured, instead of guessing', () => {
    expect(parseAdoRef('#22447')).toBeNull()
    expect(parseAdoRef('22447')).toBeNull()
  })

  it('returns null for empty input and unknown patterns', () => {
    expect(parseAdoRef('')).toBeNull()
    expect(parseAdoRef('   ')).toBeNull()
    expect(parseAdoRef('not-a-reference')).toBeNull()
  })
})

describe('normalizeAdoRef', () => {
  it('drops garbage silently and requires either a work item or a PR', () => {
    expect(normalizeAdoRef(null)).toBeNull()
    expect(normalizeAdoRef({})).toBeNull()
    expect(normalizeAdoRef({ org: 'x', project: 'y' })).toBeNull()
    expect(normalizeAdoRef({ org: 'x', project: 'y', workItemId: 0, prId: 42 })).toMatchObject({
      org: 'x',
      project: 'y',
      prId: 42,
    })
  })
})

describe('mergeAdoRef', () => {
  it('adds a PR to an existing work-item reference', () => {
    const base = { org: 'o', project: 'p', workItemId: 22447 }
    expect(
      mergeAdoRef(base, { org: 'o', project: 'p', workItemId: 0, prId: 10681, repository: 'SOA' }),
    ).toMatchObject({
      workItemId: 22447,
      prId: 10681,
      repository: 'SOA',
    })
  })
})

describe('urls', () => {
  it('encodes the project name so a space survives the round trip', () => {
    expect(
      workItemUrl({ org: 'EuMedicoResidente', project: 'Plataforma EMR', workItemId: 22447 }),
    ).toBe('https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_workitems/edit/22447')
  })

  it('returns null for a PR url when the repository is unknown', () => {
    expect(pullRequestUrl({ org: 'o', project: 'p', workItemId: 0, prId: 10681 })).toBeNull()
    expect(
      pullRequestUrl({ org: 'o', project: 'p', workItemId: 0, prId: 10681, repository: 'SOA' }),
    ).toContain('/_git/SOA/pullrequest/10681')
  })
})

describe('pullRequestUrl across projects', () => {
  const base = {
    org: 'EuMedicoResidente',
    project: 'Plataforma EMR',
    workItemId: 19394,
    prId: 10398,
    repository: 'EGA',
  }

  it('builds the URL in the pull request own project, not the work item one', () => {
    expect(pullRequestUrl({ ...base, prProject: 'Eduardo' })).toBe(
      'https://dev.azure.com/EuMedicoResidente/Eduardo/_git/EGA/pullrequest/10398',
    )
  })

  it('falls back to the work item project when both share one', () => {
    expect(pullRequestUrl(base)).toBe(
      'https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_git/EGA/pullrequest/10398',
    )
  })

  it('keeps prProject through normalize and merge', () => {
    expect(normalizeAdoRef({ ...base, prProject: 'Eduardo' })).toMatchObject({
      prProject: 'Eduardo',
    })
    expect(
      mergeAdoRef({ org: 'o', project: 'p', workItemId: 1 }, { ...base, prProject: 'Eduardo' }),
    ).toMatchObject({ prProject: 'Eduardo' })
  })
})
