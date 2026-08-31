import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { APPIMAGE_OWN_VARS, INHERITED_SESSION_VARS, clearInheritedAgentSession, stripAppImageEnv } =
  require('../../electron/pty-env.cjs') as {
    APPIMAGE_OWN_VARS: string[]
    INHERITED_SESSION_VARS: string[]
    clearInheritedAgentSession: (env: Record<string, string>) => Record<string, string>
    stripAppImageEnv: (env: Record<string, string>) => Record<string, string>
  }

// The environment a pane inherits when the app itself was started from an agent
// pane: parentage markers next to the variables that only say where the CLI is.
const POISONED = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: '52775642-80d4-4939-afe9-4e399fe0ee18',
  CLAUDE_CODE_MESSAGING_SOCKET: '/run/user/1000/cc-socks/56555.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'b6a4244f356b530d2f88356a56651f16',
  CODEX_COMPANION_SESSION_ID: '52775642-80d4-4939-afe9-4e399fe0ee18',
  CLAUDE_CODE_EXECPATH: '/home/user/.local/share/claude/versions/2.1.251',
  CLAUDE_PLUGIN_DATA: '/home/user/.claude/plugins/data/codex-openai-codex',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDECODE: '1',
  PATH: '/usr/bin',
}

describe('clearInheritedAgentSession', () => {
  it('drops every marker that makes a pane look like a child session', () => {
    const cleaned = clearInheritedAgentSession(POISONED)
    for (const key of INHERITED_SESSION_VARS) expect(cleaned).not.toHaveProperty(key)
  })

  it('keeps the variables that describe the install, not the parent session', () => {
    const cleaned = clearInheritedAgentSession(POISONED)
    expect(cleaned.CLAUDE_CODE_EXECPATH).toBe(POISONED.CLAUDE_CODE_EXECPATH)
    expect(cleaned.CLAUDE_PLUGIN_DATA).toBe(POISONED.CLAUDE_PLUGIN_DATA)
    expect(cleaned.CLAUDE_CODE_ENTRYPOINT).toBe('cli')
    expect(cleaned.CLAUDECODE).toBe('1')
    expect(cleaned.PATH).toBe('/usr/bin')
  })

  it('leaves the caller environment untouched', () => {
    const source = { ...POISONED }
    clearInheritedAgentSession(source)
    expect(source.CLAUDE_CODE_CHILD_SESSION).toBe('1')
  })

  it('accepts an environment that carries no markers', () => {
    expect(clearInheritedAgentSession({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})

// What `AppRun` exports before handing control to the bundled app: its own
// bookkeeping, a PATH the mount prepends itself to, and runtime variables that
// exist only inside the mount.
const APPDIR = '/tmp/.mount_Arco1a2b3c'
const APPIMAGE_ENV = {
  APPDIR,
  APPIMAGE: '/home/user/Apps/Arco-2.13.3.AppImage',
  APPIMAGE_UUID: '1a2b3c',
  ARGV0: 'Arco-2.13.3.AppImage',
  OWD: '/home/user',
  PATH: `${APPDIR}/usr/bin:/usr/bin:/bin`,
  PATH_ORIG: '/usr/bin:/bin',
  PYTHONHOME: `${APPDIR}/usr`,
  LD_LIBRARY_PATH: `${APPDIR}/usr/lib:${APPDIR}/usr/lib/x86_64-linux-gnu`,
  HOME: '/home/user',
}

describe('stripAppImageEnv', () => {
  it('drops a variable that only ever pointed into the mount', () => {
    const cleaned = stripAppImageEnv(APPIMAGE_ENV)
    // `PYTHONHOME` surviving is what breaks every `python3` a pane runs.
    expect(cleaned).not.toHaveProperty('PYTHONHOME')
    expect(cleaned).not.toHaveProperty('LD_LIBRARY_PATH')
  })

  it('prefers the value AppRun stashed before the launch', () => {
    const cleaned = stripAppImageEnv(APPIMAGE_ENV)
    expect(cleaned.PATH).toBe('/usr/bin:/bin')
    expect(cleaned).not.toHaveProperty('PATH_ORIG')
  })

  it('keeps the entries of a path list that live outside the mount', () => {
    const cleaned = stripAppImageEnv({ ...APPIMAGE_ENV, PATH_ORIG: undefined as never })
    expect(cleaned.PATH).toBe('/usr/bin:/bin')
  })

  it("drops the AppImage's own bookkeeping", () => {
    const cleaned = stripAppImageEnv(APPIMAGE_ENV)
    for (const key of APPIMAGE_OWN_VARS) expect(cleaned).not.toHaveProperty(key)
  })

  it('leaves variables that never mention the mount alone', () => {
    expect(stripAppImageEnv(APPIMAGE_ENV).HOME).toBe('/home/user')
  })

  it('is a no-op outside an AppImage', () => {
    const plain = { PATH: '/usr/bin', PYTHONHOME: '/usr' }
    expect(stripAppImageEnv(plain)).toEqual(plain)
  })

  it('leaves the caller environment untouched', () => {
    const source = { ...APPIMAGE_ENV }
    stripAppImageEnv(source)
    expect(source.PYTHONHOME).toBe(`${APPDIR}/usr`)
  })
})

describe('loginEnv cache', () => {
  const realHome = process.env.HOME

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    vi.resetModules()
  })

  it('strips markers a cache written before the fix still holds', () => {
    // `os.homedir()` reads HOME on POSIX, so pointing it at a temp tree puts the
    // cache the module reads under this test's control.
    const home = mkdtempSync(join(tmpdir(), 'arco-login-env-'))
    mkdirSync(join(home, '.cache', 'arco'), { recursive: true })
    writeFileSync(join(home, '.cache', 'arco', 'login-env.json'), JSON.stringify(POISONED))
    process.env.HOME = home

    vi.resetModules()
    const { loginEnv } = require('../../electron/login-env.cjs') as {
      loginEnv: () => Record<string, string>
    }
    const env = loginEnv()

    expect(env.CLAUDE_CODE_EXECPATH).toBe(POISONED.CLAUDE_CODE_EXECPATH)
    for (const key of INHERITED_SESSION_VARS) expect(env).not.toHaveProperty(key)
  })
})
