import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const restartPty = vi.fn()

vi.mock('./tauri', () => ({
  restartPty: (args: unknown) => restartPty(args),
}))

import { useTerminalsStore } from '../stores/terminalsStore'
import { PTY_RESTART_EVENT, type PtyRestartDetail, restartPaneProcess } from './ptyRestart'

const alive = () => useTerminalsStore.getState().byPtyId['pty-1']?.alive

describe('restarting a pane process in place', () => {
  let events: PtyRestartDetail[]
  const record = (event: Event) => events.push((event as CustomEvent<PtyRestartDetail>).detail)

  beforeEach(() => {
    events = []
    restartPty.mockReset()
    window.addEventListener(PTY_RESTART_EVENT, record)
  })

  afterEach(() => {
    window.removeEventListener(PTY_RESTART_EVENT, record)
    useTerminalsStore.getState().reset()
  })

  it('brings back a pane the store had already marked as ended', async () => {
    // "Open here" used to restart without telling the store: the pane read as
    // ended while its new process ran, and the Restart button inherited that.
    useTerminalsStore.getState().registerPty('pty-1')
    useTerminalsStore.getState().markExited('pty-1')
    restartPty.mockImplementation(async () => {
      expect(alive()).toBe(true)
      return { id: 'pty-1' }
    })

    await restartPaneProcess({ id: 'pty-1', cols: 80, rows: 24, command: 'claude' })

    expect(alive()).toBe(true)
    expect(restartPty).toHaveBeenCalledTimes(1)
  })

  it('tells the pane before the old process goes and after the new one runs', async () => {
    restartPty.mockImplementation(async () => {
      expect(events).toEqual([{ ptyId: 'pty-1', phase: 'begin' }])
      return { id: 'pty-1' }
    })

    await restartPaneProcess({ id: 'pty-1', cols: 80, rows: 24 })

    expect(events).toEqual([
      { ptyId: 'pty-1', phase: 'begin' },
      { ptyId: 'pty-1', phase: 'spawned' },
    ])
  })

  it('reports the pane ended when nothing replaced the old process', async () => {
    useTerminalsStore.getState().registerPty('pty-1')
    restartPty.mockRejectedValue(new Error('command not found: claude'))

    await expect(restartPaneProcess({ id: 'pty-1', cols: 80, rows: 24 })).rejects.toThrow(
      'command not found',
    )

    expect(alive()).toBe(false)
    expect(events.map((event) => event.phase)).toEqual(['begin'])
  })
})
