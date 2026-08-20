// Arco's application shell.
//
// The interface runs on Chromium rather than the system WebView. The frontend
// still speaks the Tauri API: `preload.cjs` implements the contract
// `@tauri-apps/api` expects, and every `invoke()` lands in the command router
// here. Terminals live in `pty-host.cjs`, a separate Node process.

const { app, BrowserWindow, ipcMain, protocol, net } = require('electron')
const path = require('node:path')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const { buildCommands, missingCommand } = require('./commands/index.cjs')
const paths = require('./commands/paths.cjs')
const { collectFromArgv } = require('./pending-open.cjs')
const { applyLoginEnv } = require('./login-env.cjs')
const { handleCli } = require('./cli.cjs')

// `arco todo` / `arco session` are answered here and the process exits. They
// used to live only in the shell shim, so when that file was missing the
// subcommand reached the binary, matched nothing, and fell through to opening a
// window — the command hung instead of answering.
if (handleCli(process.argv, (code) => app.exit(code))) return

// Launched from the desktop entry, the app inherits a bare environment: agent
// CLIs under ~/.local/bin are invisible and anything exported from the user's
// rc files is absent. Fill it in before anything spawns a child process.
applyLoginEnv()

// Identity, set before anything creates a window. On Linux the app_id (WM_CLASS
// under Wayland) comes from the app name, and the desktop entry has to match it
// for the window to land on the right icon.
app.setName('Arco')
if (process.platform === 'linux' && typeof app.setDesktopName === 'function') {
  app.setDesktopName('arco.desktop')
}

let mainWindow = null

const DIST_DIR = path.join(__dirname, '..', 'dist')

// The bundle references its assets from the site root ("/assets/..."), which a
// file:// page would resolve against the filesystem root. Serving it under a
// scheme of our own keeps those URLs valid, the way Tauri's custom protocol
// does for the same build.
function registerAppProtocol() {
  protocol.handle('arco', (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const target = path.join(DIST_DIR, relative)
    if (!target.startsWith(DIST_DIR)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(target).toString())
  })
}

/**
 * Finds a Node to run the helper hosts with.
 *
 * `node` is on PATH in a terminal but usually not for an app launched from the
 * desktop menu, and a version manager puts it somewhere else entirely. Without
 * this the PTY host never starts and every pane sits on "Preparing terminal…".
 */
function resolveNode() {
  const candidates = []
  if (process.env.ARCO_NODE) candidates.push(process.env.ARCO_NODE)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'node'))
  }
  const home = require('node:os').homedir()
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
  try {
    const versions = fs
      .readdirSync(nvmRoot)
      .sort()
      .reverse()
      .map((version) => path.join(nvmRoot, version, 'bin', 'node'))
    candidates.push(...versions)
  } catch {}
  candidates.push(
    path.join(home, '.local', 'bin', 'node'),
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/opt/homebrew/bin/node',
  )
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

