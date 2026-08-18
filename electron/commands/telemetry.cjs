// Transcript cost, the telemetry ring buffer, GitHub gist sync and the Codex
// app server bridge.

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const paths = require('./paths.cjs')

const GITHUB_STATE = () => path.join(paths.appLocalDataDir(), 'github-sync.json')
const GIST_FILE = 'arco-projects.json'
const TRACE_LIMIT = 2_000

// ── token pricing ───────────────────────────────────────────────────────────

/** Dollars per million tokens, derived from the model family as Rust does. */
function pricingFor(model) {
  const name = (model ?? '').toLowerCase()
  const base = name.includes('opus')
    ? [5, 25]
    : name.includes('sonnet')
      ? [3, 15]
      : name.includes('haiku')
        ? [1, 5]
        : null
  if (!base) return null
  const [input, output] = base
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
  }
}

function emptyModelCost(model) {
  return {
    model,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cost_usd: null,
  }
}

function computeCost(entry) {
  const pricing = pricingFor(entry.model)
  if (!pricing) return
  entry.cost_usd =
    (entry.input / 1e6) * pricing.input +
    (entry.output / 1e6) * pricing.output +
    (entry.cache_read / 1e6) * pricing.cacheRead +
    (entry.cache_write_5m / 1e6) * pricing.cacheWrite5m +
    (entry.cache_write_1h / 1e6) * pricing.cacheWrite1h
}

function parseClaudeCost(file) {
  const byModel = new Map()
  let contents = ''
  try {
    contents = fs.readFileSync(file, 'utf8')
  } catch {
    return byModel
  }
  for (const line of contents.split('\n')) {
    if (!line) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const usage = value?.message?.usage
    if (!usage) continue
    const model = value.message.model ?? 'unknown'
    if (!byModel.has(model)) byModel.set(model, emptyModelCost(model))
    const entry = byModel.get(model)
    const count = (key) => (typeof usage[key] === 'number' ? usage[key] : 0)
    entry.input += count('input_tokens')
    entry.output += count('output_tokens')
    entry.cache_read += count('cache_read_input_tokens')
    // The 5m/1h split arrives under cache_creation; without it the whole
    // creation total counts as 5m.
    const creation = usage.cache_creation
    const ephemeral5m = creation?.ephemeral_5m_input_tokens
    const ephemeral1h = creation?.ephemeral_1h_input_tokens
    if (typeof ephemeral5m === 'number' && typeof ephemeral1h === 'number') {
      entry.cache_write_5m += ephemeral5m
      entry.cache_write_1h += ephemeral1h
    } else {
      entry.cache_write_5m += count('cache_creation_input_tokens')
    }
  }
  return byModel
}

function aggregate(agent, sessionId, byModel) {
  for (const entry of byModel) computeCost(entry)
  const total = {
    session_id: sessionId,
    agent,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    total_tokens: 0,
    cost_usd: null,
    model: null,
    by_model: byModel,
  }
  let dominant = null
  for (const entry of byModel) {
    total.input += entry.input
    total.output += entry.output
    total.cache_read += entry.cache_read
    total.cache_write_5m += entry.cache_write_5m
    total.cache_write_1h += entry.cache_write_1h
    if (entry.cost_usd !== null) total.cost_usd = (total.cost_usd ?? 0) + entry.cost_usd
    if (!dominant || entry.output > dominant.output) dominant = entry
  }
  total.total_tokens =
    total.input + total.output + total.cache_read + total.cache_write_5m + total.cache_write_1h
  total.model = dominant?.model ?? null
  return total
}

// ── telemetry ───────────────────────────────────────────────────────────────

/**
 * The last events this process published, in order. The Rust build keeps the
 * same buffer in its event bus; both exist so a trace can be pulled by
 * correlation id after the fact.
 */
const traces = []

function publishEvent(eventType, correlationId, agentId, taskId, data) {
  traces.push({
    event_type: eventType,
    timestamp_ms: Date.now(),
    correlation_id: correlationId,
    task_id: taskId ?? null,
    agent_id: agentId ?? null,
    data: data ?? {},
  })
  if (traces.length > TRACE_LIMIT) traces.splice(0, traces.length - TRACE_LIMIT)
}

// ── GitHub sync ─────────────────────────────────────────────────────────────

function githubState() {
  return paths.readJson(GITHUB_STATE(), {
    token: null,
    login: null,
    gist_id: null,
    gist_url: null,
    last_push_ms: null,
    last_pull_ms: null,
  })
}

