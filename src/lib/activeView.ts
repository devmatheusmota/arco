import type { ActiveView } from '../stores/uiStore'
import { AGENT_SANDBOX_ENABLED } from './featureFlags'

/**
 * Whether the workspace is the view on screen.
 *
 * The app falls back to the workspace for anything it cannot render — the agent
 * sandbox behind its flag, above all. Panes decide whether to stream from this
 * same answer, and asking the enum directly is what once left every terminal of
 * a workspace blank while the workspace itself was the thing being shown.
 */
export function rendersWorkspace(view: ActiveView): boolean {
  if (view === 'home' || view === 'agentCanvas') return false
  if (view === 'agentSandbox') return !AGENT_SANDBOX_ENABLED
  return true
}
