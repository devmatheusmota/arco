import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { isInteractive } = require('../../electron/commands/sessions.cjs') as {
  isInteractive: (entries: unknown[]) => boolean
}

describe('isInteractive', () => {
  it('rejects the transcript of an automated run', () => {
    expect(isInteractive([{ type: 'user', entrypoint: 'sdk-py', promptSource: 'sdk' }])).toBe(false)
  })

  it('accepts a conversation someone typed', () => {
    expect(isInteractive([{ type: 'user', entrypoint: 'cli', promptSource: 'typed' }])).toBe(true)
  })

  it('reads the first user entry, skipping the bookkeeping records before it', () => {
    const entries = [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'mode', mode: 'normal' },
      { type: 'user', entrypoint: 'sdk-py' },
    ]
    expect(isInteractive(entries)).toBe(false)
  })

  it('falls back to promptSource when the entrypoint is missing', () => {
    expect(isInteractive([{ type: 'user', promptSource: 'sdk' }])).toBe(false)
  })

  it('takes a transcript with nothing to judge by at face value', () => {
    expect(isInteractive([])).toBe(true)
    expect(isInteractive([{ type: 'user' }])).toBe(true)
  })
})
