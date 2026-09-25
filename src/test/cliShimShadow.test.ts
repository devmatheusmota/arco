import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const MODULE = '../../electron/commands/platform.cjs'

type ShimStatus = { shadowed_by: string | null }

let root: string
let binDir: string
const saved = { HOME: process.env.HOME, PATH: process.env.PATH }

/** The shim directory is resolved from HOME when the module loads, so load it fresh. */
function shimStatus(): ShimStatus {
  delete require.cache[require.resolve(MODULE)]
  const { buildPlatformCommands } = require(MODULE) as {
    buildPlatformCommands: () => { cli_shim_status: () => ShimStatus }
  }
  return buildPlatformCommands().cli_shim_status()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arco-shim-shadow-'))
  binDir = join(root, 'usr-bin')
  mkdirSync(binDir)
  mkdirSync(join(root, 'home', '.local', 'bin'), { recursive: true })
  process.env.HOME = join(root, 'home')
  process.env.PATH = [binDir, join(root, 'home', '.local', 'bin')].join(':')
})

afterEach(() => {
  process.env.HOME = saved.HOME
  process.env.PATH = saved.PATH
  delete require.cache[require.resolve(MODULE)]
  rmSync(root, { recursive: true, force: true })
})

describe('cli shim shadowing', () => {
  it('does not flag the link a package makes to this very app', () => {
    // What the .deb installs: /usr/bin/arco -> /etc/alternatives/arco -> the app.
    const alternatives = join(root, 'alternatives-arco')
    symlinkSync(process.execPath, alternatives)
    symlinkSync(alternatives, join(binDir, 'arco'))

    expect(shimStatus().shadowed_by).toBeNull()
  })

  it('flags an arco earlier on PATH that is a different binary', () => {
    symlinkSync('/bin/sh', join(binDir, 'arco'))

    expect(shimStatus().shadowed_by).toBe(join(binDir, 'arco'))
  })
})
