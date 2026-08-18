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

const SETTINGS_FILE = path.join(os.tmpdir(), 'arco-agent-hooks.json')
const HOOK_EVENTS = [
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
]

const token = randomBytes(16).toString('hex')
let port = 0

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
  todo: 'cli://todo-add',
  'todo/edit': 'cli://todo-edit',
}

function json(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
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

    // `/cli/*` is the surface the `arco` command talks to. Reads are answered
    // here because the CLI needs an answer; the actions belong to the frontend,
    // which owns workspace state, so they are handed over and reported queued.
    if (route.startsWith('/cli/')) {
      const name = route.slice('/cli/'.length)
      if (name === 'todo/list') {
        json(response, readTodos())
        return
      }
      const event = CLI_EVENTS[name]
      if (!event) {
        response.writeHead(404).end(`rota /cli/${name} desconhecida`)
        return
      }
      const raw = await readBody(request)
      let payload
      try {
        payload = raw.trim() ? JSON.parse(raw) : {}
      } catch {
        response.writeHead(400).end('payload deve ser JSON')
        return
      }
      send(event, payload)
      json(response, { accepted: true, status: 'queued' })
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
  return SETTINGS_FILE
}

function buildHookCommands() {
  return {
    agent_hooks_endpoint: () => endpoint(),
    agent_hooks_token: () => token,
    agent_hooks_settings_path: () => writeSettings(),
  }
}

module.exports = { startHookListener, buildHookCommands }
