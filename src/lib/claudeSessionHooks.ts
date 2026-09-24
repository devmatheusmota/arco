import { setClaudeSessionHooksSource } from './sessionLaunch'
import { agentSessionHooksPath } from './tauri'

let path: string | null = null
let pending: Promise<string | null> | null = null

/**
 * Asks the app once for the settings file with the pane SessionStart hook.
 *
 * Launches read the answer synchronously through `buildAgentLaunch`; the first
 * one of a run waits for it here, and every later one — restarts included —
 * finds it already known.
 */
export function ensureClaudeSessionHooks(): Promise<string | null> {
  pending ??= agentSessionHooksPath()
    .then((resolved) => (path = resolved))
    .catch(() => null)
  return pending
}

setClaudeSessionHooksSource(() => path)
