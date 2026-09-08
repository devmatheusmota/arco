import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdoApiError, fetchPullRequestLocation, realignedRef } from './adoApi'
import type { TodoAdoRef } from './types'

const pr = { id: 10928, repository: 'EGA' }

const ref: TodoAdoRef = {
  org: 'EuMedicoResidente',
  project: 'Plataforma EMR',
  workItemId: 22312,
  prs: [pr],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubResponse(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => body })),
  )
}

describe('fetchPullRequestLocation', () => {
  it('asks at the organization level, where a pull request id is unique', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ repository: { name: 'EGA', project: { name: 'Eduardo' } } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPullRequestLocation(ref, pr, 'token')

    const url = String(fetchMock.mock.calls[0][0])
    // Scoping to the work item's project answers 404 for every PR living elsewhere.
    expect(url).not.toContain('Plataforma')
    expect(url).toContain('/EuMedicoResidente/_apis/git/pullrequests/10928')
  })

  it('reports a refused token as a 401 the caller can recognise', async () => {
    stubResponse({}, false, 401)
    await expect(fetchPullRequestLocation(ref, pr, 'bad')).rejects.toBeInstanceOf(AdoApiError)
  })

  it('answers nothing for an entry with no pull request id, without calling out', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchPullRequestLocation(ref, { id: 0 }, 'token')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('realignedRef', () => {
  it('moves the pull request to the project that actually holds it', () => {
    expect(realignedRef(ref, pr, { repositoryName: 'EGA', projectName: 'Eduardo' })).toMatchObject({
      project: 'Plataforma EMR',
      prs: [{ id: 10928, repository: 'EGA', project: 'Eduardo' }],
    })
  })

  it('replaces a repository stored as a GUID by an older build', () => {
    const stale = { id: 10928, repository: '50dfab59-b82c-49ac-be4b-e8d4b0ba6483' }
    const guid: TodoAdoRef = { ...ref, prs: [stale] }
    expect(realignedRef(guid, stale, { repositoryName: 'SOA', projectName: 'SOA' })).toMatchObject({
      prs: [{ id: 10928, repository: 'SOA', project: 'SOA' }],
    })
  })

  it('drops the pull request project when it shares the work item project', () => {
    const across = { id: 10928, repository: 'SOA', project: 'Eduardo' }
    const same: TodoAdoRef = { ...ref, project: 'SOA', prs: [across] }
    expect(
      realignedRef(same, across, { repositoryName: 'SOA', projectName: 'SOA' })?.prs?.[0].project,
    ).toBeUndefined()
  })

  it('leaves the other pull requests of the task untouched', () => {
    const other = { id: 11000, repository: 'SOA' }
    const many: TodoAdoRef = { ...ref, prs: [pr, other] }
    expect(realignedRef(many, pr, { repositoryName: 'EGA', projectName: 'Eduardo' })?.prs).toEqual([
      { id: 10928, repository: 'EGA', project: 'Eduardo' },
      other,
    ])
  })

  it('writes nothing when the stored reference is already right', () => {
    const right = { id: 10928, repository: 'EGA', project: 'Eduardo' }
    expect(
      realignedRef({ ...ref, prs: [right] }, right, {
        repositoryName: 'EGA',
        projectName: 'Eduardo',
      }),
    ).toBeNull()
  })

  it('writes nothing when the pull request could not be located', () => {
    expect(realignedRef(ref, pr, null)).toBeNull()
  })
})
