import type { AgentType } from './types'

/**
 * What a session started here is told about the `arco` command.
 *
 * An agent has no way to discover the command: it is a shim on PATH that talks
 * to the running app over a local socket, and nothing in the repository hints at
 * it. Without this the task board stays a human-only surface — the agent works
 * on a task it can read but cannot move. Kept short on purpose: it costs context
 * on every session.
 */
export const CLI_CONTEXT_PROMPT = [
  'This session runs inside Arco, and the `arco` command talks to the app that started it.',
  'Use it to keep the task board honest — move a task to in-progress when you pick it up,',
  'and to review when you hand the work back.',
  '',
  '  arco todo list                      tasks with their short id, status and tags',
  '  arco todo "<title>" [--tag <tag>] [--status <status>]',
  '  arco todo status <ref> <status>     todo | in-progress | review | done',
  '  arco todo edit <ref> [--title <text>] [--add-tag <tag>] [--remove-tag <tag>]',
  '                      [--priority high|normal|low] [--notes <text>]',
  '',
  '<ref> is the short id from `arco todo list` or a unique piece of the title.',
  'Run `arco help` for the full surface. Do not edit the task board any other way.',
].join('\n')

/**
 * Arguments that carry the context, for agents whose CLI can take extra system
 * instructions without replacing their own. Codex and OpenCode have no additive
 * flag today, so their sessions are left untouched rather than overwritten.
 */
export function buildCliContextArgs(agent: AgentType, enabled: boolean): string[] {
  if (!enabled || agent !== 'claude') return []
  return ['--append-system-prompt', CLI_CONTEXT_PROMPT]
}

/**
 * Best-effort fallback for the two agents that reject an additive system flag.
 *
 * Codex and OpenCode need the context delivered as chat text — worse than a
 * real system prompt (an agent can forget it a few turns in), but honest:
 * without this the task board they can move is invisible to them. Only used
 * when a session already starts with a first message (the taskSession flow),
 * so a plain terminal open of Codex stays exactly as the CLI would launch it.
 */
export function buildCliContextInitialInput(agent: AgentType, enabled: boolean): string | null {
  if (!enabled) return null
  if (agent !== 'codex' && agent !== 'opencode') return null
  return CLI_CONTEXT_PROMPT
}
