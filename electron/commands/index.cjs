// Command router: maps the names the frontend already invokes onto handlers.
//
// Anything not implemented yet answers with a null instead of throwing, so a
// missing corner degrades that feature rather than breaking the window, and
// gets logged once so the porting order follows what the app actually calls.

const { app, dialog, shell, nativeImage, BrowserWindow, Notification } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const paths = require('./paths.cjs')
const { buildSessionCommands } = require('./sessions.cjs')
const { buildGitCommands } = require('./git.cjs')
const { buildExtraCommands } = require('./extras.cjs')
const { buildUsageCommands } = require('./usage.cjs')
const { buildLibraryCommands } = require('./library.cjs')
const { buildWorktreeCommands } = require('./worktrees.cjs')
const { buildHookCommands, ensureSessionHooksFile, startHookListener } = require('./hooks.cjs')
const { buildDictationCommands } = require('./dictation.cjs')
const { buildMeetingCommands } = require('./meeting.cjs')
const { buildPlatformCommands } = require('./platform.cjs')
const { buildSystemCommands } = require('./system.cjs')
const { buildPlanningCommands } = require('./planning.cjs')
const { buildSkillsCommands } = require('./skills.cjs')
const { buildTelemetryCommands } = require('./telemetry.cjs')
const { buildResourceCommands } = require('./resources.cjs')
const { restartPty } = require('./ptyRestart.cjs')

const reportedMissing = new Set()

function activeProfileId() {
  const registry = paths.readJson(paths.profilesRegistryPath(), null)
  return registry?.active_profile_id ?? 'default'
}

function projectsPath() {
  return path.join(paths.profileDir(activeProfileId()), 'projects.json')
}

/**
 * Task status changes, one JSON line each, beside `projects.json`.
 *
 * Kept out of `projects.json` on purpose: that file is rewritten whole on every
 * save and pushed to the sync gist in one piece, and a history only grows.
 * Appending a line costs the same on day one and day five hundred.
 */
function todoEventsPath() {
  return path.join(path.dirname(projectsPath()), 'todo-events.jsonl')
}

/** Every recorded change of one task, oldest first. A line that does not parse is skipped. */
function readTodoEvents(id) {
  if (typeof id !== 'string' || !id) return []
  let content
  try {
    content = fs.readFileSync(todoEventsPath(), 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of content.split('\n')) {
    if (!line.includes(id)) continue
    try {
      const event = JSON.parse(line)
      if (event?.id === id) events.push(event)
    } catch {}
  }
  return events
}

/**
 * The file as it was before a migration changed its shape, written once.
 *
 * The v13 migration rewrites every task's status from its title and tags, and
 * the save that follows makes it permanent. A copy taken before the first save
 * under the new version is the way back if the mapping got something wrong.
 */
const CURRENT_PROJECTS_VERSION = 13
function keepPreMigrationCopy(target, content) {
  const version = Number(content.slice(0, 200).match(/"version"\s*:\s*(\d+)/)?.[1] ?? NaN)
  if (!Number.isFinite(version) || version >= CURRENT_PROJECTS_VERSION) return
  const copy = `${target}.pre-v${CURRENT_PROJECTS_VERSION}`
  try {
    if (!fs.existsSync(copy)) fs.writeFileSync(copy, content)
  } catch {}
}

/**
 * The file the last save left on disk and how many projects it held.
 *
 * The guard against an empty save needs the count already on disk. Reading and
 * parsing the whole file for it on every save put a megabyte of JSON through the
 * main process each time the workspace changed; the count is only read back when
 * the file is not the one this process wrote last (a profile switch, a restore
 * from the gist).
 */
let lastWritten = null

function projectCountOnDisk(target) {
  let stats
  try {
    stats = fs.statSync(target)
  } catch {
    return 0
  }
  if (
    lastWritten &&
    lastWritten.target === target &&
    lastWritten.mtimeMs === stats.mtimeMs &&
    lastWritten.size === stats.size
  ) {
    return lastWritten.projectCount
  }
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'))?.projects?.length ?? 0
  } catch {
    return 0
  }
}

/** Saves land one after another, so two writes never share the temp file. */
let saveChain = Promise.resolve()

