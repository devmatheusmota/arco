import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdoApiError, fetchPullRequestLocation, realignedRef } from './adoApi'
import type { TodoAdoRef } from './types'

const ref: TodoAdoRef = {
  org: 'EuMedicoResidente',
  project: 'Plataforma EMR',
  workItemId: 22312,
  prId: 10928,
  repository: 'EGA',
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

    await fetchPullRequestLocation(ref, 'token')

    const url = String(fetchMock.mock.calls[0][0])
    // Scoping to the work item's project answers 404 for every PR living elsewhere.
    expect(url).not.toContain('Plataforma')
    expect(url).toContain('/EuMedicoResidente/_apis/git/pullrequests/10928')
  })

  it('reports a refused token as a 401 the caller can recognise', async () => {
    stubResponse({}, false, 401)
    await expect(fetchPullRequestLocation(ref, 'bad')).rejects.toBeInstanceOf(AdoApiError)
  })

  it('answers nothing for a reference with no pull request, without calling out', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { prId: _prId, ...withoutPr } = ref
    expect(await fetchPullRequestLocation(withoutPr, 'token')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('realignedRef', () => {
  it('moves the pull request to the project that actually holds it', () => {
    expect(realignedRef(ref, { repositoryName: 'EGA', projectName: 'Eduardo' })).toMatchObject({
      project: 'Plataforma EMR',
      prProject: 'Eduardo',
      repository: 'EGA',
    })
  })

  it('replaces a repository stored as a GUID by an older build', () => {
    const guid: TodoAdoRef = { ...ref, repository: '50dfab59-b82c-49ac-be4b-e8d4b0ba6483' }
    expect(realignedRef(guid, { repositoryName: 'SOA', projectName: 'SOA' })).toMatchObject({
      repository: 'SOA',
      prProject: 'SOA',
    })
  })

  it('drops prProject when the pull request shares the work item project', () => {
    const same: TodoAdoRef = { ...ref, project: 'SOA', prProject: 'Eduardo', repository: 'SOA' }
    expect(
      realignedRef(same, { repositoryName: 'SOA', projectName: 'SOA' })?.prProject,
    ).toBeUndefined()
  })

  it('writes nothing when the stored reference is already right', () => {
    const right: TodoAdoRef = { ...ref, prProject: 'Eduardo' }
    expect(realignedRef(right, { repositoryName: 'EGA', projectName: 'Eduardo' })).toBeNull()
  })

  it('writes nothing when the pull request could not be located', () => {
    expect(realignedRef(ref, null)).toBeNull()
  })
})
