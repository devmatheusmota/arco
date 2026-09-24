import type { Project, SubTab } from './types'

export type SessionFollowTarget = {
  projectId: string
  terminalId: string
  tab: SubTab
  cwd: string
}

/**
 * The Claude tab a SessionStart report moves, or `null` when it changes nothing.
 *
 * The report names the process by its PTY id. A tab already pointing at the
 * reported conversation — every start and every `--resume` — is left alone, so
 * only a real move (`/clear`, `/resume` inside the agent) reaches the store.
 */
export function planSessionFollow(
  projects: readonly Project[],
  ptyId: string,
  sessionId: string,
  reportedCwd: string | null,
): SessionFollowTarget | null {
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if ((tab.ptyId ?? tab.id) !== ptyId) continue
        if (tab.type !== 'claude' || tab.sessionId === sessionId) return null
        const cwd = tab.cwd || terminal.cwd || reportedCwd || ''
        return { projectId: project.id, terminalId: terminal.id, tab, cwd }
      }
    }
  }
  return null
}
