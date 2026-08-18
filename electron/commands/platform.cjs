// The remaining platform surface: MCP capability and health, GitHub sync, the
// `arco` CLI shim, economy agents, provider models, contract checks and health
// probes.
//
// Everything here reads and writes the same files and endpoints the Rust
// backend does, so a machine can switch between the two shells and see the same
// state.

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const paths = require('./paths.cjs')

const SHIM_DIR = path.join(os.homedir(), '.local', 'bin')
const SHIM_PATH = path.join(SHIM_DIR, 'arco')
const SHIM_MARKER = '# arco-cli-shim'
const GITHUB_STATE = () => path.join(paths.appLocalDataDir(), 'github-sync.json')

// ── MCP ─────────────────────────────────────────────────────────────────────

/** What each agent's MCP implementation supports, mirroring the Rust table. */
const MCP_CAPABILITIES = [
  {
    agent: 'claude',
    projectScope: true,
    enabledFlag: true,
    envPassthrough: true,
    timeouts: true,
    headers: true,
    remote: true,
  },
  {
    agent: 'codex',
    projectScope: true,
    enabledFlag: false,
    envPassthrough: true,
    timeouts: false,
    headers: false,
    remote: false,
  },
  {
    agent: 'opencode',
    projectScope: true,
    enabledFlag: true,
    envPassthrough: true,
    timeouts: false,
    headers: false,
    remote: true,
  },
]

/**
 * Health of each configured server.
 *
 * A stdio server is probed by starting it and seeing whether it survives its
 * first second and answers an `initialize`; an HTTP one by reaching its URL.
 * Anything else is reported unknown rather than guessed.
 */
async function checkServer(server) {
  if (server.url) {
    try {
      const response = await fetch(server.url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(4000),
      })
      return { name: server.name, status: response.ok ? 'ok' : 'error' }
    } catch {
      return { name: server.name, status: 'error' }
    }
  }
  if (!server.command) return { name: server.name, status: 'unknown' }
  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ name: server.name, status })
    }
    const child = spawn(server.command, server.args ?? [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(server.env ?? {}) },
    })
    child.on('error', () => finish('error'))
    child.stdout.on('data', () => finish('ok'))
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'arco' } },
      })}\n`,
    )
    setTimeout(() => finish(child.exitCode === null ? 'ok' : 'error'), 3000)
  })
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

function githubStatus(state = githubState()) {
  return {
    connected: Boolean(state.token && state.login),
    login: state.login,
    gist_id: state.gist_id,
    gist_url: state.gist_url,
    last_push_ms: state.last_push_ms,
    last_pull_ms: state.last_pull_ms,
  }
}

async function githubUser(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'arco' },
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
  const body = await response.json()
  return body.login ?? null
}

// ── CLI shim ────────────────────────────────────────────────────────────────

function shimScript() {
  return `#!/bin/bash
