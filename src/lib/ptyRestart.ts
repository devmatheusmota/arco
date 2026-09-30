import { useTerminalsStore } from '../stores/terminalsStore'
import { restartPty, type SpawnPtyArgs } from './tauri'

/** Dispatched on `window` around every in-place restart, for the pane showing that PTY. */
export const PTY_RESTART_EVENT = 'arco:pty-restart'

export type PtyRestartDetail = {
  ptyId: string
  /** `begin` before the old process is stopped; `spawned` once the new one runs. */
  phase: 'begin' | 'spawned'
}

function announce(ptyId: string, phase: PtyRestartDetail['phase']): void {
  window.dispatchEvent(
    new CustomEvent<PtyRestartDetail>(PTY_RESTART_EVENT, { detail: { ptyId, phase } }),
  )
}

/**
 * Replaces the process behind a PTY id with a new one under the same id.
 *
 * The id does not change, so nothing about the pane changes on its own: the
 * runtime still says the process ended, the screen still holds the old one's
 * output, the output gate and the completion monitor still belong to it. Every
 * restart goes through here so the pane hears about it. A restart that skipped
 * the store left a pane behind "Process ended", reported offline, with its new
 * process running underneath.
 */
export async function restartPaneProcess(
  args: SpawnPtyArgs & { id: string },
): Promise<{ id: string }> {
  const { id } = args
  useTerminalsStore.getState().beginRestart(id)
  announce(id, 'begin')
  let result: { id: string }
  try {
    result = await restartPty(args)
  } catch (error) {
    // The old process is gone or going, and nothing took its place.
    useTerminalsStore.getState().markExited(id)
    throw error
  }
  announce(id, 'spawned')
  return result
}
