import { isSessionClaimed, planResume, type SessionSnapshot } from './sessionDiscovery'
import {
  recordAppEvent,
  snapshotAntigravitySessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
} from './tauri'
import type { AgentType } from './types'

export type ListSessions = (
  agent: AgentType,
  cwd: string,
) => Promise<readonly SessionSnapshot[]> | null

function listSessions(agent: AgentType, cwd: string): Promise<readonly SessionSnapshot[]> | null {
  if (agent === 'claude') return snapshotClaudeSessions(cwd)
  if (agent === 'codex') return snapshotCodexSessions(cwd)
  if (agent === 'antigravity') return snapshotAntigravitySessions(cwd)
  return null
}

/**
 * The conversation a restart should resume, given the pointer the pane holds.
 *
 * A pointer can name a session `--resume` rejects — most often one the agent
 * created and never wrote a transcript for — and restarting on it exits with
 * "No conversation found" every time the button is pressed. The launch path
 * runs the same check before it spawns; the restart used to skip it. A listing
 * that cannot be read keeps the pointer: dropping it on an I/O error would lose
 * a conversation that is still there.
 */
export async function checkedResumePointer(
  agent: AgentType,
  cwd: string,
  pointer: string,
  owner: string,
  list: ListSessions = listSessions,
): Promise<string | undefined> {
  const listing = list(agent, cwd)
  if (!listing) return pointer
  let sessions: readonly SessionSnapshot[]
  try {
    sessions = await listing
  } catch {
    return pointer
  }
  const plan = planResume(
    pointer,
    sessions,
    (session) => !isSessionClaimed(agent, cwd, session.id, owner),
  )
  if (!plan) return pointer
  const replacement = plan.replacement?.id
  void recordAppEvent(
    'session.resume',
    `agent=${agent} wanted=${pointer} got=${replacement ?? 'fresh session'} reason=${plan.problem}${
      replacement ? '' : '-and-no-other'
    } via=restart`,
  )
  return replacement
}
