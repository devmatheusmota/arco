import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const nodeFs = require('node:fs') as typeof import('node:fs')
const { claudeProjectDir, listClaudeSessions, readSessionMeta, sessionTitle, snapshotClaudeDir } =
  require('../../electron/commands/sessions.cjs') as {
    claudeProjectDir: (cwd: string) => string
    sessionTitle: (cwd: string, sessionId: string) => string | null
    snapshotClaudeDir: (dir: string) => Array<{
      id: string
      preview: string
      size_bytes: number
      interactive: boolean
    }>
    listClaudeSessions: (dir: string) => Array<{
      id: string
      title: string | null
      first_user_prompt: string | null
      message_count: number
    }>
    readSessionMeta: (file: string) => {
      title: string | null
      first_user_prompt: string | null
      message_count: number
    }
  }

const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } })
const assistant = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const aiTitle = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title })

let dir: string

function writeSession(name: string, lines: string[]): string {
  const file = join(dir, name)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arco-sessions-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('readSessionMeta', () => {
  it('names the session after the latest title Claude wrote', () => {
    const file = writeSession('a.jsonl', [
      user('first question'),
      aiTitle('Early guess'),
      assistant('answer'),
      aiTitle('Session naming'),
    ])
    expect(readSessionMeta(file).title).toBe('Session naming')
  })

  it('falls back to the first prompt someone typed, skipping injected text', () => {
    const file = writeSession('b.jsonl', [
      user('<command-name>/release</command-name>'),
      user('Caveat: The messages below were generated while running /release'),
      user('  sobe uma versão com o fix  '),
      assistant('done'),
    ])
    const meta = readSessionMeta(file)
    expect(meta.title).toBeNull()
    expect(meta.first_user_prompt).toBe('sobe uma versão com o fix')
  })

  it('counts every message instead of stopping at the first records', () => {
    const lines: string[] = []
    for (let i = 0; i < 40; i += 1) {
      lines.push(user(`q${i}`), assistant(`a${i}`))
    }
    expect(readSessionMeta(writeSession('c.jsonl', lines)).message_count).toBe(80)
  })

  it('survives a line larger than one read buffer and multi-byte splits', () => {
    const padding = 'ção '.repeat(40_000)
    const file = writeSession('d.jsonl', [
      user('short prompt'),
      assistant(padding),
      aiTitle('Big transcript'),
    ])
    const meta = readSessionMeta(file)
    expect(meta.title).toBe('Big transcript')
    expect(meta.first_user_prompt).toBe('short prompt')
    expect(meta.message_count).toBe(2)
  })

  it('reports nothing for a file it cannot read', () => {
    expect(readSessionMeta(join(dir, 'missing.jsonl'))).toEqual({
      title: null,
      first_user_prompt: null,
      message_count: 0,
    })
  })
})

describe('listClaudeSessions', () => {
  it('lists every transcript with its name, newest first', () => {
    writeSession('old.jsonl', [user('older conversation')])
    writeSession('new.jsonl', [user('newer conversation'), aiTitle('Named one')])
    const [newest, oldest] = listClaudeSessions(dir).sort((a, b) => a.id.localeCompare(b.id))
    expect(newest).toMatchObject({ id: 'new', title: 'Named one', message_count: 1 })
    expect(oldest).toMatchObject({
      id: 'old',
      title: null,
      first_user_prompt: 'older conversation',
    })
  })

  it('returns nothing for a directory that does not exist', () => {
    expect(listClaudeSessions(join(dir, 'nope'))).toEqual([])
  })

  it('hides a transcript that holds a header and no message', () => {
    writeSession('real.jsonl', [user('a real conversation')])
    writeSession('stub.jsonl', [aiTitle('Security review'), JSON.stringify({ type: 'mode' })])
    expect(listClaudeSessions(dir).map((session) => session.id)).toEqual(['real'])
  })

  it('keeps every transcript when none of them parsed as a conversation', () => {
    writeSession('stub.jsonl', [aiTitle('Security review')])
    expect(listClaudeSessions(dir).map((session) => session.id)).toEqual(['stub'])
  })
})

describe('snapshotClaudeDir', () => {
  const sdkPrompt = (text: string) =>
    JSON.stringify({ type: 'user', message: { content: text }, entrypoint: 'sdk-cli' })

  it('stops reading a transcript at its first prompt', () => {
    const tail = assistant('x'.repeat(64 * 1024))
    writeSession('review.jsonl', [
      JSON.stringify({ type: 'mode' }),
      sdkPrompt('run the security review'),
      ...Array.from({ length: 64 }, () => tail),
    ])
    const readSync = vi.spyOn(nodeFs, 'readSync')
    const [session] = snapshotClaudeDir(dir)
    expect(session).toMatchObject({
      id: 'review',
      preview: 'run the security review',
      interactive: false,
    })
    // 4 MB of transcript behind the prompt; one 64 KB read reaches it.
    expect(readSync.mock.calls.length).toBeGreaterThan(0)
    expect(readSync.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('does not open a transcript again once its first prompt is known', () => {
    const file = writeSession('a.jsonl', [user('hello')])
    snapshotClaudeDir(dir)
    appendFileSync(file, `${assistant('a reply that grows the file')}\n`)
    const openSync = vi.spyOn(nodeFs, 'openSync')
    const [session] = snapshotClaudeDir(dir)
    expect(openSync).not.toHaveBeenCalled()
    expect(session).toMatchObject({ preview: 'hello', interactive: true })
  })

  it('reads a transcript again when it grew before its first prompt arrived', () => {
    const file = writeSession('new.jsonl', [JSON.stringify({ type: 'mode' })])
    expect(snapshotClaudeDir(dir)[0]).toMatchObject({ preview: '', interactive: true })

    const openSync = vi.spyOn(nodeFs, 'openSync')
    snapshotClaudeDir(dir)
    expect(openSync).not.toHaveBeenCalled()

    appendFileSync(file, `${sdkPrompt('automated run')}\n`)
    expect(snapshotClaudeDir(dir)[0]).toMatchObject({
      preview: 'automated run',
      interactive: false,
    })
  })

  it('forgets a transcript deleted from disk', () => {
    writeSession('gone.jsonl', [user('soon deleted')])
    writeSession('kept.jsonl', [user('still here')])
    expect(snapshotClaudeDir(dir)).toHaveLength(2)
    rmSync(join(dir, 'gone.jsonl'))
    expect(snapshotClaudeDir(dir).map((session) => session.id)).toEqual(['kept'])
  })
})

describe('sessionTitle', () => {
  // The title lookup resolves the directory from the cwd, so the transcript has
  // to live where Claude would put it for that cwd.
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.HOME
    home = mkdtempSync(join(tmpdir(), 'arco-title-'))
    process.env.HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  function transcript(cwd: string, id: string): string {
    const projectDir = claudeProjectDir(cwd)
    mkdirSync(projectDir, { recursive: true })
    return join(projectDir, `${id}.jsonl`)
  }

  it('follows a transcript as it grows, reading only what was appended', () => {
    const file = transcript('/repo/app', 's1')
    writeFileSync(file, `${user('first question')}\n`)
    expect(sessionTitle('/repo/app', 's1')).toBe('first question')

    // A record written in two pieces: the first call sees half a line.
    const titled = aiTitle('Naming the session')
    appendFileSync(file, titled.slice(0, 10))
    expect(sessionTitle('/repo/app', 's1')).toBe('first question')
    appendFileSync(file, `${titled.slice(10)}\n`)

    const readSync = vi.spyOn(nodeFs, 'readSync')
    expect(sessionTitle('/repo/app', 's1')).toBe('Naming the session')
    const bytesRead = readSync.mock.results.reduce((sum, r) => sum + Number(r.value), 0)
    expect(bytesRead).toBeLessThan(titled.length + 16)
  })

  it('starts over when the file was rewritten shorter', () => {
    const file = transcript('/repo/app', 's2')
    writeFileSync(file, `${user('a long first conversation here')}\n${aiTitle('Old name')}\n`)
    expect(sessionTitle('/repo/app', 's2')).toBe('Old name')
    writeFileSync(file, `${user('new')}\n`)
    expect(sessionTitle('/repo/app', 's2')).toBe('new')
  })
})

describe('claudeProjectDir', () => {
  const dirName = (cwd: string) => basename(claudeProjectDir(cwd))

  it('turns every character that is not a letter or digit into a dash, as Claude does', () => {
    expect(dirName('/home/mota/projetos/emr/EGA2.0/.arco/worktrees/cl-uVV6_A')).toBe(
      '-home-mota-projetos-emr-EGA2-0--arco-worktrees-cl-uVV6-A',
    )
    expect(dirName('/home/dev/my repo@v2')).toBe('-home-dev-my-repo-v2')
  })

  it('encodes a Windows path and ignores a trailing separator', () => {
    expect(dirName('C:\\Users\\dev\\repo\\')).toBe('C--Users-dev-repo')
    expect(dirName('/home/dev/repo/')).toBe('-home-dev-repo')
  })

  it('cuts a long path and appends the hash Claude uses to tell them apart', () => {
    const cwd = `/home/dev/${'deeply_nested.folder/'.repeat(12)}repo`
    const name = dirName(cwd)
    expect(name).toHaveLength(207)
    expect(name.endsWith('-d-d1hkab')).toBe(true)
  })
})
