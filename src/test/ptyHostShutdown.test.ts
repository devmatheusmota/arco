import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const hostPath = join(process.cwd(), 'electron', 'pty-host.cjs')

/**
 * Stands in for the agent that leaked: a process that holds SIGHUP and SIGTERM
 * and keeps running. The pty hanging up is not enough to collect it — only a
 * kill aimed at the whole process group is.
 */
const STUBBORN = `
process.on('SIGHUP', () => {})
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
setInterval(() => {}, 1000)
console.log('GRANDCHILD=' + process.pid)
`

let fixtureDir: string
let stubbornPath: string
let host: ChildProcess | null = null

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'arco-pty-shutdown-'))
  stubbornPath = join(fixtureDir, 'stubborn.cjs')
  writeFileSync(stubbornPath, STUBBORN)
  return () => rmSync(fixtureDir, { recursive: true, force: true })
})

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

/** Reads the host's newline-delimited JSON until `match` accepts a message. */
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A terminal holding a child of its own — the shape that leaks. A coding agent
 * is the process on the pty and its MCP servers are underneath it, so a signal
 * that only reaches the pty leaves the memory behind. The child here holds its
 * signals, the way the agent that leaked in production did: the pty hanging up
 * collects the shell and nothing else.
 */
async function spawnSessionWithChild(child: ChildProcess) {
  const reply = readUntil(child, (m) => m.type === 'reply' && m.requestId === 1)
  const printed = readUntil(child, (m) => m.type === 'data' && /GRANDCHILD=\d+/.test(m.data))
  child.stdin?.write(
    `${JSON.stringify({
      requestId: 1,
      cmd: 'spawn_pty',
      args: {
        id: 'shutdown-test',
        command: '/bin/sh',
        args: ['-c', `${process.execPath} ${stubbornPath} & wait`],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      },
    })}\n`,
  )
  const shellPid = (await reply).result.pid as number
  const grandchildPid = Number(/GRANDCHILD=(\d+)/.exec((await printed).data)![1])
  expect(alive(shellPid)).toBe(true)
  expect(alive(grandchildPid)).toBe(true)
  return { shellPid, grandchildPid }
}

/** The kill is asynchronous on the OS side; give it a beat to land. */
async function settle(ms = 1_500) {
  await new Promise((resolve) => setTimeout(resolve, ms))
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
    expect(await waitForExit(child, 8_000)).not.toBeNull()
  })

  it('exits on SIGTERM', async () => {
    const child = startHost()
    child.kill('SIGTERM')
    expect(await waitForExit(child, 8_000)).not.toBeNull()
  })

  it('takes the whole terminal tree down when stdin closes', async () => {
    const child = startHost()
    const { shellPid, grandchildPid } = await spawnSessionWithChild(child)

    child.stdin?.end()
    expect(await waitForExit(child, 8_000)).not.toBeNull()
    await settle()
    expect(alive(shellPid)).toBe(false)
    expect(alive(grandchildPid)).toBe(false)
  }, 20_000)

  // Killing the host on its own is the case that leaked in production: the host
  // died and its sessions were handed to init, still running.
  it('takes the whole terminal tree down on SIGTERM', async () => {
    const child = startHost()
    const { shellPid, grandchildPid } = await spawnSessionWithChild(child)

    child.kill('SIGTERM')
    expect(await waitForExit(child, 8_000)).not.toBeNull()
    await settle()
    expect(alive(shellPid)).toBe(false)
    expect(alive(grandchildPid)).toBe(false)
  }, 20_000)

  it('kills the tree of a single session closed from the app', async () => {
    const child = startHost()
    const { shellPid, grandchildPid } = await spawnSessionWithChild(child)

    const killed = readUntil(child, (m) => m.type === 'reply' && m.requestId === 2)
    child.stdin?.write(
      `${JSON.stringify({ requestId: 2, cmd: 'kill_pty', args: { id: 'shutdown-test' } })}\n`,
    )
    expect((await killed).result).toBe(true)
    // Past the grace period: what holds the hangup is only killed after it.
    await settle(3_500)
    expect(alive(shellPid)).toBe(false)
    expect(alive(grandchildPid)).toBe(false)
  }, 20_000)
})
