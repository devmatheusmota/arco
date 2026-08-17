import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatResetDiff, formatResetIso, formatResetMs } from './usageFormat'

describe('usageFormat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns em dash instead of NaN for missing or unparseable timestamps', () => {
    expect(formatResetIso('')).toBe('—')
    expect(formatResetIso(null)).toBe('—')
    expect(formatResetIso(undefined)).toBe('—')
    expect(formatResetIso('not-a-date')).toBe('—')
    expect(formatResetMs(0)).toBe('—')
    expect(formatResetMs(Number.NaN)).toBe('—')
    expect(formatResetDiff(Number.NaN)).toBe('—')
    expect(formatResetDiff(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('formats future durations', () => {
    expect(formatResetIso('2026-01-01T14:30:00.000Z')).toBe('2h 30m')
    expect(formatResetIso('2026-01-01T12:45:00.000Z')).toBe('45m')
    expect(formatResetIso('2026-01-03T13:00:00.000Z')).toBe('2d 1h')
    expect(formatResetMs(new Date('2026-01-01T12:45:00.000Z').getTime())).toBe('45m')
  })

  it('reports elapsed windows as resetting', () => {
    expect(formatResetIso('2026-01-01T11:00:00.000Z')).toBe('resetting…')
    expect(formatResetDiff(0)).toBe('resetting…')
  })
})
