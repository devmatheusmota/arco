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

  it('points the agent at the tools that move a task', () => {
    expect(CLI_CONTEXT_PROMPT).toContain('todo_status')
    expect(CLI_CONTEXT_PROMPT).toContain('todo_list')
  })

  // Listing only the board left an agent asked to open a pane, or to reach
  // another one, running `arco help` first to find out how — every session.
  it('covers reaching the other sessions, not only the board', () => {
    expect(CLI_CONTEXT_PROMPT).toContain('session_send')
    expect(CLI_CONTEXT_PROMPT).toContain('session_list')
    expect(CLI_CONTEXT_PROMPT).toContain('group_list')
  })

  // A footnote about the MCP server after a page of shell commands left agents
  // on the shell with the tools loaded.
  it('leads with the MCP tools, not the shell command', () => {
    expect(CLI_CONTEXT_PROMPT.indexOf('todo_status')).toBeLessThan(
      CLI_CONTEXT_PROMPT.indexOf('arco todo'),
    )
  })

  // Without it an agent cannot name itself when it writes to another pane.
  it('says where the session finds its own reference', () => {
    expect(CLI_CONTEXT_PROMPT).toContain('$ARCO_PANE_ID')
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
