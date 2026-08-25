// GitHub gist sync: the state file, the two transfers, and the timer that keeps
// the gist current without anyone pressing Upload.
//
// The state lives in `github-sync.json`, next to the profiles and outside
// `projects.json` on purpose: the schedule is a property of this machine, and
// storing it in the file being synced would let one machine's interval travel to
// every other one on the next pull.

const nodeCrypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const paths = require('./paths.cjs')

const GIST_FILE = 'arco-projects.json'
const STATE_FILE = () => path.join(paths.appLocalDataDir(), 'github-sync.json')

const DEFAULT_MINUTES = 15
const MIN_MINUTES = 5
const MAX_MINUTES = 720
/** Consecutive failures that park the timer until a manual push or a restart. */
const FAILURE_LIMIT = 3

const EMPTY = {
  token: null,
  login: null,
  gist_id: null,
  gist_url: null,
  last_push_ms: null,
  last_pull_ms: null,
  last_push_hash: null,
  auto_push: true,
  auto_push_minutes: DEFAULT_MINUTES,
}

function readState() {
  return { ...EMPTY, ...paths.readJson(STATE_FILE(), EMPTY) }
}

function writeState(state) {
  paths.writeJson(STATE_FILE(), state)
  return state
}

function clampMinutes(value) {
  const minutes = Math.round(Number(value))
  if (!Number.isFinite(minutes)) return DEFAULT_MINUTES
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes))
}

/** What the frontend reads. The token never leaves this process. */
function status(state = readState()) {
  return {
    connected: Boolean(state.token && state.login),
    login: state.login,
    gist_id: state.gist_id,
    gist_url: state.gist_url,
    last_push_ms: state.last_push_ms,
    last_pull_ms: state.last_pull_ms,
    auto_push: Boolean(state.auto_push),
    auto_push_minutes: clampMinutes(state.auto_push_minutes),
    auto_push_error: autoPushError,
  }
}

async function gist(state, method, endpoint, body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'arco',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
  return response.json()
}

async function githubUser(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'arco' },
  })
  if (!response.ok) throw new Error('invalid_token')
  const user = await response.json()
  return user.login
}

function activeProjectsFile() {
  const registry = paths.readJson(paths.profilesRegistryPath(), { active_profile_id: 'default' })
  return path.join(paths.profileDir(registry.active_profile_id ?? 'default'), 'projects.json')
}

function readProjects() {
  try {
    return fs.readFileSync(activeProjectsFile(), 'utf8')
  } catch {
    return '{}'
  }
}

function hash(contents) {
  return nodeCrypto.createHash('sha256').update(contents).digest('hex')
}

// A push and a pull rewrite the same two things — the gist and the local file —
// so letting them overlap is how the workspace ends up half of each.
let inFlight = false

async function push({ publishEvent } = {}) {
  const state = readState()
  if (!state.token) throw new Error('not_connected')
  if (inFlight) throw new Error('sync_in_progress')
  inFlight = true
  try {
    const contents = readProjects()
    const files = { [GIST_FILE]: { content: contents } }
    const result = state.gist_id
      ? await gist(state, 'PATCH', `/gists/${state.gist_id}`, { files })
      : await gist(state, 'POST', '/gists', {
          description: 'Arco workspace sync',
          public: false,
          files,
        })
    const updated = writeState({
      ...state,
      gist_id: result.id,
      gist_url: result.html_url,
      last_push_ms: Date.now(),
      last_push_hash: hash(contents),
    })
    publishEvent?.('GithubSyncPushed', `gh-${result.id}`, null, null, { bytes: contents.length })
    return status(updated)
  } finally {
    inFlight = false
  }
}

async function pull() {
  const state = readState()
  if (!state.token) throw new Error('not_connected')
  if (!state.gist_id) throw new Error('no_remote')
  if (inFlight) throw new Error('sync_in_progress')
  inFlight = true
  try {
    const result = await gist(state, 'GET', `/gists/${state.gist_id}`)
    const content = result.files?.[GIST_FILE]?.content
    if (typeof content !== 'string') throw new Error('remote_missing_projects')
    // Through a temporary file: a torn write here would cost the workspace.
    const target = activeProjectsFile()
    paths.ensureDir(path.dirname(target))
    const temporary = `${target}.tmp`
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, target)
    // The pulled file is now what the gist holds, so the next tick has nothing
    // to send. Without this the timer would push the copy straight back.
    return status(writeState({ ...state, last_pull_ms: Date.now(), last_push_hash: hash(content) }))
  } finally {
    inFlight = false
  }
}

// ── the timer ───────────────────────────────────────────────────────────────

let timer = null
let failures = 0
let autoPushError = null
let publish = null

/**
 * One tick. Sends nothing when the workspace has not changed since the last
 * push: the gist keeps a revision per write, and a fleet of identical revisions
 * buys nothing and burns the token's rate limit.
 */
async function tick() {
  const state = readState()
  if (!state.auto_push || !state.token || !state.login) return
  if (inFlight) return
  if (hash(readProjects()) === state.last_push_hash) return
  try {
    await push({ publishEvent: publish })
    failures = 0
    autoPushError = null
  } catch (error) {
    failures += 1
    autoPushError = String(error?.message ?? error)
    // Retrying a broken token every quarter of an hour for a week is how a
    // revoked credential turns into a rate-limit ban. Park and say so.
    if (failures >= FAILURE_LIMIT) stopAutoSync()
  }
}

function scheduleAutoSync() {
  stopAutoSync()
  const state = readState()
  if (!state.auto_push || !state.token || !state.login) return
  timer = setInterval(() => void tick(), clampMinutes(state.auto_push_minutes) * 60_000)
  timer.unref?.()
}

function startAutoSync({ publishEvent } = {}) {
  publish = publishEvent ?? null
  failures = 0
  autoPushError = null
  scheduleAutoSync()
}

function stopAutoSync() {
  if (timer) clearInterval(timer)
  timer = null
}

/** Turns the schedule on or off, or changes its interval. Applies immediately. */
function setAuto({ enabled, minutes }) {
  const state = readState()
  const updated = writeState({
    ...state,
    auto_push: enabled === undefined ? state.auto_push : Boolean(enabled),
    auto_push_minutes: minutes === undefined ? state.auto_push_minutes : clampMinutes(minutes),
  })
  failures = 0
  autoPushError = null
  scheduleAutoSync()
  return status(updated)
}

function setToken(token, login) {
  const updated = writeState({ ...readState(), token, login })
  // A fresh token deserves a running timer without waiting for a restart.
  startAutoSync({ publishEvent: publish })
  return status(updated)
}

function logout() {
  stopAutoSync()
  failures = 0
  autoPushError = null
  return status(writeState({ ...EMPTY }))
}

module.exports = {
  GIST_FILE,
  activeProjectsFile,
  githubUser,
  logout,
  pull,
  push,
  readState,
  scheduleAutoSync,
  setAuto,
  setToken,
  startAutoSync,
  status,
  stopAutoSync,
}
