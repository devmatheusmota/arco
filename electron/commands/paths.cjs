// Where app data lives. Kept byte-compatible with the Tauri build so both
// shells read the same profiles, projects and scrollback.

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const IDENTIFIER = 'com.mota.arco'

function appLocalDataDir() {
  const base =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), '.local', 'share')
  return path.join(base, IDENTIFIER)
}

function profilesRegistryPath() {
  return path.join(appLocalDataDir(), 'profiles.json')
}

function profileDir(profileId) {
  return path.join(appLocalDataDir(), 'profiles', profileId)
}

function logsDir() {
  return path.join(appLocalDataDir(), 'logs')
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * A line in one of the app's log files.
 *
 * It lives here rather than in the command router because commands need it too:
 * a failure explained only through a toast is a failure nobody can debug after
 * the toast is gone.
 */
function appendLog(file, line) {
  try {
    ensureDir(logsDir())
    fs.appendFileSync(path.join(logsDir(), file), `[${Date.now() / 1000}] ${line}\n`)
  } catch {}
}

/** Atomic write, same tmp-then-rename the Rust side uses. */
function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

module.exports = {
  IDENTIFIER,
  appLocalDataDir,
  profilesRegistryPath,
  profileDir,
  logsDir,
  ensureDir,
  appendLog,
  readJson,
  writeJson,
}
