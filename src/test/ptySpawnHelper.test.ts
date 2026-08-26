import { createRequire } from 'node:module'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const helper = require(join(process.cwd(), 'electron', 'pty-spawn-helper.cjs'))
const { explainHostFailure } = require(join(process.cwd(), 'electron', 'pty-host-failure.cjs'))

/**
 * Two failures that only ever show up on someone else's machine: a terminal
 * helper macOS refuses to run, and a native binary built for a Node the user
 * does not have. Both used to surface as text nobody could act on —
 * `posix_spawnp failed.` and `pty host exited` — so what these pin is the
 * message, which is the whole fix.
 */
describe('macOS spawn helper', () => {
  it('resolves the helper next to the installed node-pty', () => {
    const file = helper.spawnHelperPath()
    expect(file).toBeTruthy()
    expect(file).toContain(join('@homebridge', 'node-pty-prebuilt-multiarch'))
    expect(file?.endsWith(join('build', 'Release', 'spawn-helper'))).toBe(true)
  })

  it('reports the helper state without throwing where it does not exist', () => {
    const state = helper.inspectSpawnHelper()
    expect(typeof state.exists).toBe('boolean')
    expect(typeof state.executable).toBe('boolean')
    expect(typeof state.quarantined).toBe('boolean')
  })

  it('repairs nothing when the helper is not on disk', () => {
    expect(helper.repairSpawnHelper({ file: '/nope/spawn-helper', exists: false })).toBe(false)
  })

  it('names quarantine and the command that clears it', () => {
    const error = helper.spawnHelperError(new Error('posix_spawnp failed.'), {
      file: '/Applications/Arco.app/spawn-helper',
      exists: true,
      executable: true,
      quarantined: true,
    })
    expect(error.message).toContain('quarantine')
    expect(error.message).toContain('xattr -dr com.apple.quarantine /Applications/Arco.app')
    expect(error.message).toContain('posix_spawnp failed.')
  })

  it('says when the helper is missing rather than blaming Gatekeeper alone', () => {
    const error = helper.spawnHelperError(new Error('posix_spawnp failed.'), {
      file: '/Applications/Arco.app/spawn-helper',
      exists: false,
      executable: false,
      quarantined: false,
    })
    expect(error.message).toContain('missing')
  })
})

describe('pty host failure', () => {
  it('translates an ABI mismatch into the Node the user has to install', () => {
    const stderr = [
      'Error: The module ./pty.node',
      "was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 137. Please try re-compiling'",
    ].join('\n')
    expect(explainHostFailure(stderr)).toBe(
      'the terminal binary was built for Node 20 and this machine runs Node 24; install Node 20 and reopen Arco',
    )
  })

  it('falls back to the first line of anything else', () => {
    expect(explainHostFailure('EACCES: permission denied\nat Object.<anonymous>')).toBe(
      'EACCES: permission denied',
    )
  })
})
