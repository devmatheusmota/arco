import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { paneAgentRequestById } from './agentProcessLaunch'
import { restartPaneAgent } from './ptyRestart'
import { getActiveSessions, saveSession } from './sessionResume'
import { acquireSpawnSlot, releaseSpawnSlot } from './spawnQueue'
import {
  getPtyCwd,
  snapshotAntigravitySessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
} from './tauri'
import type { AgentType } from './types'

const RESUMABLE: AgentType[] = ['claude', 'codex', 'opencode', 'antigravity']

export type ResetLastSessionResult = { resumed: number; total: number }

type SessionExclude = {
  id?: string

  before?: number
}

function pickSessionId(
  sessions: ReadonlyArray<{ id: string; modified_at_ms: number }>,
  exclude: SessionExclude,
): string | null {
  const candidates = sessions.filter((s) => s.id !== exclude.id)
  if (candidates.length === 0) return null
  const older = exclude.before ? candidates.filter((s) => s.modified_at_ms < exclude.before!) : []
  const pool = older.length > 0 ? older : candidates
  return pool.reduce((a, b) => (b.modified_at_ms > a.modified_at_ms ? b : a)).id
}

/** Acha o ID da conversa a retomar no disco para o cwd, por agente. */
async function latestSessionId(
  agent: AgentType,
  cwd: string,
  exclude: SessionExclude,
  savedOpenCodeId?: string,
): Promise<string | null> {
  if (!cwd) return null
  try {
    if (agent === 'codex') return pickSessionId(await snapshotCodexSessions(cwd), exclude)
    if (agent === 'claude') return pickSessionId(await snapshotClaudeSessions(cwd), exclude)
    if (agent === 'opencode') {
      if (savedOpenCodeId) return savedOpenCodeId
      const sessions = await snapshotOpenCodeSessions(cwd)
      if (sessions.length > 0) {
        return pickSessionId(sessions, exclude) ?? sessions[0].id
      }
      return null
    }
    if (agent === 'antigravity')
      return pickSessionId(await snapshotAntigravitySessions(cwd), exclude)
  } catch {
    return null
  }
  return null
}

type ResumeTarget = {
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  agent: AgentType
  cwd: string
  extraArgs: string[]
}

function collectLivePanes(): ResumeTarget[] {
  const { projects } = useProjectsStore.getState()
  const { byPtyId } = useTerminalsStore.getState()
  const targets: ResumeTarget[] = []
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (!RESUMABLE.includes(tab.type)) continue
        const ptyId = tab.ptyId
        if (!ptyId || !byPtyId[ptyId]?.alive) continue
        targets.push({
          projectId: project.id,
          terminalId: terminal.id,
          tabId: tab.id,
          ptyId,
          agent: tab.type,
          cwd: (tab.cwd || terminal.cwd || '').trim(),
          extraArgs: tab.extraArgs ?? [],
        })
      }
    }
  }
  return targets
}

export function countLiveResumablePanes(): number {
  return collectLivePanes().length
}

export async function resetLastSession(): Promise<ResetLastSessionResult> {
  const targets = collectLivePanes()
  let resumed = 0

  for (const target of targets) {
    const acquired = await acquireSpawnSlot()
    if (!acquired) continue
    try {
      let cwd = target.cwd
      if (!cwd) {
        const live = await getPtyCwd(target.ptyId).catch(() => null)
        cwd = (live ?? '').trim()
      }

      const active = getActiveSessions()[target.ptyId]
      const exclude: SessionExclude = {
        id:
          target.agent === 'codex'
            ? active?.codexSessionId
            : target.agent === 'opencode'
              ? active?.opencodeSessionId
              : active?.claudeSessionId,
        before: active?.timestamp,
      }
      const savedOpenCodeId = target.agent === 'opencode' ? active?.opencodeSessionId : undefined
      // With nothing older to go back to, the pane stays on the conversation it has.
      const found = await latestSessionId(target.agent, cwd, exclude, savedOpenCodeId)
      const request = paneAgentRequestById(target.projectId, target.terminalId, target.tabId) ?? {
        agent: target.agent,
        cwd,
        extraArgs: target.extraArgs,
      }
      const launch = await restartPaneAgent(
        { id: target.ptyId, cwd: cwd || undefined },
        { ...request, resumeId: found ?? exclude.id },
      )
      const sessionId = launch.sessionId

      saveSession(target.ptyId, {
        sessionId: target.ptyId,
        claudeSessionId: target.agent === 'claude' ? sessionId : undefined,
        codexSessionId: target.agent === 'codex' ? sessionId : undefined,
        opencodeSessionId: target.agent === 'opencode' ? sessionId : undefined,
        cwd,
        agent: target.agent,
        timestamp: Date.now(),
      })
      if (sessionId) {
        useProjectsStore
          .getState()
          .setSubTabSessionId(target.projectId, target.terminalId, target.tabId, sessionId)
      }

      resumed++
    } catch {
    } finally {
      releaseSpawnSlot()
    }
  }

  return { resumed, total: targets.length }
}
