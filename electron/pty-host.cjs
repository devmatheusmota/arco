// PTY host: owns every terminal process, speaks newline-delimited JSON over
// stdio with the Electron main process.
//
// It runs under plain Node rather than inside Electron because node-pty ships
// prebuilt binaries for Node's ABI, and because a crash in a terminal must not
// take the window down — the same split Arco has today between the Rust backend
// and the webview.

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { loginEnv, mergePath } = require('./login-env.cjs')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

const SCROLLBACK_CAP_BYTES = 512 * 1024
const FLUSH_INTERVAL_MS = 250
// How long a terminal has to leave on its own before it is killed.
const KILL_GRACE_MS = 2_000

const sessions = new Map()
let scrollbackDir = path.join(os.tmpdir(), 'arco-electron-scrollback')

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function scrollbackPath(id) {
  return path.join(scrollbackDir, `${id}.bin`)
}

function persist(session) {
  if (!session.dirty) return
  session.dirty = false
  try {
    fs.mkdirSync(scrollbackDir, { recursive: true })
    fs.writeFileSync(scrollbackPath(session.id), session.scrollback)
  } catch {}
}

function readScrollback(id) {
  const session = sessions.get(id)
  if (session) return session.scrollback
  try {
    return fs.readFileSync(scrollbackPath(id), 'utf8')
  } catch {
    return ''
  }
}

/**
 * PATH for spawned terminals.
 *
 * A desktop launch inherits a minimal PATH, so an agent CLI installed under
 * ~/.local/bin or a Node version manager is invisible — the PTY then dies with
 * `execvp(3) failed`. The shell and everything it runs get the fuller list a
 * login shell would have.
 */
function enrichedPath() {
  const home = os.homedir()
  const extras = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
  try {
    extras.push(
      ...fs
        .readdirSync(nvmRoot)
        .sort()
        .reverse()
        .map((version) => path.join(nvmRoot, version, 'bin')),
    )
  } catch {}
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  return [...new Set([...current, ...extras])].join(path.delimiter)
}

const LOGIN_ENV = loginEnv()

/** Login shell PATH first, then the entries a desktop launch would miss. */
const SPAWN_PATH = mergePath(LOGIN_ENV.PATH, enrichedPath())

/** Resolves a command name against the enriched PATH before handing it to the PTY. */
function resolveExecutable(command) {
  if (!command) return null
  if (command.includes('/')) return fs.existsSync(command) ? command : null
  for (const dir of SPAWN_PATH.split(path.delimiter)) {
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

/**
 * The nearest existing ancestor of a directory, or the home directory.
 *
 * A pane can outlive the directory it was opened in — the usual case is an
 * agent worktree under `<repo>/.arco/worktrees/<id>` that was removed while the
 * pane still pointed at it. Falling straight back to home moved the pane to an
 * unrelated project, where its agent found none of its own sessions; the repo
 * one level up is where the work actually is.
 */
function nearestExistingDir(dir) {
  let current = dir
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current
    current = path.dirname(current)
  }
  return os.homedir()
}

function spawn({ id, command, args, cwd, env, cols, rows, launcherOverride }) {
  const existing = sessions.get(id)
  if (existing) return { id }

  const shell = process.env.SHELL || '/bin/bash'
  const requested = launcherOverride || command || shell
  const file = resolveExecutable(requested)
  if (!file) throw new Error(`command not found: ${requested}`)
  const spawnCwd = cwd ? nearestExistingDir(cwd) : os.homedir()
  const child = pty.spawn(file, args ?? [], {
    name: 'xterm-256color',
    cols: cols ?? 80,
    rows: rows ?? 24,
    cwd: spawnCwd,
    env: { ...process.env, ...LOGIN_ENV, ...(env ?? {}), PATH: SPAWN_PATH, TERM: 'xterm-256color' },
  })

  const session = {
    id,
    child,
    cwd: spawnCwd,
    command: command ?? 'shell',
    visible: true,
    scrollback: '',
    dirty: false,
    pendingActivity: '',
    lastActivityAt: 0,
  }
  sessions.set(id, session)

  child.onData((data) => {
    session.scrollback += data
    if (session.scrollback.length > SCROLLBACK_CAP_BYTES) {
      // Cut on a line boundary: escape sequences never span a newline, so this
      // is the only trim that cannot leave a half-written CSI at the front of a
      // replay, where it would swallow the bytes that follow it.
      const excess = session.scrollback.length - SCROLLBACK_CAP_BYTES
      const boundary = session.scrollback.indexOf('\n', excess)
      session.scrollback = session.scrollback.slice(boundary >= 0 ? boundary + 1 : excess)
    }
    session.dirty = true
    if (session.visible) {
      send({ type: 'data', id, data })
      return
    }
    // Hidden panes get a throttled digest, matching the backend's behaviour of
    // not paying for a repaint nobody sees.
    session.pendingActivity += data
    const now = Date.now()
    if (now - session.lastActivityAt >= 450) {
      session.lastActivityAt = now
      send({ type: 'activity', id, data: session.pendingActivity })
      session.pendingActivity = ''
    }
  })

  child.onExit(({ exitCode }) => {
    persist(session)
    sessions.delete(id)
    send({ type: 'exit', id, code: exitCode ?? null })
  })

  return { id, pid: child.pid }
}

const handlers = {
  configure({ dir }) {
    if (dir) scrollbackDir = dir
    return true
  },
  spawn_pty: spawn,
  pty_exists: ({ id }) => sessions.has(id),
  write_pty({ id, data }) {
    sessions.get(id)?.child.write(data)
    return null
  },
  resize_pty({ id, cols, rows }) {
    try {
      sessions.get(id)?.child.resize(cols, rows)
    } catch {}
    return null
  },
  kill_pty({ id }) {
    const session = sessions.get(id)
    if (!session) return false
    // Same tree as on shutdown: closing one session must not leave the agent's
    // MCP servers behind, and whatever holds the hangup is killed after the
    // same grace period.
    const pid = hangUp(session)
    setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref()
    return true
  },
  attach_pty: ({ id }) => readScrollback(id),
  clear_pty_scrollback({ id }) {
    const session = sessions.get(id)
    if (session) {
      session.scrollback = ''
      session.dirty = true
    }
    try {
      fs.unlinkSync(scrollbackPath(id))
    } catch {}
    return null
  },
  set_pty_visible({ id, visible }) {
    const session = sessions.get(id)
    if (!session) return false
    session.visible = visible
    if (visible && session.pendingActivity) {
      send({ type: 'data', id, data: session.pendingActivity })
      session.pendingActivity = ''
    }
    return true
  },
  get_pty_cwd({ id }) {
    const session = sessions.get(id)
    if (!session) return null
    try {
      return fs.readlinkSync(`/proc/${session.child.pid}/cwd`)
    } catch {
      return session.cwd
    }
  },
  list_pty_processes: () => [...sessions.values()].map((s) => ({ id: s.id, pid: s.child.pid })),
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) {
      let request
      try {
        request = JSON.parse(line)
      } catch {
        request = null
      }
      if (request) {
        const handler = handlers[request.cmd]
        try {
          const result = handler ? handler(request.args ?? {}) : null
          send({ type: 'reply', requestId: request.requestId, result })
        } catch (error) {
          send({ type: 'reply', requestId: request.requestId, error: String(error) })
        }
      }
    }
    index = buffer.indexOf('\n')
  }
})

