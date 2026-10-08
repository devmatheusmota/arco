import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (args: Record<string, unknown>) => unknown

const require = createRequire(import.meta.url)

// The command modules destructure `electron` at load time; outside the app that
// require resolves to the binary path, so the stub has to be in the cache first.
const showItemInFolder = vi.fn()
const openPath = vi.fn(async () => '')
const openExternal = vi.fn(async () => {})
require.cache[require.resolve('electron')] = {
  exports: { app: {}, shell: { showItemInFolder, openPath, openExternal } },
} as unknown as NodeJS.Module

const { buildCommands } = require('../../electron/commands/index.cjs') as {
  buildCommands: (ctx: Record<string, unknown>) => Record<string, Handler>
}
const { expandHome } = require('../../electron/commands/paths.cjs') as {
  expandHome: (target: string) => string
}

const handlers = buildCommands({
  ptyHost: { request: async () => [] },
  mainWindow: null,
  send: () => {},
})

// The renderer's wrappers reach the handlers exactly as the preload hands them
// over, argument names included: a name the handler did not read is what turned
// every markdown save into an empty file.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) =>
    (await handlers[cmd]?.(args ?? {})) ?? null,
}))

import { openInFileExplorer, readTextFile, writeTextFile } from '../lib/tauri/filesystem'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(homedir(), '.arco-file-commands-'))
  vi.clearAllMocks()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tilde = (file: string) => `~/${relative(homedir(), file)}`

describe('file commands', () => {
  it('expands only a leading tilde', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/notes.md')).toBe(join(homedir(), 'notes.md'))
    expect(expandHome('/tmp/~/notes.md')).toBe('/tmp/~/notes.md')
    expect(expandHome('~other/notes.md')).toBe('~other/notes.md')
  })

  it('saves what the editor sends', async () => {
    const file = join(dir, 'note.md')
    writeFileSync(file, 'before')
    await writeTextFile(file, 'after')
    expect(readFileSync(file, 'utf8')).toBe('after')
  })

  it('refuses to create a file on save', async () => {
    await expect(writeTextFile(join(dir, 'missing.md'), 'x')).rejects.toThrow('file not found')
  })

  it('reads and writes a path the terminal printed with a tilde', async () => {
    const file = join(dir, 'note.md')
    writeFileSync(file, 'before')
    expect(await readTextFile(tilde(file))).toBe('before')
    await writeTextFile(tilde(file), 'after')
    expect(readFileSync(file, 'utf8')).toBe('after')
  })

  it('reveals a tilde path in its folder', async () => {
    const file = join(dir, 'note.md')
    writeFileSync(file, '')
    await openInFileExplorer(tilde(file))
    expect(showItemInFolder).toHaveBeenCalledWith(file)
    await openInFileExplorer(tilde(dir))
    expect(openPath).toHaveBeenCalledWith(dir)
  })

  it('reports a missing path instead of doing nothing', async () => {
    await expect(openInFileExplorer(join(tmpdir(), 'arco-nope', 'x.md'))).rejects.toThrow(
      'does not exist',
    )
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})
