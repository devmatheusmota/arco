// Usage, cost and activity.
//
// Claude's quota comes from the OAuth usage endpoint with the token Claude Code
// already stored; Codex's comes from its own `app-server` over stdio. Cost is
// summed from the transcripts on disk. Same sources the Rust backend reads, so
// both shells report the same numbers.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const paths = require('./paths.cjs')

function claudeToken() {
  if (process.env.CLAUDE_OAUTH_TOKEN) return process.env.CLAUDE_OAUTH_TOKEN
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const token = parsed?.claudeAiOauth?.accessToken
    return token || null
  } catch {
    return null
  }
}

function usageWindow(source) {
  if (!source || typeof source !== 'object') return { utilization: 0, resets_at: '' }
  return {
    utilization: Number(source.utilization ?? 0),
    resets_at: typeof source.resets_at === 'string' ? source.resets_at : '',
  }
}

async function claudeUsage() {
  const token = claudeToken()
  if (!token) throw new Error('no_token')
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (!response.ok) throw new Error(`API returned ${response.status}`)
  const body = await response.json()
  return {
    five_hour: usageWindow(body.five_hour),
    seven_day: usageWindow(body.seven_day),
    seven_day_opus: usageWindow(body.seven_day_opus),
  }
}

/**
 * One quota window as the widget reads it.
 *
 * `account/rateLimits/read` answers in camelCase and dates a window in epoch
 * seconds; the snake_case names are what older Codex builds replied with, and
 * reading both keeps a machine that has not updated its CLI reporting numbers
 * instead of a flat zero.
 */
function codexWindow(source) {
  const resetsAt = Number(source?.resetsAt ?? 0)
  return {
    used_percent: Number(source?.usedPercent ?? source?.used_percent ?? 0),
    window_minutes: Number(source?.windowDurationMins ?? source?.window_minutes ?? 0),
    resets_at_ms: resetsAt > 0 ? resetsAt * 1000 : Number(source?.resets_at_ms ?? 0),
  }
}

/** Quota, plan and reset credits out of one `account/rateLimits/read` result. */
function codexLimits(result) {
  const limits = result?.rateLimits ?? result ?? {}
  const credits = result?.rateLimitResetCredits
  return {
    primary: codexWindow(limits.primary),
    secondary: codexWindow(limits.secondary),
    plan: String(limits.planType ?? limits.plan ?? ''),
    rate_limited: Boolean(
      limits.rateLimitReachedType ?? limits.spendControlReached ?? limits.rate_limited ?? false,
    ),
    reset_credits: Number(credits?.availableCount ?? result?.reset_credits ?? 0),
  }
}

/** Drives `codex app-server` over stdio, which is how Codex reports its limits. */
function codexUsage() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    })
    let buffer = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('codex timed out')), 8000)

    child.on('error', () => finish(new Error('codex_not_found')))
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id !== 2) continue
        clearTimeout(timer)
        finish(null, codexLimits(message.result))
      }
    })

    child.stdin.write(
      `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'arco', version: '1.5.3' } } })}\n` +
        `${JSON.stringify({ method: 'initialized' })}\n` +
        `${JSON.stringify({ id: 2, method: 'account/rateLimits/read' })}\n`,
    )
  })
}

// ── cost, read from the transcripts ───────────────────────────────────────

function claudeProjectDirs() {
  const root = path.join(os.homedir(), '.claude', 'projects')
  try {
    return fs.readdirSync(root).map((name) => path.join(root, name))
  } catch {
    return []
  }
}

function emptyTotals() {
  return { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }
}

function addUsage(totals, usage) {
  if (!usage) return
  totals.input += usage.input_tokens ?? 0
  totals.output += usage.output_tokens ?? 0
  totals.cache_read += usage.cache_read_input_tokens ?? 0
  totals.cache_write_5m += usage.cache_creation_input_tokens ?? 0
}

function sessionCost(file) {
  const totals = emptyTotals()
  const byModel = new Map()
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return { totals, byModel }
  }
  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const usage = entry?.message?.usage
    if (!usage) continue
    addUsage(totals, usage)
    const model = entry?.message?.model ?? 'unknown'
    if (!byModel.has(model)) byModel.set(model, emptyTotals())
    addUsage(byModel.get(model), usage)
  }
  return { totals, byModel }
}

function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function claudeActivity(days) {
  const cutoff = Date.now() - (days ?? 30) * 24 * 60 * 60 * 1000
  const perDay = new Map()
  for (const dir of claudeProjectDirs()) {
    let names
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(dir, name)
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        continue
      }
      if (stats.mtimeMs < cutoff) continue
      const key = dayKey(stats.mtimeMs)
      const day = perDay.get(key) ?? { date: key, sessions: 0, tokens: 0 }
      const { totals } = sessionCost(file)
      day.sessions += 1
      day.tokens += totals.input + totals.output
      perDay.set(key, day)
    }
  }
  return [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date))
}

