import { beforeEach, describe, expect, it } from 'vitest'

import { checkedResumePointer } from './resumePointer'
import { registerSessionClaim, resetSessionClaimsForTests } from './sessionDiscovery'

const cwd = '/home/mota/projetos/emr/Legends'
const conversation = { id: '1105a343', modified_at_ms: 300, size_bytes: 2_600_000 }
const otherPane = { id: '330255ab', modified_at_ms: 400, size_bytes: 1_100_000 }

describe('checkedResumePointer', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
    registerSessionClaim('claude', cwd, otherPane.id, 'pane-other')
  })

  it('restarts on the real conversation when the pointer has no transcript', async () => {
    // A session with nothing but hook output has no `.jsonl`, so the listing
    // does not name it; the pane's conversation is still there beside it.
    const resumeId = await checkedResumePointer('claude', cwd, '20952054', 'pane-restarted', () =>
      Promise.resolve([otherPane, conversation]),
    )

    expect(resumeId).toBe('1105a343')
  })

  it('keeps a pointer that still names a conversation', async () => {
    const resumeId = await checkedResumePointer('claude', cwd, '1105a343', 'pane-restarted', () =>
      Promise.resolve([otherPane, conversation]),
    )

    expect(resumeId).toBe('1105a343')
  })

  it('starts fresh when nothing else in the directory is free to resume', async () => {
    const resumeId = await checkedResumePointer('claude', cwd, '20952054', 'pane-restarted', () =>
      Promise.resolve([otherPane]),
    )

    expect(resumeId).toBeUndefined()
  })

  it('keeps the pointer when the directory cannot be read', async () => {
    const resumeId = await checkedResumePointer('claude', cwd, '1105a343', 'pane-restarted', () =>
      Promise.reject(new Error('EACCES')),
    )

    expect(resumeId).toBe('1105a343')
  })

  it('leaves an agent the listing does not cover alone', async () => {
    const resumeId = await checkedResumePointer(
      'opencode',
      cwd,
      'ses_1',
      'pane-restarted',
      () => null,
    )

    expect(resumeId).toBe('ses_1')
  })
})
