import { describe, expect, it } from 'vitest'

import {
  adoPullRequests,
  mergeAdoRef,
  normalizeAdoRef,
  parseAdoRef,
  pullRequestUrl,
  workItemUrl,
} from './adoRef'

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
      workItemId: 0,
      prs: [{ id: 10681, repository: 'SOA', project: 'Plataforma EMR' }],
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
      prs: [{ id: 10681 }],
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
    ).toMatchObject({ prs: [{ id: 10681, repository: 'SOA' }] })
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
    expect(
      normalizeAdoRef({ org: 'x', project: 'y', workItemId: 0, prs: [{ id: 42 }] }),
    ).toMatchObject({
      org: 'x',
      project: 'y',
      prs: [{ id: 42 }],
    })
  })

  it('reads a file written before a task could carry more than one PR', () => {
    expect(
      normalizeAdoRef({
        org: 'EuMedicoResidente',
        project: 'Plataforma EMR',
        workItemId: 22312,
        prId: 10928,
        repository: 'EGA',
        prProject: 'Eduardo',
      }),
    ).toEqual({
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      workItemId: 22312,
      prs: [{ id: 10928, repository: 'EGA', project: 'Eduardo' }],
    })
  })

  it('drops repeated and malformed pull requests', () => {
    expect(
      normalizeAdoRef({
        org: 'o',
        project: 'p',
        workItemId: 1,
        prs: [{ id: 42 }, { id: 42, repository: 'SOA' }, { id: 0 }, null, 'nope'],
      })?.prs,
    ).toEqual([{ id: 42 }])
  })
})

describe('mergeAdoRef', () => {
  it('adds a PR to an existing work-item reference', () => {
    const base = { org: 'o', project: 'p', workItemId: 22447 }
    expect(
      mergeAdoRef(base, {
        org: 'o',
        project: 'p',
        workItemId: 0,
        prs: [{ id: 10681, repository: 'SOA' }],
      }),
    ).toMatchObject({
      workItemId: 22447,
      prs: [{ id: 10681, repository: 'SOA' }],
    })
  })

  it('keeps every pull request linked to the same task', () => {
    const withFirst = mergeAdoRef(
      { org: 'o', project: 'p', workItemId: 22447 },
      { org: 'o', project: 'p', workItemId: 0, prs: [{ id: 10681, repository: 'SOA' }] },
    )
    const withSecond = mergeAdoRef(withFirst, {
      org: 'o',
      project: 'p',
      workItemId: 0,
      prs: [{ id: 10700, repository: 'EGA' }],
    })
    expect(withSecond.prs).toEqual([
      { id: 10681, repository: 'SOA' },
      { id: 10700, repository: 'EGA' },
    ])
  })

  it('refines a pull request already linked instead of listing it twice', () => {
    const merged = mergeAdoRef(
      { org: 'o', project: 'p', workItemId: 1, prs: [{ id: 10681 }] },
      { org: 'o', project: 'p', workItemId: 0, prs: [{ id: 10681, repository: 'SOA' }] },
    )
    expect(merged.prs).toEqual([{ id: 10681, repository: 'SOA' }])
  })
})

describe('urls', () => {
  it('encodes the project name so a space survives the round trip', () => {
    expect(
      workItemUrl({ org: 'EuMedicoResidente', project: 'Plataforma EMR', workItemId: 22447 }),
    ).toBe('https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_workitems/edit/22447')
  })

  it('returns null for a PR url when the repository is unknown', () => {
    const ref = { org: 'o', project: 'p', workItemId: 0, prs: [{ id: 10681 }] }
    expect(pullRequestUrl(ref, { id: 10681 })).toBeNull()
    expect(pullRequestUrl(ref, { id: 10681, repository: 'SOA' })).toContain(
      '/_git/SOA/pullrequest/10681',
    )
  })
})

describe('pullRequestUrl across projects', () => {
  const base = {
    org: 'EuMedicoResidente',
    project: 'Plataforma EMR',
    workItemId: 19394,
    prs: [{ id: 10398, repository: 'EGA' }],
  }

  it('builds the URL in the pull request own project, not the work item one', () => {
    expect(pullRequestUrl(base, { id: 10398, repository: 'EGA', project: 'Eduardo' })).toBe(
      'https://dev.azure.com/EuMedicoResidente/Eduardo/_git/EGA/pullrequest/10398',
    )
  })

  it('falls back to the work item project when both share one', () => {
    expect(pullRequestUrl(base, base.prs[0])).toBe(
      'https://dev.azure.com/EuMedicoResidente/Plataforma%20EMR/_git/EGA/pullrequest/10398',
    )
  })

  it('records the pull request project when a PR URL joins a work item in another one', () => {
    const workItem = mergeAdoRef(undefined, {
      org: 'EuMedicoResidente',
      project: 'Plataforma EMR',
      workItemId: 22734,
    })
    const merged = mergeAdoRef(workItem, {
      org: 'EuMedicoResidente',
      project: 'agentic-product-os',
      workItemId: 0,
      prs: [{ id: 10949, repository: 'emr-agent-skills', project: 'agentic-product-os' }],
    })
    expect(merged).toMatchObject({
      project: 'Plataforma EMR',
      workItemId: 22734,
      prs: [{ id: 10949, project: 'agentic-product-os' }],
    })
    expect(workItemUrl(merged)).toContain('/Plataforma%20EMR/_workitems/edit/22734')
    expect(pullRequestUrl(merged, adoPullRequests(merged)[0])).toBe(
      'https://dev.azure.com/EuMedicoResidente/agentic-product-os/_git/emr-agent-skills/pullrequest/10949',
    )
  })

  it('leaves the pull request project off when the two sides share a project', () => {
    const merged = mergeAdoRef(
      { org: 'EuMedicoResidente', project: 'SOA', workItemId: 22672 },
      {
        org: 'EuMedicoResidente',
        project: 'SOA',
        workItemId: 0,
        prs: [{ id: 10899, repository: 'SOA', project: 'SOA' }],
      },
    )
    expect(merged.prs?.[0].project).toBeUndefined()
    expect(merged.project).toBe('SOA')
  })

  it('keeps the pull request project through normalize and merge', () => {
    const across = {
      ...base,
      prs: [{ id: 10398, repository: 'EGA', project: 'Eduardo' }],
    }
    expect(normalizeAdoRef(across)?.prs).toEqual([
      { id: 10398, repository: 'EGA', project: 'Eduardo' },
    ])
    expect(mergeAdoRef({ org: 'o', project: 'p', workItemId: 1 }, across).prs).toEqual([
      { id: 10398, repository: 'EGA', project: 'Eduardo' },
    ])
  })
})
