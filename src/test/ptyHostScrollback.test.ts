import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { ScrollbackBuffer } = require('../../electron/scrollback-buffer.cjs') as {
  ScrollbackBuffer: new (
    cap: number,
    initial?: string,
  ) => {
    chunks: string[]
    length: number
    append: (data: string) => void
    text: () => string
    reset: (text?: string) => void
  }
}

const hostPath = join(process.cwd(), 'electron', 'pty-host.cjs')

describe('ScrollbackBuffer', () => {
  it('keeps everything while under the cap', () => {
    const buffer = new ScrollbackBuffer(100)
    buffer.append('one\n')
    buffer.append('two\n')
    expect(buffer.text()).toBe('one\ntwo\n')
  })

  it('appends without cutting until a quarter past the cap', () => {
    const buffer = new ScrollbackBuffer(100)
    for (let index = 0; index < 12; index += 1) buffer.append('123456789\n')
    // 120 characters: past the cap, inside the slack, still one chunk per append.
    expect(buffer.chunks).toHaveLength(12)
    buffer.append('123456789\n')
    // 130 crosses the slack: one cut, back under the cap.
    expect(buffer.chunks).toHaveLength(1)
    expect(buffer.length).toBeLessThanOrEqual(100)
  })

  it('cuts on a line boundary and hands back at most the cap', () => {
    const buffer = new ScrollbackBuffer(20)
    for (const line of ['aaaa\n', 'bbbb\n', 'cccc\n', 'dddd\n', 'eeee\n']) buffer.append(line)
    const text = buffer.text()
    expect(text.length).toBeLessThanOrEqual(20)
    expect(text.endsWith('eeee\n')).toBe(true)
    expect(text.startsWith('bbbb\n') || text.startsWith('cccc\n')).toBe(true)
  })

  it('carries the terminal modes of what it cut', () => {
    const buffer = new ScrollbackBuffer(40)
    buffer.append('\x1b[?2004h\x1b[?1049h\n')
    for (let index = 0; index < 10; index += 1) buffer.append(`line ${index}\n`)
    const text = buffer.text()
    expect(text.startsWith('\x1b[?2004h\x1b[?1049h')).toBe(true)
    expect(text.endsWith('line 9\n')).toBe(true)
  })
})

let host: ChildProcess | null = null
let dir: string | null = null

type HostMessage = { type: string; id?: string; data?: string; requestId?: number; result?: any }

function startHost(): { child: ChildProcess; messages: HostMessage[] } {
  const child = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'ignore'] })
  host = child
  const messages: HostMessage[] = []
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      try {
        messages.push(JSON.parse(line))
      } catch {}
    }
  })
  return { child, messages }
}

let nextRequestId = 1

function request(child: ChildProcess, cmd: string, args: unknown): number {
  const requestId = nextRequestId++
  child.stdin?.write(`${JSON.stringify({ requestId, cmd, args })}\n`)
  return requestId
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the host')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function spawnArgs(id: string, script: string) {
  return { id, command: '/bin/sh', args: ['-c', script], cwd: process.cwd(), cols: 80, rows: 24 }
}

const outputOf = (messages: HostMessage[], id: string, type: string) =>
  messages
    .filter((message) => message.type === type && message.id === id)
    .map((message) => message.data)
    .join('')

afterEach(() => {
  if (host && host.exitCode === null) host.kill('SIGKILL')
  host = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe.runIf(process.platform !== 'win32')('pty host scrollback', () => {
  it('streams every byte in order and writes the record when the terminal exits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arco-scrollback-'))
    const { child, messages } = startHost()
    request(child, 'configure', { dir })
    request(
      child,
      'spawn_pty',
      spawnArgs(
        'order',
        "printf '\\033[?2004h'; i=0; while [ $i -lt 400 ]; do echo line-$i; i=$((i+1)); done",
      ),
    )
    await waitFor(() => messages.some((m) => m.type === 'exit' && m.id === 'order'))

    const streamed = outputOf(messages, 'order', 'data')
      .replace(/\r/g, '')
      .replace('\x1b[?2004h', '')
    const lines = streamed.split('\n').filter((line) => line.startsWith('line-'))
    expect(lines).toEqual(Array.from({ length: 400 }, (_, index) => `line-${index}`))

    const file = join(dir, 'order.bin')
    expect(existsSync(file)).toBe(true)
    const record = readFileSync(file, 'utf8')
    expect(record.startsWith('\x1b[?2004h')).toBe(true)
    expect(record.replace(/\r/g, '').endsWith('line-399\n')).toBe(true)

    const attachId = request(child, 'attach_pty', { id: 'order' })
    const reply = await waitFor(() =>
      messages.find((m) => m.type === 'reply' && m.requestId === attachId),
    )
    expect(reply.result).toBe(record)
  })

  it('sends output already recorded before it answers an attach', async () => {
    const { child, messages } = startHost()
    request(
      child,
      'spawn_pty',
      spawnArgs('race', 'i=0; while [ $i -lt 300 ]; do echo tick-$i; i=$((i+1)); done; sleep 5'),
    )
    // Attach while output is still streaming: every data message that carries
    // bytes the replay holds must come before the reply.
    await waitFor(() => messages.some((m) => m.type === 'data' && m.id === 'race'))
    const attachId = request(child, 'attach_pty', { id: 'race' })
    const replyIndex = await waitFor(() => {
      const index = messages.findIndex((m) => m.type === 'reply' && m.requestId === attachId)
      return index >= 0 ? index + 1 : undefined
    })
    const replay = messages[replyIndex - 1].result as string
    const before = messages
      .slice(0, replyIndex - 1)
      .filter((m) => m.type === 'data' && m.id === 'race')
      .map((m) => m.data)
      .join('')
    // The replay is exactly what was streamed before the reply, nothing more.
    expect(replay).toBe(before)
  })

  it('delivers the last output of a hidden pane without waiting for more', async () => {
    const { child, messages } = startHost()
    request(
      child,
      'spawn_pty',
      spawnArgs('hidden', 'sleep 0.4; printf A; sleep 0.1; printf B; sleep 5'),
    )
    request(child, 'set_pty_visible', { id: 'hidden', visible: false })

    const both = await waitFor(() => outputOf(messages, 'hidden', 'activity') === 'AB', 3_000)
    expect(both).toBe(true)
    expect(outputOf(messages, 'hidden', 'data')).toBe('')
  })

  it('sends what a hidden pane gathered as data when it is shown again', async () => {
    const { child, messages } = startHost()
    request(child, 'spawn_pty', spawnArgs('shown', 'sleep 0.3; printf hello; sleep 5'))
    request(child, 'set_pty_visible', { id: 'shown', visible: false })
    await waitFor(() => outputOf(messages, 'shown', 'activity') === 'hello', 3_000)
    request(child, 'set_pty_visible', { id: 'shown', visible: true })
    request(child, 'write_pty', { id: 'shown', data: '' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Already delivered as a digest: nothing is sent twice.
    expect(outputOf(messages, 'shown', 'data')).toBe('')
  })
})
