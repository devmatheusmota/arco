import { useEffect } from 'react'

import { registerSessionClaim, releaseSessionClaim } from '../lib/sessionDiscovery'
import { planSessionFollow } from '../lib/sessionFollow'
import { saveSession } from '../lib/sessionResume'
import { listenSessionHook, recordAppEvent } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

/**
 * Keeps each Claude pane pointing at the conversation its agent is actually in.
 *
 * `/resume` inside the agent goes back to a conversation that already exists, so
 * the directory watcher never sees it, and the pane used to come back after a
 * restart to the one it had left.
 */
export function useClaudeSessionFollow(hydrated: boolean) {
  useEffect(() => {
    if (!hydrated) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void listenSessionHook((event) => {
      const store = useProjectsStore.getState()
      const target = planSessionFollow(store.projects, event.pty, event.sessionId, event.cwd)
      if (!target) return
      const { tab, cwd } = target
      const ptyId = tab.ptyId ?? tab.id
      store.setSubTabSessionId(target.projectId, target.terminalId, tab.id, event.sessionId)
      saveSession(tab.id, {
        sessionId: ptyId,
        claudeSessionId: event.sessionId,
        cwd,
        agent: 'claude',
        timestamp: Date.now(),
      })
      if (cwd) {
        // The conversation it left is free for anyone to resume again.
        releaseSessionClaim(tab.id)
        if (ptyId !== tab.id) releaseSessionClaim(ptyId)
        registerSessionClaim('claude', cwd, event.sessionId, tab.id)
        registerSessionClaim('claude', cwd, event.sessionId, ptyId)
      }
      void recordAppEvent(
        'session.follow',
        `agent=claude pty=${ptyId} from=${tab.sessionId ?? '—'} to=${event.sessionId} source=${event.source ?? '—'}`,
      )
    }).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [hydrated])
}
