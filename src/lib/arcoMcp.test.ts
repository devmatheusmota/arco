import { afterEach, describe, expect, it } from 'vitest'

import { preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { setArcoMcpEnabledSource, setArcoMcpSource, withArcoMcp } from './arcoMcp'
import { buildAgentLaunch } from './sessionLaunch'

const launch = {
  url: 'http://127.0.0.1:4321/mcp',
  token: 'segredo',
  claudeConfig: '/tmp/arco-agent-hooks.mcp.json',
}

afterEach(() => {
  setArcoMcpSource(() => null)
  setArcoMcpEnabledSource(() => true)
})

describe('the MCP server in an agent launch', () => {
  it('adds the config file to every Claude launch, resumed or new', () => {
    setArcoMcpSource(() => launch)
    const fresh = buildAgentLaunch('claude', [], undefined, () => 'novo')
    const resumed = buildAgentLaunch('claude', [], 'antigo')
    for (const { args } of [fresh, resumed]) {
      const at = args.indexOf(launch.claudeConfig)
      expect(at).toBeGreaterThan(0)
      expect(args[at - 1]).toBe('--mcp-config')
    }
  })

  it('does not add the file twice when the caller already passed it', () => {
    setArcoMcpSource(() => launch)
    const { args } = buildAgentLaunch('claude', [], undefined, () => 'x', [launch.claudeConfig])
    expect(args.filter((arg) => arg === launch.claudeConfig)).toHaveLength(1)
  })

  it('hands Codex the endpoint as overrides and keeps the token out of its arguments', () => {
    setArcoMcpSource(() => launch)
    const { args, env } = withArcoMcp('codex', ['--foo'], { ARCO_SESSION_ID: 'pane-1' })
    expect(args).toEqual([
      '--foo',
      '-c',
      'mcp_servers.arco.url=http://127.0.0.1:4321/mcp',
      '-c',
      'mcp_servers.arco.env_http_headers.X-Arco-Token=ARCO_MCP_TOKEN',
      '-c',
      'mcp_servers.arco.env_http_headers.X-Arco-Session=ARCO_SESSION_ID',
    ])
    expect(args.join(' ')).not.toContain('segredo')
    // A quote is what a Windows `.cmd` shim mangles.
    expect(args.join(' ')).not.toContain('"')
    expect(env).toEqual({ ARCO_SESSION_ID: 'pane-1', ARCO_MCP_TOKEN: 'segredo' })
  })

  it('hands OpenCode an inline config naming the pane it runs in', () => {
    setArcoMcpSource(() => launch)
    const { args, env } = withArcoMcp('opencode', [], { ARCO_SESSION_ID: 'pane-1' })
    expect(args).toEqual([])
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      mcp: {
        arco: {
          type: 'remote',
          url: launch.url,
          headers: { 'X-Arco-Token': 'segredo', 'X-Arco-Session': 'pane-1' },
          oauth: false,
          enabled: true,
        },
      },
    })
  })

  it('keeps what an inline OpenCode config already held', () => {
    setArcoMcpSource(() => launch)
    const earlier = JSON.stringify({ model: 'x', mcp: { outro: { type: 'local' } } })
    const { env } = withArcoMcp('opencode', [], { OPENCODE_CONFIG_CONTENT: earlier })
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(parsed.model).toBe('x')
    expect(Object.keys(parsed.mcp)).toEqual(['outro', 'arco'])
  })

  it('reaches Codex through the full profile too, which skips every other adjustment', () => {
    setArcoMcpSource(() => launch)
    const { args, env } = preparePtyRuntimeLaunch('codex', 'full', [], { ARCO_SESSION_ID: 'p' })
    expect(args).toContain('mcp_servers.arco.url=http://127.0.0.1:4321/mcp')
    expect(env?.ARCO_MCP_TOKEN).toBe('segredo')
  })

  it('leaves shells and every launch untouched when the preference is off', () => {
    setArcoMcpSource(() => launch)
    expect(withArcoMcp('shell', ['a'], {})).toEqual({ args: ['a'], env: {} })
    setArcoMcpEnabledSource(() => false)
    expect(withArcoMcp('codex', ['a'], {})).toEqual({ args: ['a'], env: {} })
    expect(buildAgentLaunch('claude', [], undefined, () => 'x').args).not.toContain(
      launch.claudeConfig,
    )
  })

  it('leaves every launch untouched before the app answered', () => {
    expect(withArcoMcp('opencode', [], {})).toEqual({ args: [], env: {} })
    expect(buildAgentLaunch('claude', [], undefined, () => 'x').args).not.toContain('--mcp-config')
  })
})
