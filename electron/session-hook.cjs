// Claude Code's SessionStart hook for the panes Arco starts: tells the app which
// conversation the pane is in now.
//
// Start, /clear and /resume all arrive here with the id the agent moved to. The
// app tracks the first two on its own by watching the project directory for a
// new transcript, but /resume goes back to one that already exists — nothing new
// shows up there, and the pane kept pointing at the conversation it left.
//
// Runs under the system Node, like the PTY host. It prints nothing: whatever a
// SessionStart hook writes becomes context for the agent. Any failure is silent
// for the same reason, and a slow app never holds the session up for long.

const fs = require('node:fs')
const http = require('node:http')

const settingsFile = process.argv[2]

function report(input) {
  const pty = process.env.ARCO_PTY_ID
  if (!pty || !settingsFile) return
  let payload
  let hook
  try {
    payload = JSON.parse(input)
    hook = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks?.SubagentStart?.[0]?.hooks?.[0]
  } catch {
    return
  }
  const token = hook?.headers?.['X-Arco-Token']
  if (!payload?.session_id || !hook?.url || !token) return
  const body = JSON.stringify({
    pty,
    sessionId: payload.session_id,
    source: payload.source ?? null,
    cwd: payload.cwd ?? null,
  })
  const request = http.request(
    hook.url.replace(/\/hook$/, '/session'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Arco-Token': token,
      },
      timeout: 1500,
    },
    (response) => response.resume(),
  )
  request.on('error', () => {})
  request.on('timeout', () => request.destroy())
  request.end(body)
}

let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => report(input))
setTimeout(() => process.exit(0), 3000).unref()
