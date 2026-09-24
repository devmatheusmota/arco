import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const hostPath = join(process.cwd(), 'electron', 'pty-host.cjs')

let host: ChildProcess | null = null

/**
 * The host has no console a user can reach, so everything it knows about a
 * terminal that never appeared has to travel to the main process as a log
 * message. These tests pin that channel: without it, a pane that never starts
 * leaves nothing behind to read.
 */
function startHost(): ChildProcess {
  host = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'ignore'] })
  return host
}

function readUntil(child: ChildProcess, match: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.stdout?.off('data', onData)
      reject(new Error('the host said nothing in time'))
    }, 10_000)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!match(message)) continue
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolve(message)
      }
    }
    child.stdout?.on('data', onData)
  })
}

function request(child: ChildProcess, requestId: number, cmd: string, args: unknown) {
  child.stdin?.write(`${JSON.stringify({ requestId, cmd, args })}\n`)
}

afterEach(() => {
  if (host && host.exitCode === null) host.kill('SIGKILL')
  host = null
})

describe('pty host logging', () => {
  it('reports a spawn with its pid and command', async () => {
    const child = startHost()
    const logged = readUntil(child, (m) => m.type === 'log' && m.kind === 'pty.spawn')
    request(child, 1, 'spawn_pty', {
      id: 'log-test',
      command: '/bin/sh',
      args: ['-c', 'sleep 5'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    const message = (await logged).message as string
    expect(message).toContain('id=log-test')
    expect(message).toMatch(/pid=\d+/)
  })

  // A command that is not installed is the most common reason a pane never
  // reaches a terminal, and it used to be reported only to the caller.
  it('reports a command that does not exist', async () => {
    const child = startHost()
    const logged = readUntil(child, (m) => m.type === 'log' && m.kind === 'pty.spawn.error')
    request(child, 1, 'spawn_pty', {
      id: 'log-missing',
      command: 'definitely-not-a-real-binary-xyz',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    expect((await logged).message).toContain('not found on PATH')
  })

  it('reports an exit with its code and how long it ran', async () => {
    const child = startHost()
    const logged = readUntil(child, (m) => m.type === 'log' && m.kind === 'pty.exit')
    request(child, 1, 'spawn_pty', {
      id: 'log-exit',
      command: '/bin/sh',
      args: ['-c', 'exit 3'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    const message = (await logged).message as string
    expect(message).toContain('code=3')
    expect(message).toMatch(/after=\d+ms/)
  })
})

// The pane tells a restart or a suspension apart from the agent ending by the
// reason on the exit. Without it, a suspended pane lost its "Resume" and a
// restarted one dropped its saved session.
describe('pty host exit reason', () => {
  const spawnArgs = (id: string, script: string) => ({
    id,
    command: '/bin/sh',
    args: ['-c', script],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  it('reports an agent that ended by itself as exited', async () => {
    const child = startHost()
    const exited = readUntil(child, (m) => m.type === 'exit' && m.id === 'reason-exit')
    request(child, 1, 'spawn_pty', spawnArgs('reason-exit', 'exit 0'))

    expect((await exited).reason).toBe('exited')
  })

  it.each([
    ['restarted', 'restarted'],
    ['suspended', 'suspended'],
    [undefined, 'killed'],
  ])('reports a kill asked for as %s', async (asked, reported) => {
    const child = startHost()
    const spawned = readUntil(child, (m) => m.type === 'reply' && m.requestId === 1)
    request(child, 1, 'spawn_pty', spawnArgs('reason-kill', 'sleep 5'))
    await spawned
    const exited = readUntil(child, (m) => m.type === 'exit' && m.id === 'reason-kill')
    request(child, 2, 'kill_pty', { id: 'reason-kill', reason: asked })

    expect((await exited).reason).toBe(reported)
  })
})

describe('restarting a live terminal on the real host', () => {
  it('starts a new process once the old one has answered the hangup', async () => {
    const { restartPty } = (await import('../../electron/commands/ptyRestart.cjs')) as {
      restartPty: (
        ptyHost: { request: (cmd: string, args: unknown) => Promise<any> },
        args: Record<string, unknown>,
      ) => Promise<{ id: string; pid?: number }>
    }
    const child = startHost()
    let nextId = 1
    const ptyHost = {
      request: (cmd: string, args: unknown) => {
        const requestId = nextId++
        const reply = readUntil(child, (m) => m.type === 'reply' && m.requestId === requestId)
        request(child, requestId, cmd, args)
        return reply.then((m) => m.result)
      },
    }
    // Takes a moment to go after SIGHUP, the way an agent flushes its transcript.
    const script = 'trap "sleep 0.3; exit 129" HUP; while :; do sleep 0.05; done'
    const args = { id: 'restart-live', command: '/bin/sh', extraArgs: ['-c', script] }
    const first = await ptyHost.request('spawn_pty', { ...args, args: args.extraArgs })
    await new Promise((resolve) => setTimeout(resolve, 200))

    const second = await restartPty(ptyHost, args)

    expect(second.pid).toBeDefined()
    expect(second.pid).not.toBe(first.pid)
    expect(await ptyHost.request('pty_exists', { id: 'restart-live' })).toBe(true)
  })
})