// ── activity samples, persisted like the Rust side does ───────────────────

function activityFile() {
  const registry = paths.readJson(paths.profilesRegistryPath(), null)
  const profileId = registry?.active_profile_id ?? 'default'
  return path.join(paths.profileDir(profileId), 'activity-stats.json')
}

const MODELS_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'

/** Dollars per million tokens per model family — the same table Rust derives. */
const PRICING = [
  { family: 'opus', input: 5, output: 25 },
  { family: 'sonnet', input: 3, output: 15 },
  { family: 'haiku', input: 1, output: 5 },
]

function which(binary) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, binary)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function emptyAntigravity(status, cliPath) {
  return { status, cli_path: cliPath, used_percent: 0, rate_limited: false, buckets: [] }
}

/**
 * The `agy` OAuth envelope, stored by the platform secret store — `gemini` /
 * `antigravity` on Linux and macOS. Only the access token is read, never kept.
 */
function antigravityToken() {
  const attempts = [
    ['secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity']],
    ['secret-tool', ['lookup', 'target', 'gemini:antigravity']],
  ]
  for (const [binary, args] of attempts) {
    if (!which(binary)) continue
    try {
      const out = require('node:child_process').execFileSync(binary, args, {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const parsed = JSON.parse(out)
      const token = parsed?.token?.access_token ?? parsed?.access_token
      if (typeof token === 'string' && token) return token
    } catch {}
  }
  return null
}

function bucketLabel(models) {
  const every = (needle) => models.every((model) => model.toLowerCase().includes(needle))
  if (every('gemini')) return 'Gemini'
  if (every('claude')) return 'Claude'
  if (every('gpt')) return 'GPT'
  return models[0] ?? 'Other'
}

/** Groups models that share a quota (same remaining fraction and reset). */
function parseAntigravityUsage(body, cliPath) {
  const models = body?.models
  if (!models || typeof models !== 'object') throw new Error('models_missing')
  const grouped = new Map()
  for (const [id, model] of Object.entries(models)) {
    const remaining = model?.quotaInfo?.remainingFraction
    if (typeof remaining !== 'number') continue
    const name = (model.displayName || id).trim()
    const reset = model.quotaInfo.resetTime ?? ''
    const key = `${Math.round(Math.min(1, Math.max(0, remaining)) * 1e6)}|${reset}`
    if (!grouped.has(key)) grouped.set(key, { reset, models: new Set() })
    grouped.get(key).models.add(name)
  }
  const buckets = [...grouped.entries()]
    .map(([key, entry]) => {
      const remainingPercent = Number(key.split('|')[0]) / 10_000
      const names = [...entry.models].sort()
      return {
        label: bucketLabel(names),
        models: names,
        used_percent: Math.min(100, Math.max(0, 100 - remainingPercent)),
        remaining_percent: remainingPercent,
        resets_at: entry.reset,
      }
    })
    .sort((a, b) => b.used_percent - a.used_percent)
  return {
    status: 'ready',
    cli_path: cliPath,
    used_percent: buckets[0]?.used_percent ?? 0,
    rate_limited: buckets.some((bucket) => bucket.remaining_percent <= 0),
    buckets,
  }
}

/** OpenCode keeps its sessions in a SQLite database next to its own data. */
function opencodeDatabase() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode', 'opencode.db')
}

