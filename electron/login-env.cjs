// Environment of an interactive login shell.
//
// A desktop launch starts the app with the session's bare environment: no
// ~/.local/bin on PATH, and none of the variables the user exports from their
// rc files. Both failures are silent and look like bugs somewhere else — an
// agent CLI "not installed", an API token "expired" — because the process that
// needed the value simply never saw it.
//
// `-i` matters as much as `-l`: zsh only reads .zshrc when interactive, and
// that is where most people source their secrets. The dump is written to a file
// so anything the rc files print does not get parsed as environment.
//
// The read costs a full shell startup, so the result is cached on disk and
// refreshed once a day. A missing, slow or failing shell yields an empty
// object: every caller keeps the environment it already had.

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const CACHE_FILE = path.join(os.homedir(), '.cache', 'arco', 'login-env.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Values that describe the shell that dumped them, not the environment to inherit. */
const VOLATILE = new Set([
  '_',
  'COLUMNS',
  'LINES',
  'OLDPWD',
  'PWD',
  'SHLVL',
  'TERM',
  'ZSH_EXECUTION_STRING',
])

function readCache() {
  try {
    const stat = fs.statSync(CACHE_FILE)
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeCache(env) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(env), { mode: 0o600 })
  } catch {}
}

function dumpFromShell() {
  const shell = process.env.SHELL
  if (!shell || process.platform === 'win32') return {}
  const dump = path.join(os.tmpdir(), `arco-login-env-${process.pid}`)
  try {
    execFileSync(shell, ['-lic', `env -0 > ${JSON.stringify(dump)}`], {
      timeout: 10_000,
      stdio: 'ignore',
    })
    const env = {}
    for (const entry of fs.readFileSync(dump, 'utf8').split('\0')) {
      const split = entry.indexOf('=')
      if (split <= 0) continue
      const key = entry.slice(0, split)
      if (VOLATILE.has(key)) continue
      env[key] = entry.slice(split + 1)
    }
    return env
  } catch {
    return {}
  } finally {
    try {
      fs.unlinkSync(dump)
    } catch {}
  }
}

let cached = null

/** The login shell's environment, read at most once per process. */
function loginEnv() {
  if (cached) return cached
  cached = readCache()
  if (cached) return cached
  cached = dumpFromShell()
  if (Object.keys(cached).length > 0) writeCache(cached)
  return cached
}

/**
 * Fills in what the launch environment is missing, without overwriting anything
 * the runtime already set — Electron's own variables have to survive. PATH is
 * the exception: the two lists are merged, login shell first.
 */
function applyLoginEnv(target = process.env) {
  const env = loginEnv()
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'PATH' && target[key] === undefined) target[key] = value
  }
  target.PATH = mergePath(env.PATH, target.PATH)
  return target
}

/** Joins PATH lists in order, dropping empties and duplicates. */
function mergePath(...lists) {
  const entries = lists.flatMap((list) => (list ?? '').split(path.delimiter)).filter(Boolean)
  return [...new Set(entries)].join(path.delimiter)
}

module.exports = { loginEnv, applyLoginEnv, mergePath }
