// The macOS half of starting a terminal.
//
// On Linux node-pty calls `forkpty` directly, but the macOS path posix_spawns a
// small helper binary shipped next to the native module. When that binary
// cannot be executed the user is told `posix_spawnp failed.` and nothing else —
// the same message whether the file is missing, not executable, built for the
// other architecture, or held by Gatekeeper. The build is unsigned, which makes
// quarantine the likely one: every file inside a downloaded `.dmg` carries
// `com.apple.quarantine`, and an ad-hoc signed helper is refused when it runs.
//
// Everything here is a no-op off macOS.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { unpackedPath } = require('./unpacked-path.cjs')

/** Where node-pty looks for the helper, including the unpacked-asar rewrite. */
function spawnHelperPath() {
  try {
    const pkg = require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json')
    return unpackedPath(path.join(path.dirname(pkg), 'build', 'Release', 'spawn-helper'))
  } catch {
    return null
  }
}

function hasQuarantine(file) {
  try {
    execFileSync('xattr', ['-p', 'com.apple.quarantine', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Existence, permission and quarantine state of the helper, for logs and errors. */
function inspectSpawnHelper() {
  const file = spawnHelperPath()
  if (!file) return { file: null, exists: false, executable: false, quarantined: false }
  const exists = fs.existsSync(file)
  let executable = false
  if (exists) {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      executable = true
    } catch {}
  }
  return {
    file,
    exists,
    executable,
    quarantined: exists && process.platform === 'darwin' && hasQuarantine(file),
  }
}

/**
 * Puts the helper back in a runnable state, and reports whether anything moved.
 *
 * Both repairs are what the user would otherwise run by hand — `chmod +x` and
 * `xattr -d com.apple.quarantine` — and both are skipped when the file is
 * already fine, so this is safe to call before every retry.
 */
function repairSpawnHelper(state, log = () => {}) {
  if (!state.file || !state.exists) return false
  let repaired = false
  if (!state.executable) {
    try {
      fs.chmodSync(state.file, 0o755)
      repaired = true
    } catch (error) {
      log(`chmod failed on ${state.file}: ${String(error)}`)
    }
  }
  if (state.quarantined) {
    try {
      execFileSync('xattr', ['-d', 'com.apple.quarantine', state.file], { stdio: 'ignore' })
      repaired = true
    } catch (error) {
      log(`could not clear quarantine on ${state.file}: ${String(error)}`)
    }
  }
  return repaired
}

/** `posix_spawnp failed.`, rewritten into something the user can act on. */
function spawnHelperError(original, state = inspectSpawnHelper()) {
  const reason = !state.file
    ? 'the node-pty helper could not be located'
    : !state.exists
      ? `the terminal helper is missing (${state.file})`
      : !state.executable
        ? `the terminal helper is not executable (${state.file})`
        : state.quarantined
          ? `macOS is holding the terminal helper in quarantine (${state.file})`
          : // The helper is on disk, runnable and not quarantined, so the refusal
            // came from the system: a signature Gatekeeper rejects, or no free
            // pty left to allocate.
            `macOS refused to start the terminal helper (${state.file})`
  return new Error(
    `${reason}. On an unsigned build this is usually Gatekeeper: run ` +
      '`xattr -dr com.apple.quarantine /Applications/Arco.app` and reopen Arco. ' +
      `Original error: ${String(original)}`,
  )
}

/** Clears what can be cleared before the first terminal, and records the rest. */
function prepareSpawnHelper(log = () => {}) {
  if (process.platform !== 'darwin') return
  const state = inspectSpawnHelper()
  if (!state.file) {
    log('node-pty helper path could not be resolved')
    return
  }
  log(
    `path=${state.file} exists=${state.exists} executable=${state.executable} quarantined=${state.quarantined}`,
  )
  if (state.exists && (!state.executable || state.quarantined) && repairSpawnHelper(state, log)) {
    const after = inspectSpawnHelper()
    log(`repaired: executable=${after.executable} quarantined=${after.quarantined}`)
  }
}

module.exports = {
  spawnHelperPath,
  inspectSpawnHelper,
  repairSpawnHelper,
  spawnHelperError,
  prepareSpawnHelper,
}
