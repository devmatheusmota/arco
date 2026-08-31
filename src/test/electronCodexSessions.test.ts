import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { codexSessionTitle, snapshotCodexSessions } =
  require('../../electron/commands/sessions.cjs') as {
    codexSessionTitle: (sessionId: string) => string | null
    snapshotCodexSessions: (cwd: string) => Array<{ id: string; cwd: string }>
  }

const meta = (id: string, cwd: string) =>
  JSON.stringify({ type: 'session_meta', payload: { id, cwd } })
const userMessage = (text: string) =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })

let home: string

/** Writes a rollout where Codex puts it: `sessions/<year>/<month>/<day>`. */
function writeRollout(id: string, cwd: string, prompts: string[] = []): void {
  const dir = join(home, '.codex', 'sessions', '2026', '08', '31')
  mkdirSync(dir, { recursive: true })
  const lines = [meta(id, cwd), ...prompts.map(userMessage)]
  writeFileSync(join(dir, `rollout-2026-08-31T10-00-00-${id}.jsonl`), `${lines.join('\n')}\n`)
}

function writeIndex(entries: Array<{ id: string; thread_name: string }>): void {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'session_index.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'arco-codex-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('snapshotCodexSessions', () => {
  it('finds the rollouts Codex nests under a date directory', () => {
    writeRollout('session-a', '/repo/app')

    expect(snapshotCodexSessions('/repo/app').map((session) => session.id)).toEqual(['session-a'])
  })

  it('keeps only the sessions started in the requested directory', () => {
    writeRollout('session-a', '/repo/app')
    writeRollout('session-b', '/repo/other')

    expect(snapshotCodexSessions('/repo/app').map((session) => session.id)).toEqual(['session-a'])
  })

  it('ignores a trailing separator on the requested directory', () => {
    writeRollout('session-a', '/repo/app')

    expect(snapshotCodexSessions('/repo/app/')).toHaveLength(1)
  })

  it('answers empty without a directory to match', () => {
    writeRollout('session-a', '/repo/app')

    expect(snapshotCodexSessions('')).toEqual([])
  })
})

describe('codexSessionTitle', () => {
  it('reads the thread name Codex last wrote for the session', () => {
    writeRollout('session-a', '/repo/app', ['run the morning briefing'])
    writeIndex([
      { id: 'session-a', thread_name: '$morning' },
      { id: 'session-b', thread_name: 'another thread' },
      { id: 'session-a', thread_name: 'Morning briefing' },
    ])

    expect(codexSessionTitle('session-a')).toBe('Morning briefing')
  })

  it('falls back to the first typed prompt before the thread is named', () => {
    writeRollout('session-a', '/repo/app', [
      '<environment_context>cwd</environment_context>',
      '# AGENTS.md instructions for /repo/app',
      'fix the failing test',
      'and then ship it',
    ])

    expect(codexSessionTitle('session-a')).toBe('fix the failing test')
  })

  it('answers null for a session with no rollout of its own', () => {
    expect(codexSessionTitle('missing')).toBeNull()
  })

  it('refuses an id carrying a path separator', () => {
    expect(codexSessionTitle('../../etc/passwd')).toBeNull()
  })
})
