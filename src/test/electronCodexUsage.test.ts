import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { codexLimits } = require('../../electron/commands/usage.cjs') as {
  codexLimits: (result: unknown) => {
    primary: { used_percent: number; window_minutes: number; resets_at_ms: number }
    secondary: { used_percent: number; window_minutes: number; resets_at_ms: number }
    plan: string
    rate_limited: boolean
    reset_credits: number
  }
}

describe('codexLimits', () => {
  it('reads the shape `account/rateLimits/read` answers with', () => {
    const limits = codexLimits({
      rateLimits: {
        primary: { usedPercent: 19, windowDurationMins: 300, resetsAt: 1788193898 },
        secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1788780698 },
        planType: 'team',
        rateLimitReachedType: null,
        spendControlReached: false,
      },
      rateLimitResetCredits: { availableCount: 1 },
    })

    expect(limits).toEqual({
      primary: { used_percent: 19, window_minutes: 300, resets_at_ms: 1788193898000 },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at_ms: 1788780698000 },
      plan: 'team',
      rate_limited: false,
      reset_credits: 1,
    })
  })

  it('reports a quota that has been reached', () => {
    const limits = codexLimits({
      rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: 'primary' },
    })

    expect(limits.rate_limited).toBe(true)
  })

  it('still reads the flat shape older Codex builds answered with', () => {
    const limits = codexLimits({
      primary: { used_percent: 42, window_minutes: 300, resets_at_ms: 123 },
      plan: 'pro',
      rate_limited: true,
      reset_credits: 2,
    })

    expect(limits).toEqual({
      primary: { used_percent: 42, window_minutes: 300, resets_at_ms: 123 },
      secondary: { used_percent: 0, window_minutes: 0, resets_at_ms: 0 },
      plan: 'pro',
      rate_limited: true,
      reset_credits: 2,
    })
  })

  it('answers zeros instead of failing on an empty result', () => {
    expect(codexLimits(undefined).primary.used_percent).toBe(0)
  })
})
