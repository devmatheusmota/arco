import { describe, expect, it } from 'vitest'

import { createHiddenBacklog, dropReplayOverlap } from './terminalBacklog'

describe('createHiddenBacklog', () => {
  it('returns what the pane missed, in order, and empties itself', () => {
    const backlog = createHiddenBacklog()
    backlog.push('one')
    backlog.push('two')
    expect(backlog.drain()).toBe('onetwo')
    expect(backlog.drain()).toBe('')
    expect(backlog.overflowed).toBe(false)
  })

  it('gives up past the cap, since the host no longer holds the rest either', () => {
    const backlog = createHiddenBacklog(8)
    backlog.push('12345')
    backlog.push('67890')
    expect(backlog.overflowed).toBe(true)
    expect(backlog.drain()).toBe('')
  })

  it('stays given up until reset', () => {
    const backlog = createHiddenBacklog(4)
    backlog.push('12345')
    backlog.push('later')
    expect(backlog.drain()).toBe('')
    backlog.reset()
    expect(backlog.overflowed).toBe(false)
    backlog.push('ok')
    expect(backlog.drain()).toBe('ok')
  })
})

describe('dropReplayOverlap', () => {
  it('drops the chunk the replay already carries', () => {
    expect(dropReplayOverlap('abcdef', 'def')).toBe('')
  })

  it('keeps only what the replay is missing', () => {
    expect(dropReplayOverlap('abcdef', 'defghi')).toBe('ghi')
  })

  it('writes the whole chunk when nothing overlaps', () => {
    expect(dropReplayOverlap('abcdef', 'xyz')).toBe('xyz')
  })

  it('prefers the longest seam when the head repeats', () => {
    expect(dropReplayOverlap('xaaa', 'aaab')).toBe('b')
  })

  it('passes empty input through', () => {
    expect(dropReplayOverlap('', 'abc')).toBe('abc')
    expect(dropReplayOverlap('abc', '')).toBe('')
  })
})
