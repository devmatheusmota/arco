import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

type Request = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

const require = createRequire(import.meta.url)
const { restartPty } = require('../../electron/commands/ptyRestart.cjs') as {
  restartPty: (
    ptyHost: { request: Request },
    args: {
      id: string
      command?: string
      extraArgs?: string[]
      cwd?: string
      launcherOverride?: string
    },
    options?: { pollMs?: number; waitMs?: number },
  ) => Promise<unknown>
}

/**
 * A host whose session outlives the kill for `exitsAfterPolls` checks, the way
 * an agent does while it answers the hangup with its own shutdown.
 */
function fakeHost(alive: boolean, exitsAfterPolls: number) {
  const calls: string[] = []
  let polls = 0
  let running = alive
  const request: Request = async (cmd) => {
    calls.push(cmd)
    if (cmd === 'kill_pty') return running
    if (cmd === 'pty_exists') {
      polls += 1
      if (polls > exitsAfterPolls) running = false
      return running
    }
    if (cmd === 'spawn_pty') {
      if (running) return { id: 'pty-1', reused: true }
      running = true
      return { id: 'pty-1' }
    }
    return null
  }
  return { request, calls }
}

describe('restartPty', () => {
  it('spawns the new process only after the old one has exited', async () => {
    const host = fakeHost(true, 3)

    const result = await restartPty(host, { id: 'pty-1', command: 'claude' }, { pollMs: 0 })

    expect(result).toEqual({ id: 'pty-1' })
    expect(host.calls.filter((cmd) => cmd === 'pty_exists')).toHaveLength(4)
    expect(host.calls.at(-1)).toBe('spawn_pty')
  })

  it('keeps the configured CLI when it starts the new process', async () => {
    const spawned: unknown[] = []
    const host = {
      request: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'spawn_pty') spawned.push(args.launcherOverride)
        return cmd === 'spawn_pty' ? { id: 'pty-1' } : false
      },
    }

    await restartPty(host, { id: 'pty-1', command: 'claude', launcherOverride: '/opt/claude' })

    expect(spawned).toEqual(['/opt/claude'])
  })

  it('spawns right away when there was no process left to kill', async () => {
    const host = fakeHost(false, 0)

    await restartPty(host, { id: 'pty-1', command: 'claude' }, { pollMs: 0 })

    expect(host.calls).toEqual(['kill_pty', 'spawn_pty'])
  })

  it('fails instead of reporting a restart when the old process never goes', async () => {
    const host = fakeHost(true, Number.POSITIVE_INFINITY)

    await expect(
      restartPty(host, { id: 'pty-1', command: 'claude' }, { pollMs: 0, waitMs: 0 }),
    ).rejects.toThrow(/did not exit/)
    expect(host.calls).not.toContain('spawn_pty')
  })
})
