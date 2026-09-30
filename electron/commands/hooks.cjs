// Agent hook listener.
//
// Claude Code posts lifecycle hooks (subagent start/stop, tool calls, task
// events) to a local HTTP endpoint. The app writes a settings file pointing at
// it and forwards each payload to the UI as the `agent-hook` event, which is
// what drives live agent status. Same contract as the Rust listener, including
// the shared-secret header, so the settings file works for either shell.

const { randomBytes } = require('node:crypto')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createMcpServer } = require('../mcp-server.cjs')
const { unpackedPath } = require('../unpacked-path.cjs')

// Where the `arco` command reads endpoint and token from. The override exists
// so a second process — a test, a development instance — can bind a listener
// without pointing the installed command at itself.
const SETTINGS_FILE =
  process.env.ARCO_HOOKS_SETTINGS_FILE || path.join(os.tmpdir(), 'arco-agent-hooks.json')
const HOOK_EVENTS = [
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
]

// Every Claude pane loads this one through `--settings`. It holds SessionStart
// alone: the file above posts every tool call, which the canvas wants and a
// pane has no use for.
const SESSION_HOOKS_FILE = path.join(path.dirname(SETTINGS_FILE), 'arco-session-hooks.json')
const SESSION_HOOK_SCRIPT = unpackedPath(path.join(__dirname, '..', 'session-hook.cjs'))

// The `--mcp-config` file for Claude panes. Named after the settings file, so a
// second listener (a test, a development instance) never writes over the one the
// installed app's panes load. It carries the token, so only the owner reads it.
const MCP_CONFIG_FILE = SETTINGS_FILE.replace(/\.json$/, '') + '.mcp.json'

const token = randomBytes(16).toString('hex')
let port = 0
let nodeBinary = null

/** The Node that runs the SessionStart hook; without one, panes start without it. */
function configureSessionHook(node) {
  nodeBinary = node ?? null
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) request.destroy()
    })
    request.on('end', () => resolve(body))
  })
}

/** Routes the `arco` terminal command posts to, mirroring the Rust listener. */
const CLI_EVENTS = {
  session: 'cli://session-new',
  'session/list': 'cli://session-list',
  'session/send': 'cli://session-send',
  'session/close': 'cli://session-close',
  'group/list': 'cli://group-list',
  'group/close': 'cli://group-close',
  'session/rename': 'cli://session-rename',
  todo: 'cli://todo-add',
  'todo/list': 'cli://todo-list',
  'todo/show': 'cli://todo-show',
  'todo/edit': 'cli://todo-edit',
  'todo/delete': 'cli://todo-delete',
  'project/list': 'cli://project-list',
  'project/add': 'cli://project-add',
}

/**
 * How long a `/cli/*` request waits for the frontend to answer.
 *
 * These used to be fire-and-forget: the route answered `queued` and the command
 * exited 0 whatever happened next, so a rejected reference or a task that did
 * not exist looked exactly like a success. The frontend owns the state, so the
 * answer has to come from there — and a request that never gets one has to fail
 * loudly rather than pretend.
 */
const CLI_REPLY_TIMEOUT_MS = Number(process.env.ARCO_CLI_REPLY_TIMEOUT_MS) || 8000

const pendingCliRequests = new Map()
let cliRequestSequence = 0

function json(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

/** Registers a slot for the frontend's answer, resolving to null on timeout. */
function awaitCliReply(requestId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCliRequests.delete(requestId)
      resolve(null)
    }, CLI_REPLY_TIMEOUT_MS)
    pendingCliRequests.set(requestId, { resolve, timer })
  })
}

/** Called by the frontend through `cli_reply` once it has applied a request. */
function resolveCliReply(requestId, result) {
  const pending = pendingCliRequests.get(String(requestId ?? ''))
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingCliRequests.delete(String(requestId))
  pending.resolve(result ?? { ok: true })
  return true
}