/** Talks to the PTY host over newline-delimited JSON on stdio. */
function startPtyHost(send) {
  // Terminals live in their own process so a crash there cannot take the window
  // down. It runs under the system Node because node-pty's prebuilt binary
  // targets Node's ABI — packaging does not rebuild it for Electron.
  // Inside a package the file lives in app.asar.unpacked, which is a real path
  // on disk; system Node cannot read the archive itself.
  const hostPath = path.join(__dirname, 'pty-host.cjs').replace('app.asar', 'app.asar.unpacked')
  const nodeBinary = resolveNode()
  if (!nodeBinary) {
    console.error('[arco] no Node runtime found; terminals cannot start')
  }
  const child = spawn(nodeBinary ?? 'node', [hostPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.on('error', (error) => {
    console.error('[arco] could not start the PTY host — is Node installed?', error)
  })
  const pending = new Map()
  let nextRequestId = 1
  let buffer = ''

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.type === 'reply') {
        const entry = pending.get(message.requestId)
        pending.delete(message.requestId)
        if (!entry) continue
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve(message.result)
      } else if (message.type === 'data') {
        send(`pty://data/${message.id}`, message.data)
      } else if (message.type === 'activity') {
        send(`pty://activity/${message.id}`, message.data)
      } else if (message.type === 'exit') {
        send(`pty://exit/${message.id}`, { code: message.code, reason: null })
      }
    }
  })

  // A dead host used to leave every caller waiting forever, which the UI shows
  // as "Preparing terminal…" with no way out. Pending calls are failed, and the
  // next request starts a fresh host.
  child.on('exit', (code) => {
    console.error(`[arco] PTY host exited (${code}); failing ${pending.size} pending call(s)`)
    for (const entry of pending.values()) entry.reject(new Error('pty host exited'))
    pending.clear()
  })

  const REQUEST_TIMEOUT_MS = 15_000
  const request = (cmd, args) =>
    new Promise((resolve, reject) => {
      const requestId = nextRequestId++
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`pty host timed out on ${cmd}`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      child.stdin.write(`${JSON.stringify({ requestId, cmd, args })}\n`)
    })

  void request('configure', {
    dir: path.join(paths.appLocalDataDir(), 'profiles', 'default', 'scrollback'),
  })

  return { request, child }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    backgroundColor: '#0f1117',
    title: 'Arco',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The terminal is the whole point of this build; keep it drawing while
      // the window is in the background too.
      backgroundThrottling: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  // ARCO_DEV_URL points at the Vite dev server, which keeps console output and
  // hot reload; without it the built bundle is served over the app scheme.
  const devUrl = process.env.ARCO_DEV_URL
  void mainWindow.loadURL(devUrl || 'arco://app/index.html')
  if (devUrl) mainWindow.webContents.openDevTools({ mode: 'detach' })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] gone:', JSON.stringify(details))
  })
  if (process.env.ARCO_TRACE_INVOKE === '1') {
    // Electron 43 passes a single event object here.
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`)
    })
    mainWindow.webContents.on('did-finish-load', async () => {
      const probe = await mainWindow.webContents.executeJavaScript(`(() => ({
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        hasInternals: typeof window.__TAURI_INTERNALS__,
        scripts: [...document.scripts].map((s) => s.src).slice(0, 3),
      }))()`)
      console.log('[probe]', JSON.stringify(probe))
    })
  }

  if (process.env.ARCO_PROBE_LAYOUT) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const script = require('node:fs').readFileSync(process.env.ARCO_PROBE_LAYOUT, 'utf8')
        try {
          console.log('[layout]', await mainWindow.webContents.executeJavaScript(script))
        } catch (error) {
          console.log('[layout] probe failed:', String(error))
        }
      }, 12_000)
    })
  }

  // Focus, in the shape `@tauri-apps/api`'s `onFocusChanged` listens for. The
  // frontend gates its polling on it — usage pills, remote devices — so without
  // these events a window that starts unfocused never polls again, and the
  // pills stay empty for the rest of the session.
  const emitFocus = (focused) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('tauri:event', {
      event: focused ? 'tauri://focus' : 'tauri://blur',
      payload: focused,
    })
  }
  mainWindow.on('focus', () => emitFocus(true))
  mainWindow.on('blur', () => emitFocus(false))
  mainWindow.webContents.on('did-finish-load', () => emitFocus(mainWindow?.isFocused() ?? false))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'arco', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// A second launch hands its arguments to the running instance instead of
// opening a rival window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    collectFromArgv(argv)
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
collectFromArgv(process.argv)

app.whenReady().then(() => {
  registerAppProtocol()

  const send = (event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tauri:event', { event, payload })
    }
  }
  const ptyHost = startPtyHost(send)
  const commands = buildCommands({ ptyHost, mainWindow: () => mainWindow, send })

  // Quitting the window leaves the host running otherwise: it is reparented to
  // init and keeps every terminal — and the agents inside them — alive for the
  // rest of the session. Closing stdin lets it flush scrollback on its own; the
  // signals are there for a host that is wedged and cannot read stdin any more.
  app.on('before-quit', () => {
    const child = ptyHost.child
    if (!child || child.killed || child.exitCode !== null) return
    try {
      child.stdin.end()
    } catch {}
    try {
      child.kill('SIGTERM')
    } catch {}
    // Longer than the host's own grace period, so this never cuts it off while
    // it is still killing the terminals it owns.
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 5_000).unref()
  })

  ipcMain.handle('tauri:invoke', async (_event, { cmd, args }) => {
    if (process.env.ARCO_TRACE_INVOKE === '1') console.log(`[invoke] ${cmd}`)
    const handler = commands[cmd]
    if (!handler) return missingCommand(cmd)
    try {
      return await handler(args ?? {})
    } catch (error) {
      return { __error: String(error) }
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
