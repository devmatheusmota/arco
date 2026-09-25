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
      let version = null
      try {
        version = require('electron').app.getVersion()
      } catch {}
      json(response, { ok: true, version })
      return
    }

    // `/cli/*` is the surface the `arco` command talks to. The frontend owns
    // workspace state, so every request is handed over and answered with what
    // it actually did — the CLI reports that back and exits accordingly.
    if (route.startsWith('/cli/')) {
      const name = route.slice('/cli/'.length)
      const event = CLI_EVENTS[name]
      if (!event) {
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
      cliRequestSequence += 1
      const requestId = `cli-${cliRequestSequence}`
      const reply = awaitCliReply(requestId)
      send(event, { ...payload, requestId })
      const result = await reply
      if (!result) {
        // The window may not be up yet. A listing can still be served from the
        // file on disk; an action cannot, and says so instead of vanishing.
        if (name === 'todo/list') {
          json(response, { ok: true, stale: true, data: { todos: readTodos() } })
          return
        }
        json(response, { ok: false, message: 'o app nao respondeu a tempo' }, 504)
        return
      }
      json(response, result, result.ok === false ? 422 : 200)
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
        if (url !== `${endpoint()}/hook` || paneFileGone) writeSettings()
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
  if (!Array.isArray(args) || !args.includes(SESSION_HOOKS_FILE)) return
  if (fs.existsSync(SESSION_HOOKS_FILE)) return
  try {
    writeSessionHooks()
  } catch {}
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
