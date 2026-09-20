import { describe, expect, it } from 'vitest'

import {
  collectPaneShortIds,
  generatePaneShortId,
  isPaneShortId,
  normalizePaneRef,
} from './paneShortId'
import type { Project, Terminal } from './types'

const pane = (id: string, shortId?: string): Terminal =>
  ({ id, name: id, cwd: '/repo', tabs: [], activeTabId: '', disabled: false, shortId }) as Terminal

const project = (id: string, terminals: Terminal[]): Project =>
  ({ id, name: id, terminals }) as Project

describe('isPaneShortId', () => {
  it('accepts the canonical form and nothing else', () => {
    expect(isPaneShortId('pa-3576')).toBe(true)
    expect(isPaneShortId('pa-35761')).toBe(true)
    expect(isPaneShortId('PA-3576')).toBe(false)
    expect(isPaneShortId('pa-357')).toBe(false)
    expect(isPaneShortId('pa-35a6')).toBe(false)
    expect(isPaneShortId('3576')).toBe(false)
    expect(isPaneShortId(undefined)).toBe(false)
    expect(isPaneShortId(3576)).toBe(false)
  })
})

describe('generatePaneShortId', () => {
  it('draws four digits behind the prefix', () => {
    const id = generatePaneShortId(new Set())
    expect(id).toMatch(/^pa-\d{4}$/)
    expect(isPaneShortId(id)).toBe(true)
  })

  it('never returns a reference already taken', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const id = generatePaneShortId(taken)
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
    expect(taken.size).toBe(200)
  })

  it('widens instead of spinning when the four-digit space is full', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 10_000; i += 1) {
      taken.add(`pa-${String(i).padStart(4, '0')}`)
    }
    const id = generatePaneShortId(taken)
    expect(id).toMatch(/^pa-\d{5,}$/)
    expect(taken.has(id)).toBe(false)
  })
})

describe('collectPaneShortIds', () => {
  it('gathers well-formed references across every project and ignores the rest', () => {
    const taken = collectPaneShortIds([
      project('p1', [pane('a', 'pa-1111'), pane('b'), pane('c', 'nonsense')]),
      project('p2', [pane('d', 'pa-2222')]),
    ])

    expect([...taken].sort()).toEqual(['pa-1111', 'pa-2222'])
  })

  it('survives a file with no projects and a project with no terminals', () => {
    expect(collectPaneShortIds(undefined).size).toBe(0)
    expect(collectPaneShortIds([{ id: 'p1' } as Project]).size).toBe(0)
  })
})

describe('normalizePaneRef', () => {
  it('canonicalizes what a person types or dictates', () => {
    expect(normalizePaneRef('pa-3576')).toBe('pa-3576')
    expect(normalizePaneRef('PA-3576')).toBe('pa-3576')
    expect(normalizePaneRef('  pa-3576  ')).toBe('pa-3576')
    expect(normalizePaneRef('pa- 3576')).toBe('pa-3576')
    expect(normalizePaneRef('3576')).toBe('pa-3576')
    expect(normalizePaneRef('35761')).toBe('pa-35761')
  })

  it('rejects anything that is not a reference', () => {
    expect(normalizePaneRef('357')).toBeNull()
    expect(normalizePaneRef('pa-')).toBeNull()
    expect(normalizePaneRef('pa-35a6')).toBeNull()
    expect(normalizePaneRef('current')).toBeNull()
    expect(normalizePaneRef('')).toBeNull()
    expect(normalizePaneRef(null)).toBeNull()
    expect(normalizePaneRef(undefined)).toBeNull()
  })

  it('does not mistake a nanoid for a reference', () => {
    expect(normalizePaneRef('V1StGXR8_Z5jdHi6B-myT')).toBeNull()
  })
})
