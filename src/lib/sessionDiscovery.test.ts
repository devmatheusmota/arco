import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimDiscoveredSession,
  claimMostRecentSession,
  isInteractiveSession,
  registerSessionClaim,
  resetSessionClaimsForTests,
} from './sessionDiscovery'

describe('claimDiscoveredSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('claims the only new session after the before snapshot', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'D:\\repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'new', modified_at_ms: 2 },
      ],
      'pty-1',
    )

    expect(claimed?.id).toBe('new')
  })

  it('a second concurrent claim for the same session gets nothing', () => {
    const before = new Set(['old'])
    const sessions = [
      { id: 'new', modified_at_ms: 200 },
      { id: 'old', modified_at_ms: 50 },
    ]

    expect(claimDiscoveredSession('codex', 'C:\\repo', before, sessions)?.id).toBe('new')
    expect(claimDiscoveredSession('codex', 'C:\\repo', before, sessions)).toBeUndefined()
  })

  it('known pane ids registered via registerSessionClaim are excluded from later discovery', () => {
    registerSessionClaim('codex', 'C:\\repo', 'assigned')
    const result = claimDiscoveredSession('codex', 'c:\\REPO', new Set(), [
      { id: 'assigned', modified_at_ms: 1 },
      { id: 'free', modified_at_ms: 2 },
    ])
    expect(result?.id).toBe('free')
  })

  it('ignores an automated run that appears while the pane waits for its own session', () => {
    const claimed = claimDiscoveredSession(
      'claude',
      '/repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'review', modified_at_ms: 2, interactive: false },
      ],
      'pty-1',
    )

    expect(claimed).toBeUndefined()
  })

  it('claims the typed session even when an automated run shows up alongside it', () => {
    const claimed = claimDiscoveredSession(
      'claude',
      '/repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'review', modified_at_ms: 2, interactive: false },
        { id: 'typed', modified_at_ms: 3, interactive: true },
      ],
      'pty-1',
    )

    expect(claimed?.id).toBe('typed')
  })

  it('does not claim when multiple new sessions make the pane mapping ambiguous', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'D:\\repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'new-a', modified_at_ms: 2 },
        { id: 'new-b', modified_at_ms: 3 },
      ],
      'pty-1',
    )

    expect(claimed).toBeUndefined()
  })
})

describe('isInteractiveSession', () => {
  it('rejects a transcript written by an automated run', () => {
    expect(isInteractiveSession({ id: 'review', modified_at_ms: 1, interactive: false })).toBe(
      false,
    )
  })

  it('accepts a session whose agent does not report the flag', () => {
    expect(isInteractiveSession({ id: 'codex', modified_at_ms: 1 })).toBe(true)
  })
})

describe('claimMostRecentSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('skips an automated run even when it is the newest transcript', () => {
    const claimed = claimMostRecentSession('claude', '/repo', [
      { id: 'security-review', modified_at_ms: 300, interactive: false },
      { id: 'minha-conversa', modified_at_ms: 200, interactive: true },
    ])

    expect(claimed?.id).toBe('minha-conversa')
  })
})
