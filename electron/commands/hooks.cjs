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

function startHookListener(send, readTodos) {
  const server = http.createServer(async (request, response) => {
    if (request.headers['x-arco-token'] !== token) {
      response.writeHead(403).end('forbidden')
      return
    }
    if (request.url === '/todos') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(readTodos()))
      return
    }
    const body = await readBody(request)
    try {
      send('agent-hook', JSON.parse(body))
    } catch {}
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  server.listen(0, '127.0.0.1', () => {
    port = server.address().port
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