async function writeProjects(target, content, projectCount) {
  paths.ensureDir(path.dirname(target))
  const tmp = `${target}.tmp`
  await fs.promises.writeFile(tmp, content)
  await fs.promises.rename(tmp, target)
  try {
    const stats = fs.statSync(target)
    lastWritten = { target, mtimeMs: stats.mtimeMs, size: stats.size, projectCount }
  } catch {
    lastWritten = null
  }
}

/**
 * Resolves a CLI the way a login shell would. The app is launched from a
 * desktop entry as often as from a terminal, and those two have different
 * PATHs — agent CLIs installed under ~/.local/bin or a Node version manager are
 * the usual casualties.
 */
const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
]

function which(command) {
  if (!command) return Promise.resolve(null)
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of [...fromPath, ...EXTRA_BIN_DIRS]) {
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return Promise.resolve(candidate)
    } catch {}
  }
  // Last resort: ask a login shell, which picks up version managers.
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || '/bin/bash',
      ['-lc', `command -v ${command}`],
      { timeout: 4000 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
  })
}

const { appendLog } = paths

function buildCommands({ ptyHost, mainWindow, send }) {
  // Hook payloads reach the UI as `agent-hook`, the same event the Rust
  // listener emits.
  if (send) {
    startHookListener(send, () => {
      try {
        return JSON.parse(fs.readFileSync(projectsPath(), 'utf8')).todos ?? []
      } catch {
        return []
      }
    })
  }
  const window = () => mainWindow() ?? BrowserWindow.getAllWindows()[0]

  return {
    ...buildSessionCommands(),
    ...buildGitCommands(),
    ...buildExtraCommands(),
    ...buildUsageCommands(),
    ...buildLibraryCommands(),
    ...buildWorktreeCommands(),
    ...buildHookCommands(),
    ...buildDictationCommands(send),
    ...buildMeetingCommands(),
    ...buildPlatformCommands(),
    ...buildSystemCommands({ ptyHost, send }),
    ...buildPlanningCommands(),
    ...buildSkillsCommands(),
    ...buildTelemetryCommands({ send }),
    ...buildResourceCommands({ ptyHost }),

    // ── terminals ────────────────────────────────────────────────────────
    spawn_pty: (args) => {
      ensureSessionHooksFile(args.extraArgs)
      return ptyHost.request('spawn_pty', {
        id: args.id,
        command: args.command,
        args: args.extraArgs ?? [],
        cwd: args.cwd,
        env: args.env,
        cols: args.cols,
        rows: args.rows,
        launcherOverride: args.launcherOverride,
      })
    },
    pty_exists: (args) => ptyHost.request('pty_exists', args),
    write_pty: (args) => ptyHost.request('write_pty', args),
    resize_pty: (args) => ptyHost.request('resize_pty', args),
    kill_pty: (args) => ptyHost.request('kill_pty', args),
    attach_pty: (args) => ptyHost.request('attach_pty', args),
    clear_pty_scrollback: (args) => ptyHost.request('clear_pty_scrollback', args),
    set_pty_visible: (args) => ptyHost.request('set_pty_visible', args),
    get_pty_cwd: (args) => ptyHost.request('get_pty_cwd', args),
    list_pty_processes: () => ptyHost.request('list_pty_processes', {}),
    suspend_pty: (args) => ptyHost.request('kill_pty', { id: args.id, reason: 'suspended' }),
    restart_pty: (args) => {
      ensureSessionHooksFile(args.extraArgs)
      return restartPty(ptyHost, args)
    },

    // ── persistence ──────────────────────────────────────────────────────
    // The Rust command hands the frontend the raw file contents as a string and
    // takes the same back; returning parsed JSON here made the store hydrate
    // empty and then persist that emptiness over a real workspace.
    load_projects: () => {
      let content
      try {
        content = fs.readFileSync(projectsPath(), 'utf8')
      } catch {
        return null
      }
      keepPreMigrationCopy(projectsPath(), content)
      return content
    },
    todo_events_append: async ({ events }) => {
      const lines = (Array.isArray(events) ? events : [])
        .filter((event) => event && typeof event.id === 'string' && typeof event.to === 'string')
        .map((event) => `${JSON.stringify(event)}\n`)
        .join('')
      if (!lines) return null
      await fs.promises.appendFile(todoEventsPath(), lines)
      return null
    },
    todo_events_read: ({ id }) => readTodoEvents(id),
    save_projects: (args) => {
      const content = typeof args.content === 'string' ? args.content : JSON.stringify(args.content)
      const target = projectsPath()
      // The renderer says how many projects it is saving, so the content is not
      // parsed again here; an older caller that does not is parsed as before.
      let incomingCount = Number.isInteger(args.projectCount) ? args.projectCount : null
      if (incomingCount === null) {
        try {
          incomingCount = JSON.parse(content)?.projects?.length ?? 0
        } catch {
          incomingCount = null
        }
      }
      const run = async () => {
        // Refuse a save that would wipe a populated workspace. A shell still
        // being ported can fail to hydrate, and losing every project to that
        // is not a recoverable mistake.
        if (incomingCount !== null) {
          const currentCount = projectCountOnDisk(target)
          if (incomingCount === 0 && currentCount > 0) {
            fs.writeFileSync(`${target}.electron-refused`, content)
            appendLog(
              'app-events.log',
              `[electron.guard] refused save: 0 projects would replace ${currentCount}`,
            )
            return null
          }
          try {
            if (currentCount > 0 && !fs.existsSync(`${target}.electron-backup`)) {
              fs.copyFileSync(target, `${target}.electron-backup`)
            }
          } catch {}
        }
        await writeProjects(target, content, incomingCount ?? 0)
        return null
      }
      const result = saveChain.then(run, run)
      saveChain = result.catch(() => null)
      return result
    },
    list_profiles: () =>
      paths.readJson(paths.profilesRegistryPath(), {
        version: 1,
        active_profile_id: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            created_at_ms: Date.now(),
            last_used_at_ms: Date.now(),
          },
        ],
      }),
    get_active_profile: () => {
      const registry = paths.readJson(paths.profilesRegistryPath(), null)
      const id = registry?.active_profile_id ?? 'default'
      return (
        registry?.profiles?.find((profile) => profile.id === id) ?? {
          id,
          name: 'Default',
          created_at_ms: Date.now(),
          last_used_at_ms: Date.now(),
        }
      )
    },

    // ── CLI discovery ────────────────────────────────────────────────────
    find_cli_launcher: (args) => which(args.agent ?? args.command ?? args.name),
    // A path handed to the CLI shim (`arco <dir>`) waits here until the window
    // asks for it, which happens once the workspace is mounted.
    cli_take_pending_open: () => {
      const { takePendingOpen } = require('../pending-open.cjs')
      return takePendingOpen()
    },

    // ── logging ──────────────────────────────────────────────────────────
    record_app_event: (args) => {
      appendLog('app-events.log', `[${args.kind}] ${args.message}`)
      return null
    },
    record_frontend_error: (args) => {
      const stack = args.stack ? `\n${args.stack}` : ''
      appendLog(
        `frontend-${Math.floor(Date.now() / 1000)}.log`,
        `[${args.kind}] ${args.message}${stack}`,
      )
      return null
    },

    // ── window controls ──────────────────────────────────────────────────
    'plugin:window|minimize': () => (window()?.minimize(), null),
    'plugin:window|toggle_maximize': () => {
      const target = window()
      if (!target) return null
      if (target.isMaximized()) target.unmaximize()
      else target.maximize()
      return null
    },
    'plugin:window|close': () => (window()?.close(), null),
    'plugin:window|is_maximized': () => window()?.isMaximized() ?? false,
    'plugin:window|is_focused': () => window()?.isFocused() ?? false,
    'plugin:window|is_minimized': () => window()?.isMinimized() ?? false,
    // Dragging is handled by the `-webkit-app-region` rule the preload injects
    // over the title bar, so there is nothing to start here.
    'plugin:window|start_dragging': () => null,
    'plugin:window|set_title': (args) => (window()?.setTitle(args.title ?? 'Arco'), null),
    set_window_opacity: ({ opacity }) => {
      window()?.setOpacity(Math.min(1, Math.max(0.2, Number(opacity) || 1)))
      return null
    },

    // ── shell / dialogs ──────────────────────────────────────────────────
    'plugin:opener|open_url': (args) => (shell.openExternal(args.url), null),
    'plugin:opener|open_path': (args) => (shell.openPath(args.path), null),
    'plugin:dialog|open': async (args) => {
      const result = await dialog.showOpenDialog({
        properties: args?.options?.directory ? ['openDirectory'] : ['openFile'],
        title: args?.options?.title,
      })
      if (result.canceled) return null
      return args?.options?.multiple ? result.filePaths : (result.filePaths[0] ?? null)
    },
    'plugin:dialog|save': async (args) => {
      const result = await dialog.showSaveDialog({ title: args?.options?.title })
      return result.canceled ? null : result.filePath
    },
    'plugin:dialog|message': async (args) => {
      await dialog.showMessageBox(window(), {
        type: args?.options?.kind === 'error' ? 'error' : 'info',
        title: args?.options?.title ?? 'Arco',
        message: args?.message ?? '',
      })
      return null
    },
    // Answering `true` without asking would let a destructive confirmation
    // through untouched, so this really does ask.
    'plugin:dialog|confirm': async (args) => {
      const result = await dialog.showMessageBox(window(), {
        type: 'question',
        buttons: [args?.options?.cancelLabel ?? 'Cancel', args?.options?.okLabel ?? 'OK'],
        defaultId: 1,
        cancelId: 0,
        title: args?.options?.title ?? 'Arco',
        message: args?.message ?? '',
      })
      return result.response === 1
    },
    'plugin:notification|is_permission_granted': () => Notification.isSupported(),
    'plugin:notification|request_permission': () => 'granted',
    'plugin:notification|notify': (args) => {
      if (!Notification.isSupported()) return null
      new Notification({
        title: args?.options?.title ?? 'Arco',
        body: args?.options?.body ?? '',
      }).show()
      return null
    },
    'plugin:process|exit': () => (app.quit(), null),
    'plugin:process|restart': () => (app.relaunch(), app.quit(), null),
    // This build is distributed as an AppImage with no update feed behind it;
    // reporting "no update" is the truthful answer, not a placeholder.
    'plugin:updater|check': () => null,

    // ── filesystem used by the sidebar ───────────────────────────────────
    list_directory: (args) => {
      const dir = args.path ?? os.homedir()
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          path: path.join(dir, entry.name),
          is_dir: entry.isDirectory(),
        }))
      } catch {
        return []
      }
    },
    read_text_file: (args) => {
      try {
        return fs.readFileSync(paths.expandHome(args.path), 'utf8')
      } catch {
        return null
      }
    },
    write_text_file: (args) => {
      const file = paths.expandHome(args.path)
      // Same contract as the Rust command: overwrite an existing file, never create one,
      // and let a failed write reach the editor instead of reading as saved.
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        throw new Error('file not found')
      }
      fs.writeFileSync(file, args.content)
      return null
    },

    // ── integrations the shell does not provide yet ──────────────────────
    // These answer with the shape the UI expects so the feature reads as off
    // instead of erroring while the port continues.
    remote_control_connected_devices: () => 0,
    remote_control_info: () => ({
      enabled: false,
      host: '',
      http_port: 0,
      ws_port: 0,
      pairing_open: false,
      connected_devices: 0,
      max_devices: 0,
      read_only: true,
      shell_input: false,
      session_expiry_secs: 0,
      pairing_code: null,
      url: null,
    }),
    remote_control_open_pairing: () => null,
    remote_control_close_pairing: () => null,
    remote_control_revoke: () => null,
    remote_control_revoke_device: () => null,
    remote_control_set_max_devices: () => null,
    remote_control_set_session_expiry: () => null,
    remote_control_set_read_only: () => null,
    remote_control_set_shell_input: () => null,
    remote_control_set_enabled: () => null,
    ghostty_kill_all: () => null,
    ghostty_spawn: () => ({ id: '', attached: false }),
    ghostty_sync_frame: () => null,
    ghostty_set_hidden: () => null,
    ghostty_kill: () => null,
    'plugin:window|set_icon': (args) => {
      const image = args?.icon ? nativeImage.createFromPath(args.icon) : null
      if (image && !image.isEmpty()) window()?.setIcon(image)
      return null
    },
    'plugin:webview|set_webview_zoom': (args) => {
      window()?.webContents.setZoomFactor(args?.value ?? 1)
      return null
    },
  }
}

function missingCommand(cmd) {
  if (!reportedMissing.has(cmd)) {
    reportedMissing.add(cmd)
    console.warn(`[arco-electron] command not ported yet: ${cmd}`)
    appendLog('electron-missing-commands.log', cmd)
  }
  return null
}

module.exports = { buildCommands, missingCommand, appendLog }
