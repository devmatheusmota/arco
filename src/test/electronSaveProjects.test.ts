import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (args: Record<string, unknown>) => unknown

const require = createRequire(import.meta.url)

// The command modules destructure `electron` at load time; outside the app that
// require resolves to the binary path, so the stub has to be in the cache first.
require.cache[require.resolve('electron')] = {
  loaded: true,
  exports: { app: {}, shell: {} },
} as unknown as NodeJS.Module

const nodeFs = require('node:fs') as typeof import('node:fs')
const { buildCommands } = require('../../electron/commands/index.cjs') as {
  buildCommands: (ctx: Record<string, unknown>) => Record<string, Handler>
}

const handlers = buildCommands({
  ptyHost: { request: async () => [] },
  mainWindow: null,
  send: () => {},
})

let dataHome: string
let previousDataHome: string | undefined

function projectsFile(): string {
  return join(dataHome, 'com.mota.arco', 'profiles', 'default', 'projects.json')
}

function document(projects: number, marker = ''): string {
  return JSON.stringify({
    projects: Array.from({ length: projects }, (_, index) => ({ id: `p${index}` })),
    marker,
  })
}

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  dataHome = mkdtempSync(join(tmpdir(), 'arco-save-'))
  process.env.XDG_DATA_HOME = dataHome
  mkdirSync(join(dataHome, 'com.mota.arco', 'profiles', 'default'), { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  rmSync(dataHome, { recursive: true, force: true })
})

describe('save_projects', () => {
  it('writes what the renderer sends', async () => {
    await handlers.save_projects({ content: document(2, 'first'), sequence: 1, projectCount: 2 })
    expect(JSON.parse(readFileSync(projectsFile(), 'utf8')).marker).toBe('first')
  })

  it('refuses an empty workspace over a populated one', async () => {
    writeFileSync(projectsFile(), document(3, 'kept'))
    await handlers.save_projects({ content: document(0), sequence: 1, projectCount: 0 })
    expect(JSON.parse(readFileSync(projectsFile(), 'utf8')).marker).toBe('kept')
  })

  it('does not read the file back after writing it itself', async () => {
    await handlers.save_projects({ content: document(2, 'a'), sequence: 1, projectCount: 2 })
    const readFileSync = vi.spyOn(nodeFs, 'readFileSync')
    await handlers.save_projects({ content: document(2, 'b'), sequence: 2, projectCount: 2 })
    const readsOfProjects = readFileSync.mock.calls.filter(([file]) => file === projectsFile())
    expect(readsOfProjects).toHaveLength(0)
  })

  it('still guards a file something else rewrote since the last save', async () => {
    await handlers.save_projects({ content: document(0, 'empty'), sequence: 1, projectCount: 0 })
    // A restore from the gist, or another profile's file, lands behind its back.
    writeFileSync(projectsFile(), document(4, 'restored-with-more-bytes'))
    await handlers.save_projects({ content: document(0), sequence: 2, projectCount: 0 })
    expect(JSON.parse(readFileSync(projectsFile(), 'utf8')).marker).toBe('restored-with-more-bytes')
  })

  it('keeps saves in the order they were sent', async () => {
    const saves = ['one', 'two', 'three'].map((marker, index) =>
      handlers.save_projects({ content: document(1, marker), sequence: index, projectCount: 1 }),
    )
    await Promise.all(saves)
    expect(JSON.parse(readFileSync(projectsFile(), 'utf8')).marker).toBe('three')
  })

  it('counts the projects itself when an older caller does not say', async () => {
    writeFileSync(projectsFile(), document(3, 'kept'))
    await handlers.save_projects({ content: document(0), sequence: 1 })
    expect(JSON.parse(readFileSync(projectsFile(), 'utf8')).marker).toBe('kept')
  })
})
