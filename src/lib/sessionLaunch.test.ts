import { afterEach, describe, expect, it } from 'vitest'

import {
  buildAgentLaunch,
  setClaudeSessionHooksSource,
  setClaudeSkipPermissionsSource,
} from './sessionLaunch'

describe('buildAgentLaunch', () => {
  it('new Claude panes receive distinct deterministic session ids', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[0],
    )
    const second = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[1],
    )

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.args).toEqual(['--session-id', ids[0], '--dangerously-skip-permissions'])
    expect(second.args).toEqual(['--session-id', ids[1], '--dangerously-skip-permissions'])
  })

  it('Claude resumes only the session assigned to its pane', () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--continue', '--resume', 'stale', '--session-id', 'stale-too', '--model', 'sonnet'],
      'pane-session',
    )

    expect(launch.args).toEqual(['--resume', 'pane-session', '--model', 'sonnet'])
    expect(launch.createdSession).toBe(false)
  })

  it('Codex without a known id starts a new chat instead of resuming last', () => {
    const launch = buildAgentLaunch('codex', ['resume', '--last', '--search'])
    expect(launch.args).toEqual(['--search'])
  })

  it('Codex and OpenCode use their pane-specific resume syntax', () => {
    expect(buildAgentLaunch('codex', ['resume', 'old', '--search'], 'codex-pane').args).toEqual([
      'resume',
      'codex-pane',
      '--search',
    ])
    expect(
      buildAgentLaunch('opencode', ['--continue', '--session', 'old', '--model', 'x'], 'open-pane')
        .args,
    ).toEqual(['--session', 'open-pane', '--model', 'x'])
  })

  it('Antigravity keeps agy flags and uses its pane-specific conversation', () => {
    expect(
      buildAgentLaunch(
        'antigravity',
        ['--continue', '--conversation', 'old', '--dangerously-skip-permissions'],
        'agy-pane',
      ).args,
    ).toEqual(['--conversation', 'agy-pane', '--dangerously-skip-permissions'])
  })
})

describe('Claude skip-permissions preference', () => {
  afterEach(() => setClaudeSkipPermissionsSource(() => false))

  it('adds the flag to a new and a resumed Claude session when on', () => {
    setClaudeSkipPermissionsSource(() => true)
    expect(buildAgentLaunch('claude', [], undefined, () => 'new-id').args).toEqual([
      '--session-id',
      'new-id',
      '--dangerously-skip-permissions',
    ])
    expect(buildAgentLaunch('claude', ['--model', 'sonnet'], 'pane-session').args).toEqual([
      '--resume',
      'pane-session',
      '--model',
      'sonnet',
      '--dangerously-skip-permissions',
    ])
  })

  it('does not repeat a flag the pane already asked for', () => {
    setClaudeSkipPermissionsSource(() => true)
    const args = buildAgentLaunch('claude', ['--dangerously-skip-permissions'], 'pane-session').args
    expect(args.filter((arg) => arg === '--dangerously-skip-permissions')).toHaveLength(1)
  })

  it('leaves Claude alone when off, and other agents alone when on', () => {
    expect(buildAgentLaunch('claude', [], 'pane-session').args).toEqual([
      '--resume',
      'pane-session',
    ])
    setClaudeSkipPermissionsSource(() => true)
    expect(buildAgentLaunch('codex', [], 'thread').args).toEqual(['resume', 'thread'])
    expect(buildAgentLaunch('opencode', [], 'ses').args).toEqual(['--session', 'ses'])
  })
})

describe('SessionStart hook on Claude launches', () => {
  afterEach(() => setClaudeSessionHooksSource(() => null))

  it('loads the pane settings on a new and a resumed session', () => {
    setClaudeSessionHooksSource(() => '/tmp/arco-session-hooks.json')
    expect(buildAgentLaunch('claude', [], undefined, () => 'new-id').args).toEqual([
      '--session-id',
      'new-id',
      '--settings',
      '/tmp/arco-session-hooks.json',
    ])
    expect(buildAgentLaunch('claude', [], 'pane-session').args).toEqual([
      '--resume',
      'pane-session',
      '--settings',
      '/tmp/arco-session-hooks.json',
    ])
  })

  it('keeps settings a launch brings on its own, and leaves other agents alone', () => {
    setClaudeSessionHooksSource(() => '/tmp/arco-session-hooks.json')
    const canvas = buildAgentLaunch('claude', ['--settings', '/tmp/canvas.json'], 'pane-session')
    expect(canvas.args.filter((arg) => arg === '--settings')).toHaveLength(1)
    expect(canvas.args).toContain('/tmp/canvas.json')
    expect(buildAgentLaunch('codex', [], 'thread').args).toEqual(['resume', 'thread'])
  })
})
