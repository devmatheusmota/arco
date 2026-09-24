import { basename } from './paths'
import { agentCliCommand, type AgentType } from './types'

const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat|ps1)$/i

/**
 * Whether the picked file looks like the agent's CLI rather than something else that carries the
 * vendor's name. Antigravity is the case this exists for: its CLI is `agy`, while `antigravity.exe`
 * is the desktop app — pointing an override at the app launches a window instead of a terminal.
 */
export function cliPathMatchesAgent(agent: AgentType, path: string): boolean {
  const expected = agentCliCommand(agent)
  if (!expected) return true
  const file = basename(path).toLowerCase().replace(EXECUTABLE_SUFFIX, '')
  return file === expected.toLowerCase()
}

let configuredCliPaths: () => Partial<Record<AgentType, string>> = () => ({})

/** The store registers where the configured paths live; this module does not import it. */
export function setCliPathSource(source: () => Partial<Record<AgentType, string>>): void {
  configuredCliPaths = source
}

/**
 * The configured executable for the CLI a restart launches, when it still names that CLI.
 *
 * A pane's first start applies the configured path itself. Every restart went to `PATH`
 * instead, so where the CLI is only reachable through that path the pane came back with
 * "command not found" — or with a different install than the one that was running.
 */
export function configuredLauncherFor(command: string | undefined): string | undefined {
  if (!command) return undefined
  for (const [agent, path] of Object.entries(configuredCliPaths()) as [AgentType, string][]) {
    if (!path) continue
    if (agent !== command && agentCliCommand(agent) !== command) continue
    if (cliPathMatchesAgent(agent, path)) return path
  }
  return undefined
}