function buildUsageCommands() {
  return {
    get_claude_usage: () => claudeUsage(),
    get_codex_usage: () => codexUsage(),
    get_antigravity_usage: async () => {
      const cli = which('agy')
      if (!cli) return emptyAntigravity('no_cli', '')
      const token = antigravityToken()
      if (!token) return emptyAntigravity('no_auth', cli)
      let response
      try {
        response = await fetch(MODELS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'arco antigravity-usage',
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        })
      } catch {
        return emptyAntigravity('unavailable', cli)
      }
      if (response.status === 401 || response.status === 403) {
        return emptyAntigravity('no_auth', cli)
      }
      if (!response.ok) return emptyAntigravity('unavailable', cli)
      try {
        return parseAntigravityUsage(await response.json(), cli)
      } catch {
        return emptyAntigravity('unavailable', cli)
      }
    },
    get_model_pricing: () =>
      PRICING.map(({ family, input, output }) => ({
        family,
        input,
        output,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2,
        cache_read: input * 0.1,
      })),
    get_opencode_usage_summary: ({ hours }) => {
      const file = opencodeDatabase()
      const empty = {
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        session_count: 0,
        by_model: [],
      }
      if (!fs.existsSync(file)) return empty
      let database
      try {
        // Read-only: OpenCode may be writing to this database right now.
        const { DatabaseSync } = require('node:sqlite')
        database = new DatabaseSync(file, { readOnly: true })
      } catch {
        return empty
      }
      try {
        const since = Date.now() - (hours ?? 24) * 3_600_000
        const summary = { ...empty, by_model: [] }
        const byModel = new Map()
        const bucket = (model) => {
          if (!byModel.has(model)) {
            byModel.set(model, {
              model,
              input: 0,
              output: 0,
              cache_read: 0,
              cache_write_5m: 0,
              cache_write_1h: 0,
              cost_usd: 0,
            })
          }
          return byModel.get(model)
        }
        const columns = database
          .prepare('PRAGMA table_info(session)')
          .all()
          .map((column) => column.name)

        if (columns.includes('tokens_input')) {
          // Older schema: one row per session carries its own totals.
          for (const row of database
            .prepare(
              'SELECT model, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write ' +
                'FROM session WHERE time_updated >= ?',
            )
            .all(since)) {
            const entry = bucket(row.model || 'unknown')
            entry.input += Number(row.tokens_input ?? 0)
            entry.output += Number(row.tokens_output ?? 0)
            entry.cache_read += Number(row.tokens_cache_read ?? 0)
            entry.cache_write_5m += Number(row.tokens_cache_write ?? 0)
            entry.cost_usd += Number(row.cost ?? 0)
            summary.session_count += 1
          }
        } else {
          // Current schema: usage lives in each assistant message's JSON blob.
          const sessions = new Set()
          for (const row of database
            .prepare('SELECT session_id, data FROM message WHERE time_updated >= ?')
            .all(since)) {
            let message
            try {
              message = JSON.parse(row.data)
            } catch {
              continue
            }
            const tokens = message?.tokens
            if (!tokens) continue
            const entry = bucket(message.modelID || message.model || 'unknown')
            entry.input += Number(tokens.input ?? 0)
            entry.output += Number(tokens.output ?? 0)
            entry.cache_read += Number(tokens.cache?.read ?? 0)
            entry.cache_write_5m += Number(tokens.cache?.write ?? 0)
            entry.cost_usd += Number(message.cost ?? 0)
            sessions.add(row.session_id)
          }
          summary.session_count = sessions.size
        }

        for (const entry of byModel.values()) {
          summary.input_tokens += entry.input
          summary.output_tokens += entry.output
          summary.cost_usd += entry.cost_usd
        }
        summary.by_model = [...byModel.values()]
        return summary
      } catch {
        return empty
      } finally {
        try {
          database.close()
        } catch {}
      }
    },
    get_claude_activity: ({ days }) => claudeActivity(days),
    get_multi_agent_activity: ({ days }) => claudeActivity(days),

    get_session_cost: ({ agent, cwd, sessionId }) => {
      const dir = path.join(
        os.homedir(),
        '.claude',
        'projects',
        (cwd ?? '').replace(/[/\\.]/g, '-'),
      )
      const file = path.join(dir, `${sessionId}.jsonl`)
      const { totals, byModel } = sessionCost(file)
      return {
        session_id: sessionId,
        agent: agent ?? 'claude',
        ...totals,
        total_tokens: totals.input + totals.output,
        cost_usd: null,
        model: [...byModel.keys()][0] ?? null,
        by_model: [...byModel.entries()].map(([model, values]) => ({
          model,
          ...values,
          cost_usd: null,
        })),
      }
    },

    record_activity_samples: ({ samples }) => {
      const file = activityFile()
      const current = paths.readJson(file, { samples: [] })
      current.samples = [...(current.samples ?? []), ...(samples ?? [])].slice(-5000)
      paths.writeJson(file, current)
      return null
    },
    get_activity_summary: ({ dates }) => {
      const stored = paths.readJson(activityFile(), { samples: [] })
      const wanted = new Set(dates ?? [])
      const samples = (stored.samples ?? []).filter(
        (sample) => wanted.size === 0 || wanted.has(sample.date),
      )
      const totalMs = samples.reduce((total, sample) => total + (sample.durationMs ?? 0), 0)
      const activeMs = samples
        .filter((sample) => sample.userActive)
        .reduce((total, sample) => total + (sample.durationMs ?? 0), 0)
      return { days: [], totals: { totalMs, activeMs, sampleCount: samples.length } }
    },
    clear_activity_stats: () => {
      paths.writeJson(activityFile(), { samples: [] })
      return null
    },
  }
}

module.exports = { buildUsageCommands, codexLimits }
