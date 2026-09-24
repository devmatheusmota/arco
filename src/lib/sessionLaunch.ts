import { type AgentType, UNRESTRICTED_FLAG } from './types'

/**
 * Whether every Claude session starts with its permission prompts skipped. The
 * store registers where that preference lives; this module does not import it,
 * so the launch rules stay testable without one.
 */
let claudeSkipPermissions: () => boolean = () => false

export function setClaudeSkipPermissionsSource(source: () => boolean): void {
  claudeSkipPermissions = source
}

/**
 * The settings file holding the SessionStart hook every Claude pane loads, which
 * tells the app when the agent moves to another conversation. Registered from
 * outside for the same reason as the preference above.
 */
let claudeSessionHooks: () => string | null = () => null

export function setClaudeSessionHooksSource(source: () => string | null): void {
  claudeSessionHooks = source
}

/**
 * The args an agent starts with once the launch preferences are applied. Every
 * way a pane starts an agent goes through here — a new pane, a task, `arco
 * session`, a restore when the app opens, a handoff, a restart — so a
 * preference that has to hold "however the pane was opened" holds.
 */
export function withLaunchPreferences(agent: AgentType, args: readonly string[]): string[] {
  const flag = UNRESTRICTED_FLAG[agent]
  if (agent !== 'claude' || !flag || args.includes(flag) || !claudeSkipPermissions()) {
    return [...args]
  }
  return [...args, flag]
}

export type AgentLaunch = {
  args: string[]
  sessionId?: string
  createdSession: boolean
}

function stripFlagWithValue(args: string[], flags: ReadonlySet<string>): string[] {
  const clean: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (flags.has(args[index])) {
      index++
      continue
    }
    clean.push(args[index])
  }
  return clean
}

function stripClaudeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume', '-r', '--session-id'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripCodexSessionArgs(args: string[]): string[] {
  if (args[0] !== 'resume') return [...args]
  const rest = args.slice(1)
  if (rest[0] === '--last' || (rest[0] && !rest[0].startsWith('-'))) rest.shift()
  return rest
}

function stripOpenCodeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--session', '-s'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c' && arg !== '--resume',
  )
}

function stripAntigravitySessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--conversation'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

export function buildAgentLaunch(
  agent: AgentType,
  baseArgs: readonly string[] = [],
  sessionId?: string,
  createUuid: () => string = () => crypto.randomUUID(),

  mcpConfigPaths?: readonly string[],
): AgentLaunch {
  if (agent === 'shell') {
    return { args: [...baseArgs], sessionId: undefined, createdSession: false }
  }

  if (agent === 'claude') {
    const clean = withLaunchPreferences('claude', stripClaudeSessionArgs([...baseArgs]))
    const mcp = (mcpConfigPaths ?? []).flatMap((path) => ['--mcp-config', path])
    const hooks = claudeSessionHooks()
    // A launch that brings its own settings — the agent canvas — keeps them.
    if (hooks && !clean.includes('--settings')) mcp.push('--settings', hooks)
    if (sessionId) {
      return {
        args: ['--resume', sessionId, ...mcp, ...clean],
        sessionId,
        createdSession: false,
      }
    }
    const createdId = createUuid()
    return {
      args: ['--session-id', createdId, ...mcp, ...clean],
      sessionId: createdId,
      createdSession: true,
    }
  }

  if (agent === 'codex') {
    const clean = stripCodexSessionArgs([...baseArgs])
    return {
      args: sessionId ? ['resume', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'opencode') {
    const clean = stripOpenCodeSessionArgs([...baseArgs])

    return {
      args: sessionId ? ['--session', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'antigravity') {
    const clean = stripAntigravitySessionArgs([...baseArgs])
    return {
      args: sessionId ? ['--conversation', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  return { args: [...baseArgs], sessionId: undefined, createdSession: false }
}