function githubStatus(state) {
  return {
    connected: Boolean(state.token && state.login),
    login: state.login,
    gist_id: state.gist_id,
    gist_url: state.gist_url,
    last_push_ms: state.last_push_ms,
    last_pull_ms: state.last_pull_ms,
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

function activeProjectsFile() {
  const registry = paths.readJson(paths.profilesRegistryPath(), { active_profile_id: 'default' })
  return path.join(paths.profileDir(registry.active_profile_id ?? 'default'), 'projects.json')
}

// ── Codex app server ────────────────────────────────────────────────────────
//
// `codex app-server` speaks JSON-RPC over stdio. One process per id; replies and
// notifications are forwarded to the window as they arrive.

const codexServers = new Map()

function buildTelemetryCommands({ send }) {
  return {
    get_transcript_cost: ({ path: file }) => {
      if (!file || !fs.existsSync(file)) throw new Error(`transcript not found: ${file}`)
      return aggregate('claude', file, [...parseClaudeCost(file).values()])
    },

    get_telemetry_traces: ({ correlationId }) =>
      correlationId ? traces.filter((event) => event.correlation_id === correlationId) : [...traces],

    github_sync_push: async () => {
      const state = githubState()
      if (!state.token) throw new Error('GitHub is not connected')
      let contents = '{}'
      try {
        contents = fs.readFileSync(activeProjectsFile(), 'utf8')
      } catch {}
      const files = { [GIST_FILE]: { content: contents } }
      const result = state.gist_id
        ? await gist(state, 'PATCH', `/gists/${state.gist_id}`, { files })
        : await gist(state, 'POST', '/gists', {
            description: 'Arco workspace sync',
            public: false,
            files,
          })
      const updated = {
        ...state,
        gist_id: result.id,
        gist_url: result.html_url,
        last_push_ms: Date.now(),
      }
      paths.writeJson(GITHUB_STATE(), updated)
      publishEvent('GithubSyncPushed', `gh-${result.id}`, null, null, { bytes: contents.length })
      return githubStatus(updated)
    },
    github_sync_pull: async () => {
      const state = githubState()
      if (!state.token) throw new Error('GitHub is not connected')
      if (!state.gist_id) throw new Error('nothing has been pushed yet')
      const result = await gist(state, 'GET', `/gists/${state.gist_id}`)
      const content = result.files?.[GIST_FILE]?.content
      if (typeof content !== 'string') throw new Error('the gist has no Arco payload')
      // Through a temporary file: a torn write here would cost the workspace.
      const target = activeProjectsFile()
      paths.ensureDir(path.dirname(target))
      const temporary = `${target}.tmp`
      fs.writeFileSync(temporary, content)
      fs.renameSync(temporary, target)
      const updated = { ...state, last_pull_ms: Date.now() }
      paths.writeJson(GITHUB_STATE(), updated)
      return githubStatus(updated)
    },

    codex_app_server_start: ({ id, cwd }) => {
      if (codexServers.has(id)) return null
      const child = spawn('codex', ['app-server'], {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      codexServers.set(id, child)
      const lines = readline.createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        if (!line.trim()) return
        try {
          send(`codex-app-server://message/${id}`, JSON.parse(line))
        } catch {}
      })
      child.stderr.on('data', (chunk) => {
        send(`codex-app-server://stderr/${id}`, chunk.toString())
      })
      child.on('error', (error) => {
        send(`codex-app-server://exit/${id}`, { code: null, error: String(error.message) })
        codexServers.delete(id)
      })
      child.on('exit', (code) => {
        send(`codex-app-server://exit/${id}`, { code, error: null })
        codexServers.delete(id)
      })
      return null
    },
    codex_app_server_send: ({ id, request }) => {
      const child = codexServers.get(id)
      if (!child) throw new Error('codex app server is not running')
      child.stdin.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
      return null
    },
    codex_app_server_stop: ({ id }) => {
      const child = codexServers.get(id)
      if (!child) return null
      child.kill()
      codexServers.delete(id)
      return null
    },

    // The Ghostty surface is a native widget the Tauri build embeds; this shell
    // renders terminals with xterm.js, so there is no surface to focus and none
    // that can exit on its own.
    ghostty_set_focus: () => null,
    ghostty_surface_exited: () => false,

    // Spotify and the Discord presence are deliberately not part of this build.
    // The UI still calls them on startup, so they answer "not connected" rather
    // than failing and raising a toast.
    spotify_login: () => {
      throw new Error('Spotify is not available in this build')
    },
    spotify_logout: () => null,
    clear_discord_presence: () => null,
  }
}

module.exports = { buildTelemetryCommands, publishEvent }
