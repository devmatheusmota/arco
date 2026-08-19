import { describe, expect, it } from 'vitest'

import { buildCliContextArgs, buildCliContextInitialInput, CLI_CONTEXT_PROMPT } from './cliContext'

describe('buildCliContextArgs', () => {
  it('appends the context to a Claude session', () => {
    expect(buildCliContextArgs('claude', true)).toEqual([
      '--append-system-prompt',
      CLI_CONTEXT_PROMPT,
    ])
  })

  it('adds nothing when the preference is off', () => {
    expect(buildCliContextArgs('claude', false)).toEqual([])
  })

  it('leaves agents without an additive flag untouched', () => {
    expect(buildCliContextArgs('codex', true)).toEqual([])
    expect(buildCliContextArgs('opencode', true)).toEqual([])
    expect(buildCliContextArgs('shell', true)).toEqual([])
  })

  it('documents the commands an agent needs to move a task', () => {
    expect(CLI_CONTEXT_PROMPT).toContain('arco todo status <ref>')
    expect(CLI_CONTEXT_PROMPT).toContain('arco todo list')
  })
})

describe('buildCliContextInitialInput', () => {
  it('hands Codex and OpenCode the context as a first message', () => {
    expect(buildCliContextInitialInput('codex', true)).toBe(CLI_CONTEXT_PROMPT)
    expect(buildCliContextInitialInput('opencode', true)).toBe(CLI_CONTEXT_PROMPT)
  })

  it('leaves Claude and shell untouched — they receive the context another way', () => {
    expect(buildCliContextInitialInput('claude', true)).toBeNull()
    expect(buildCliContextInitialInput('shell', true)).toBeNull()
  })

  it('respects the preference toggle', () => {
    expect(buildCliContextInitialInput('codex', false)).toBeNull()
  })
})
