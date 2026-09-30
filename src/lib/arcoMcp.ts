import type { AgentType } from './types'

/**
 * Where the app's MCP server listens, as `arco_mcp_launch` reports it.
 *
 * The server lives in the hook listener the app already runs, so the endpoint
 * and token change on every start and are asked for once per run.
 */
export type ArcoMcpLaunch = {
  url: string
  token: string
  /** The `--mcp-config` file Claude loads, carrying the token. */
  claudeConfig: string | null
}

let launchInfo: () => ArcoMcpLaunch | null = () => null
let enabled: () => boolean = () => true

/** Registered by the module that asks the app; kept out of here so the rules stay testable. */
export function setArcoMcpSource(source: () => ArcoMcpLaunch | null): void {
  launchInfo = source
}

/** The preference that leaves agents exactly as they start elsewhere turns this off too. */
export function setArcoMcpEnabledSource(source: () => boolean): void {
  enabled = source
}

function currentLaunch(): ArcoMcpLaunch | null {
  return enabled() ? launchInfo() : null
}

/** Whether an agent started now gets the server, and so has `session_send` to answer with. */
export function agentLoadsArcoMcp(agent: AgentType | undefined): boolean {
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') return false
  return currentLaunch() !== null
}

/** The config file a Claude launch adds to its `--mcp-config` list, when there is one. */
export function arcoMcpClaudeConfig(): string | null {
  return currentLaunch()?.claudeConfig ?? null
}

function parseInlineConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Wires the server into a Codex or OpenCode launch.
 *
 * Neither reads a config file the app could hand over per launch, so Codex takes
 * `-c` overrides and OpenCode an inline config in its environment. The token
 * travels in the environment in both: a process's arguments are readable by any
 * user on the machine, its environment only by its owner.
 *
 * The Codex values go unquoted on purpose. It reads each one as TOML and falls
 * back to the raw string, and a quote is what a Windows `.cmd` shim mangles.
 */
export function withArcoMcp(
  agent: AgentType,
  args: readonly string[],
  env: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  const launch = agent === 'codex' || agent === 'opencode' ? currentLaunch() : null
  if (!launch) return { args: [...args], env: { ...env } }

  if (agent === 'codex') {
    const server = 'mcp_servers.arco'
    return {
      args: [
        ...args,
        '-c',
        `${server}.url=${launch.url}`,
        '-c',
        `${server}.env_http_headers.X-Arco-Token=ARCO_MCP_TOKEN`,
        '-c',
        `${server}.env_http_headers.X-Arco-Session=ARCO_SESSION_ID`,
      ],
      env: { ...env, ARCO_MCP_TOKEN: launch.token },
    }
  }

  // OpenCode merges this over the user's own config, so only the one server
  // goes in — plus whatever an earlier layer of this launch already put there.
  const inline = parseInlineConfig(env.OPENCODE_CONFIG_CONTENT)
  const headers: Record<string, string> = { 'X-Arco-Token': launch.token }
  if (env.ARCO_SESSION_ID) headers['X-Arco-Session'] = env.ARCO_SESSION_ID
  const mcp = { ...((inline.mcp as Record<string, unknown>) ?? {}) }
  mcp.arco = { type: 'remote', url: launch.url, headers, oauth: false, enabled: true }
  return {
    args: [...args],
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inline, mcp }) },
  }
}
