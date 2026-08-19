import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { listClaudeSessions, readSessionMeta } = require('../../electron/commands/sessions.cjs') as {
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
