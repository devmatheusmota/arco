import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { pruneScrollback } = require('../../electron/commands/scrollback-prune.cjs') as {
  pruneScrollback: (options: {
    dir: string
    profilesDir: string
    liveIds?: string[]
    now?: number
  }) => Promise<number>
}

const DAY_MS = 24 * 60 * 60 * 1000

let root: string
let dir: string
let profilesDir: string

function profile(name: string, ptyIds: string[]): void {
  mkdirSync(join(profilesDir, name), { recursive: true })
  writeFileSync(
    join(profilesDir, name, 'projects.json'),
    JSON.stringify({
      projects: [
        { terminals: [{ tabs: ptyIds.map((ptyId, index) => ({ id: `t${index}`, ptyId })) }] },
      ],
    }),
  )
}

function record(name: string, ageDays: number): string {
  const file = join(dir, name)
  writeFileSync(file, 'output')
  const at = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(file, at, at)
  return file
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arco-prune-'))
  dir = join(root, 'scrollback')
  profilesDir = join(root, 'profiles')
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('pruneScrollback', () => {
  it('removes old records nothing points at, and only those', async () => {
    profile('default', ['kept-default'])
    profile('pessoal', ['kept-other-profile'])
    const orphan = record('orphan.bin', 30)
    const leftover = record('orphan-tmp.bin.tmp', 30)
    const recent = record('recent.bin', 1)
    const referenced = record('kept-default.bin', 30)
    const otherProfile = record('kept-other-profile.bin', 30)
    const running = record('running.bin', 30)

    const removed = await pruneScrollback({ dir, profilesDir, liveIds: ['running'] })

    expect(removed).toBe(2)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(referenced)).toBe(true)
    expect(existsSync(otherProfile)).toBe(true)
    expect(existsSync(running)).toBe(true)
  })

  it('keeps everything when a profile document cannot be read', async () => {
    profile('default', ['kept'])
    mkdirSync(join(profilesDir, 'broken'), { recursive: true })
    writeFileSync(join(profilesDir, 'broken', 'projects.json'), '{ not json')
    const orphan = record('orphan.bin', 30)

    expect(await pruneScrollback({ dir, profilesDir })).toBe(0)
    expect(existsSync(orphan)).toBe(true)
  })

  it('keeps everything when no profile points at any pane', async () => {
    const orphan = record('orphan.bin', 30)

    expect(await pruneScrollback({ dir, profilesDir })).toBe(0)
    expect(existsSync(orphan)).toBe(true)
  })
})
