import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

type GithubSync = {
  status: () => {
    connected: boolean
    auto_push: boolean
    auto_push_minutes: number
    auto_push_error: string | null
    last_push_ms: number | null
  }
  setAuto: (options: { enabled?: boolean; minutes?: number }) => { auto_push_minutes: number }
  push: () => Promise<unknown>
  pull: () => Promise<unknown>
  startAutoSync: (options?: { publishEvent?: unknown }) => void
  stopAutoSync: () => void
  activeProjectsFile: () => string
}

let home: string
let sync: GithubSync

/** Points the shell's data directory at a scratch home for the whole module. */
function loadModule(): GithubSync {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-sync-'))
  process.env.HOME = home
  process.env.XDG_DATA_HOME = path.join(home, '.local/share')
  const resolved = require.resolve('../../electron/commands/github-sync.cjs')
  delete require.cache[resolved]
  delete require.cache[require.resolve('../../electron/commands/paths.cjs')]
  return require(resolved) as GithubSync
}

function writeState(state: Record<string, unknown>): void {
  const file = path.join(home, '.local/share/com.mota.arco/github-sync.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state))
}

function writeProjects(contents: string): void {
  const file = sync.activeProjectsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

const originalHome = process.env.HOME
const originalDataHome = process.env.XDG_DATA_HOME

beforeEach(() => {
  vi.useFakeTimers()
  sync = loadModule()
})

afterEach(() => {
  sync.stopAutoSync()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env.HOME = originalHome
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
  fs.rmSync(home, { recursive: true, force: true })
})

/** Answers every GitHub call with a valid gist, counting the writes. */
function stubGithub(): { calls: () => number } {
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH' || options?.method === 'POST') calls += 1
      return {
        ok: true,
        json: async () => ({ id: 'gist-1', html_url: 'https://gist.github.com/gist-1' }),
      }
    }),
  )
  return { calls: () => calls }
}

describe('automatic push', () => {
  it('uploads on the interval when the workspace changed', async () => {
    writeState({ token: 't', login: 'someone', auto_push: true, auto_push_minutes: 5 })
    writeProjects('{"todos":[]}')
    const github = stubGithub()

    sync.startAutoSync()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(github.calls()).toBe(1)
    expect(sync.status().last_push_ms).not.toBeNull()
  })

  it('sends nothing on a tick where the workspace is byte for byte the last upload', async () => {
    writeState({ token: 't', login: 'someone', auto_push: true, auto_push_minutes: 5 })
    writeProjects('{"todos":[]}')
    const github = stubGithub()

    sync.startAutoSync()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    // A gist keeps one revision per write; three identical ones buy nothing.
    expect(github.calls()).toBe(1)

    writeProjects('{"todos":[{"id":"a"}]}')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(github.calls()).toBe(2)
  })

  it('stays put while disconnected, however long it runs', async () => {
    writeState({ token: null, login: null, auto_push: true, auto_push_minutes: 5 })
    writeProjects('{"todos":[]}')
    const github = stubGithub()

    sync.startAutoSync()
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(github.calls()).toBe(0)
  })

  it('parks itself after three consecutive failures instead of hammering GitHub', async () => {
    writeState({ token: 't', login: 'someone', auto_push: true, auto_push_minutes: 5 })
    writeProjects('{"todos":[]}')
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return { ok: false, status: 401, json: async () => ({}) }
      }),
    )

    sync.startAutoSync()
    await vi.advanceTimersByTimeAsync(6 * 5 * 60_000)

    expect(calls).toBe(3)
    expect(sync.status().auto_push_error).toContain('401')
  })

  it('clamps an interval outside the range instead of scheduling a runaway timer', () => {
    writeState({ token: 't', login: 'someone', auto_push: true, auto_push_minutes: 5 })
    expect(sync.setAuto({ minutes: 1 }).auto_push_minutes).toBe(5)
    expect(sync.setAuto({ minutes: 10_000 }).auto_push_minutes).toBe(720)
  })

  it('does not push a pulled workspace straight back to the gist', async () => {
    writeState({ token: 't', login: 'someone', gist_id: 'gist-1', auto_push: true })
    writeProjects('{"todos":[]}')
    let writes = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: { method?: string }) => {
        if (options?.method === 'PATCH' || options?.method === 'POST') writes += 1
        return {
          ok: true,
          json: async () => ({
            id: 'gist-1',
            html_url: 'https://gist.github.com/gist-1',
            files: { 'arco-projects.json': { content: '{"todos":[{"id":"remoto"}]}' } },
          }),
        }
      }),
    )

    await sync.pull()
    sync.startAutoSync()
    await vi.advanceTimersByTimeAsync(15 * 60_000)

    expect(writes).toBe(0)
  })
})