// Unref'd so the timer alone never keeps the process alive: stdin is what holds
// the loop open, and once it closes the host must be free to exit.
const flushTimer = setInterval(() => {
  for (const session of sessions.values()) persist(session)
}, FLUSH_INTERVAL_MS)
flushTimer.unref()

// The whole tree, not just the process on the other end of the pty. node-pty
// puts the child in a session and process group of its own, so a negative pid
// reaches everything it started — a coding agent is not one process, and the
// MCP servers it brings up are the ones holding the memory. Signalling the
// child alone leaves them running, reparented to init, for the rest of the
// login session. Windows has no process groups; there the pty kill is all
// there is.
function killGroup(pid, signal) {
  if (!pid || process.platform === 'win32') return
  try {
    process.kill(-pid, signal)
  } catch {}
}

/**
 * Hangs up a terminal and returns the pid of its group, so the caller can come
 * back with SIGKILL. The pid has to be kept: the session leaves `sessions` as
 * soon as the pty reports the exit, and by then the children that ignored the
 * hangup have no one left pointing at them.
 */
function hangUp(session) {
  const pid = session.child?.pid
  killGroup(pid, 'SIGHUP')
  try {
    session.child.kill()
  } catch {}
  return pid
}

let shuttingDown = false

// Killing the main process does not kill this one — POSIX only reparents it, so
// without this the host outlives the window and holds every terminal it owns
// alive forever. Closed stdin means the parent is gone; a signal means someone
// asked it to stop. A signal never reaches `exit` on its own, so the cleanup has
// to hang off the signal itself.
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  const groups = []
  for (const session of sessions.values()) {
    persist(session)
    groups.push(hangUp(session))
  }
  // Whatever ignored the hangup — a wedged agent, an MCP server that outlives
  // the agent that started it — gets killed. Deliberately not unref'd: this
  // timer is the only thing holding the loop open, and it ends the process.
  setTimeout(() => {
    for (const pid of groups) killGroup(pid, 'SIGKILL')
    process.exit(code)
  }, KILL_GRACE_MS)
}

process.stdin.on('end', () => shutdown(0))
process.stdin.on('close', () => shutdown(0))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0))

// Last resort for an exit nothing else caught. Timers no longer run here, so
// this is a single synchronous pass and nothing more.
process.on('exit', () => {
  for (const session of sessions.values()) {
    persist(session)
    killGroup(session.child?.pid, 'SIGKILL')
    try {
      session.child.kill()
    } catch {}
  }
})