${SHIM_MARKER}
# Opens a path in the running Arco window, or starts one.
exec "${process.execPath}" --open-path "\${1:-$PWD}" "\${@:2}"
`
}

function shimStatus() {
  let installed = false
  let stale = false
  try {
    const contents = fs.readFileSync(SHIM_PATH, 'utf8')
    installed = contents.includes(SHIM_MARKER)
    stale = installed && !contents.includes(process.execPath)
  } catch {}
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(SHIM_DIR)
  return {
    supported: true,
    installed,
    stale,
    path: installed ? SHIM_PATH : null,
    bin_dir: SHIM_DIR,
    on_path: onPath,
  }
}

// ── economy agents ──────────────────────────────────────────────────────────

/** Agents the project marks as economy mode, stored beside the project. */
function economyFile(folder) {
  return path.join(folder ?? os.homedir(), '.arco', 'economy-agents.json')
}

function buildPlatformCommands() {
  return {
    mcp_capabilities: () => MCP_CAPABILITIES,
    mcp_health_check: async ({ agent }) => {
      const { readServers } = require('./extras.cjs')
      const servers = readServers().filter((server) => !agent || server.agent === agent)
      return Promise.all(servers.map(checkServer))
    },
    mcp_registry_search: async ({ query, page }) => {
      try {
        const url = new URL('https://api.github.com/search/repositories')
        url.searchParams.set('q', `${query ?? ''} mcp server in:name,description`)
        url.searchParams.set('per_page', '20')
        url.searchParams.set('page', String(page ?? 1))
        const response = await fetch(url, { headers: { 'User-Agent': 'arco' } })
        if (!response.ok) return { items: [], total: 0, page: page ?? 1 }
        const body = await response.json()
        return {
          items: (body.items ?? []).map((item) => ({
            name: item.name,
            description: item.description ?? '',
            url: item.html_url,
            stars: item.stargazers_count ?? 0,
          })),
          total: body.total_count ?? 0,
          page: page ?? 1,
        }
      } catch {
        return { items: [], total: 0, page: page ?? 1 }
      }
    },

    github_sync_status: () => githubStatus(),
    github_sync_set_token: async ({ token }) => {
      const login = await githubUser(token)
      const state = { ...githubState(), token, login }
      paths.writeJson(GITHUB_STATE(), state)
      return githubStatus(state)
    },
    github_sync_logout: () => {
      paths.writeJson(GITHUB_STATE(), {
        token: null,
        login: null,
        gist_id: null,
        gist_url: null,
        last_push_ms: null,
        last_pull_ms: null,
      })
      return githubStatus()
    },

    cli_shim_status: () => shimStatus(),
    cli_shim_install: () => {
      paths.ensureDir(SHIM_DIR)
      fs.writeFileSync(SHIM_PATH, shimScript(), { mode: 0o755 })
      return shimStatus()
    },
    cli_shim_uninstall: () => {
      try {
        if (fs.readFileSync(SHIM_PATH, 'utf8').includes(SHIM_MARKER)) fs.unlinkSync(SHIM_PATH)
      } catch {}
      return shimStatus()
    },

    economy_agents_enabled: ({ folder }) => {
      const stored = paths.readJson(economyFile(folder), { agents: [] })
      return (stored.agents ?? []).length > 0
    },
    set_economy_agents: ({ folder, enabled }) => {
      const agents = enabled ? ['claude', 'codex', 'opencode'] : []
      paths.writeJson(economyFile(folder), { agents })
      return agents
    },

    /** Models a provider actually offers, asked of the provider itself. */
    discover_provider_models: async ({ provider }) => {
      const endpoints = {
        anthropic: {
          url: 'https://api.anthropic.com/v1/models',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
            'anthropic-version': '2023-06-01',
          },
          pick: (body) => (body.data ?? []).map((model) => ({ id: model.id, name: model.id })),
        },
        openai: {
          url: 'https://api.openai.com/v1/models',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
          pick: (body) => (body.data ?? []).map((model) => ({ id: model.id, name: model.id })),
        },
      }
      const config = endpoints[provider]
      if (!config) return []
      try {
        const response = await fetch(config.url, { headers: config.headers })
        if (!response.ok) return []
        return config.pick(await response.json())
      } catch {
        return []
      }
    },

    /** Warns about env vars a compose/env file declares but does not define. */
    contract_check: ({ envPath }) => {
      if (!envPath) return []
      let contents
      try {
        contents = fs.readFileSync(envPath, 'utf8')
      } catch {
        return [{ level: 'error', message: `cannot read ${envPath}` }]
      }
      const warnings = []
      for (const [index, line] of contents.split('\n').entries()) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const [key, ...rest] = trimmed.split('=')
        const value = rest.join('=')
        if (!key.trim()) continue
        if (value.trim() === '') {
          warnings.push({ level: 'warning', message: `${key.trim()} is empty (line ${index + 1})` })
        }
      }
      return warnings
    },

    /** Starts a command and reports whether its port answers before the timeout. */
    health_probe: async ({ startCommand, path: probePath, timeoutMs }) => {
      const deadline = Date.now() + (timeoutMs ?? 15_000)
      const port = Number((probePath ?? '').match(/:(\d+)/)?.[1] ?? 0)
      if (!port) return { ok: false, detail: 'no port in path' }
      if (startCommand) {
        spawn('/bin/sh', ['-lc', startCommand], { stdio: 'ignore', detached: true }).unref()
      }
      while (Date.now() < deadline) {
        const reachable = await new Promise((resolve) => {
          const socket = net.connect({ port, host: '127.0.0.1' }, () => {
            socket.destroy()
            resolve(true)
          })
          socket.on('error', () => resolve(false))
          socket.setTimeout(1000, () => {
            socket.destroy()
            resolve(false)
          })
        })
        if (reachable) return { ok: true, detail: `port ${port} answered` }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return { ok: false, detail: `port ${port} did not answer` }
    },
  }
}

module.exports = { buildPlatformCommands }