function startHookListener(send, readTodos) {
  /**
   * Hands a `/cli/*` request to the frontend and waits for what it did. `null`
   * means it never answered — except a listing, which the file on disk serves.
   */
  async function dispatch(name, payload) {
    cliRequestSequence += 1
    const requestId = `cli-${cliRequestSequence}`
    const reply = awaitCliReply(requestId)
    send(CLI_EVENTS[name], { ...payload, requestId })
    const result = await reply
    if (!result && name === 'todo/list')
      return { ok: true, stale: true, data: { todos: readTodos() } }
    return result
  }
  const mcp = createMcpServer({ dispatch, version: appVersion })

  const server = http.createServer(async (request, response) => {
    if (request.headers['x-arco-token'] !== token) {
      response.writeHead(403).end('forbidden')
      return
    }
    const route = (request.url ?? '').split('?')[0]
    if (route === '/todos') {
      json(response, readTodos())
      return
    }
    // What `arco --version` compares the binary it ran against.
    if (route === '/version') {
      json(response, { ok: true, version: appVersion() })
      return
    }

    // `/cli/*` is the surface the `arco` command talks to. The frontend owns
    // workspace state, so every request is handed over and answered with what
    // it actually did — the CLI reports that back and exits accordingly.
    if (route.startsWith('/cli/')) {
      const name = route.slice('/cli/'.length)
      if (!CLI_EVENTS[name]) {
        json(response, { ok: false, message: `rota /cli/${name} desconhecida` }, 404)
        return
      }
      const raw = await readBody(request)
      let payload
      try {
        payload = raw.trim() ? JSON.parse(raw) : {}
      } catch {
        json(response, { ok: false, message: 'payload deve ser JSON' }, 400)
        return
      }
      const result = await dispatch(name, payload)
      if (!result) {
        json(response, { ok: false, message: 'o app nao respondeu a tempo' }, 504)
        return
      }
      json(response, result, result.ok === false ? 422 : 200)
      return
    }

    // The MCP server the agent panes load: the `/cli/*` surface as typed tools.
    if (route === '/mcp') {
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      const caller = String(request.headers['x-arco-session'] ?? '').trim()
      const { status, body } = await mcp.handlePost(await readBody(request), caller)
      if (body === null) response.writeHead(status).end()
      else json(response, body, status)
      return
    }

    // Which conversation a pane's agent is in, posted by `session-hook.cjs`.
    // Only these fields go on to the window.
    if (route === '/session') {
      try {
        const { pty, sessionId, source, cwd } = JSON.parse(await readBody(request))
        if (typeof pty === 'string' && typeof sessionId === 'string') {
          send('session-hook', {
            pty,
            sessionId,
            source: typeof source === 'string' ? source : null,
            cwd: typeof cwd === 'string' ? cwd : null,
          })
        }
      } catch {}
      json(response, {})
      return
    }

    const body = await readBody(request)
    try {
      send('agent-hook', JSON.parse(body))
    } catch {}
    json(response, {})
  })
  server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    // The `arco` command reads endpoint and token from this file. Writing it as
    // soon as the port is known keeps the CLI usable from boot, instead of only
    // after something in the UI happens to ask for the path.
    try {
      writeSettings()
    } catch {}
    // And it is written again whenever it stops pointing here. The file lives in
    // the temp directory, where anything can replace or delete it — when that
    // happens the command line reports "o app nao esta rodando" with the window
    // open in front of the user, and only a restart fixes it.
    const watchdog = setInterval(() => {
      try {
        const current = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
        const url = current.hooks?.SubagentStart?.[0]?.hooks?.[0]?.url
        const paneFileGone = nodeBinary && !fs.existsSync(SESSION_HOOKS_FILE)
        const mcpFileGone = !fs.existsSync(MCP_CONFIG_FILE)
        if (url !== `${endpoint()}/hook` || paneFileGone || mcpFileGone) writeSettings()
      } catch {
        try {
          writeSettings()
        } catch {}
      }
    }, 30_000)
    if (typeof watchdog.unref === 'function') watchdog.unref()
    server.on('close', () => clearInterval(watchdog))
  })
  return server
}

function appVersion() {
  try {
    return require('electron').app.getVersion()
  } catch {
    return null
  }
}

function endpoint() {
  if (!port) throw new Error('listener de agents ainda nao esta disponivel')
  return `http://127.0.0.1:${port}`
}

function writeSettings() {
  const hook = [
    {
      hooks: [
        {
          type: 'http',
          url: `${endpoint()}/hook`,
          timeout: 5,
          headers: { 'X-Arco-Token': token },
        },
      ],
    },
  ]
  const settings = {
    teammateMode: 'in-process',
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, hook])),
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  writeSessionHooks()
  writeMcpConfig()
  return SETTINGS_FILE
}

/**
 * Puts the pane settings file back when a launch names it and it is gone.
 *
 * It lives in the temp directory, and Claude refuses to start at all when a
 * `--settings` file is missing — a cleaned `/tmp` would take down every pane
 * started until the watchdog noticed.
 */
function ensureSessionHooksFile(args) {
  if (!Array.isArray(args)) return
  try {
    if (args.includes(SESSION_HOOKS_FILE) && !fs.existsSync(SESSION_HOOKS_FILE)) writeSessionHooks()
    if (args.includes(MCP_CONFIG_FILE) && !fs.existsSync(MCP_CONFIG_FILE) && port) writeMcpConfig()
  } catch {}
}

/**
 * The `--mcp-config` file for Claude panes. The pane's own id is left for
 * Claude to expand from the environment, so one file serves every pane; the
 * empty default keeps a launch without it from failing on the expansion.
 */
function writeMcpConfig() {
  const config = {
    mcpServers: {
      arco: {
        type: 'http',
        url: `${endpoint()}/mcp`,
        headers: { 'X-Arco-Token': token, 'X-Arco-Session': '${ARCO_SESSION_ID:-}' },
      },
    },
  }
  fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.chmodSync(MCP_CONFIG_FILE, 0o600)
  return MCP_CONFIG_FILE
}

/** The `--settings` file for Claude panes, or `null` when there is no Node to run the hook. */
function writeSessionHooks() {
  if (!nodeBinary) return null
  const command = [nodeBinary, SESSION_HOOK_SCRIPT, SETTINGS_FILE]
    .map((part) => `"${part}"`)
    .join(' ')
  const settings = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] },
  }
  fs.writeFileSync(SESSION_HOOKS_FILE, JSON.stringify(settings, null, 2))
  return SESSION_HOOKS_FILE
}

function buildHookCommands() {
  return {
    agent_hooks_endpoint: () => endpoint(),
    agent_hooks_token: () => token,
    agent_hooks_settings_path: () => writeSettings(),
    agent_session_hooks_path: () => (port ? writeSessionHooks() : null),
    // What a pane launch needs to load the MCP server: Claude reads the file,
    // Codex and OpenCode are handed the endpoint and token directly.
    arco_mcp_launch: () =>
      port ? { url: `${endpoint()}/mcp`, token, claudeConfig: writeMcpConfig() } : null,
    // The other half of a `/cli/*` request: the frontend reports what it did,
    // and the HTTP response the CLI is still waiting on carries it back.
    cli_reply: (args) => resolveCliReply(args?.requestId, args?.result),
  }
}

module.exports = {
  startHookListener,
  buildHookCommands,
  configureSessionHook,
  ensureSessionHooksFile,
}
