import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const hostPath = join(process.cwd(), 'electron', 'pty-host.cjs')

let host: ChildProcess | null = null

function startHost(): ChildProcess {
  host = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'ignore'] })
  return host
}

/** Resolves with the exit reason, or `null` if the host outlived the wait. */
function waitForExit(child: ChildProcess, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve(signal ?? String(code))
    })
  })
}

/** Waits for the reply to a single request, so a spawned PTY is ready to check. */
function request(child: ChildProcess, cmd: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.type !== 'reply' || message.requestId !== 1) continue
        child.stdout?.off('data', onData)
        if (message.error) reject(new Error(message.error))
        else resolve(message.result)
      }
    }
    child.stdout?.on('data', onData)
    child.stdin?.write(`${JSON.stringify({ requestId: 1, cmd, args })}\n`)
  })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  if (host && host.exitCode === null) host.kill('SIGKILL')
  host = null
})

describe('pty host shutdown', () => {
  // The host used to be reparented to init and keep every terminal alive for
  // the rest of the user's session. Closed stdin is how it learns the parent is
  // gone, and it is the only signal a crashed parent leaves behind.
  it('exits when stdin closes', async () => {
    const child = startHost()
    child.stdin?.end()
    expect(await waitForExit(child, 5_000)).not.toBeNull()
  })

  it('exits on SIGTERM', async () => {
    const child = startHost()
    child.kill('SIGTERM')
    expect(await waitForExit(child, 5_000)).not.toBeNull()
  })

  it('takes its terminals down with it', async () => {
    const child = startHost()
    const { pid } = await request(child, 'spawn_pty', {
      id: 'shutdown-test',
      command: '/bin/sh',
      args: ['-c', 'sleep 30'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    expect(alive(pid)).toBe(true)

    child.stdin?.end()
    expect(await waitForExit(child, 5_000)).not.toBeNull()
    // The kill is asynchronous on the OS side; give it a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(alive(pid)).toBe(false)
  })
})
