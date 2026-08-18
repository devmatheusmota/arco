// Profiles, filesystem entries, "open in…" actions, app data and process trees.
//
// The Rust backend reaches these through Tauri's app handle and the OS shell;
// here they go through Electron's `shell`/`app` and /proc, writing the same
// files so a machine can switch shells without losing state.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { app, shell } = require('electron')

const paths = require('./paths.cjs')

const WATCH_EVENT = 'md://changed'
const watchers = new Map()

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message))
      else resolve(stdout)
    })
  })
}

// ── profiles ────────────────────────────────────────────────────────────────

function defaultIndex() {
  const now = Date.now()
  return {
    version: 1,
    active_profile_id: 'default',
    profiles: [{ id: 'default', name: 'Default', created_at_ms: now, last_used_at_ms: now }],
  }
}

function readIndex() {
  const index = paths.readJson(paths.profilesRegistryPath(), null)
  if (!index?.profiles?.length) return defaultIndex()
  if (!index.profiles.some((profile) => profile.id === index.active_profile_id)) {
    index.active_profile_id = index.profiles[0].id
  }
  return index
}

function writeIndex(index) {
  paths.writeJson(paths.profilesRegistryPath(), index)
  return { active_profile_id: index.active_profile_id, profiles: index.profiles }
}

/** Slug that is safe as a directory name and unique within the index. */
function profileId(name, taken) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'profile'
  let candidate = base
  let suffix = 2
  while (taken.has(candidate)) candidate = `${base}-${suffix++}`
  return candidate
}

/** Projects and terminals a profile holds, read from its own projects.json. */
function profileCounts(id) {
  const stored = paths.readJson(path.join(paths.profileDir(id), 'projects.json'), null)
  if (!stored) return { project_count: 0, terminal_count: 0 }
  const projects = Array.isArray(stored.projects) ? stored.projects : []
  const terminals = projects.reduce(
    (total, project) => total + (project.terminals?.length ?? 0),
    0,
  )
  return { project_count: projects.length, terminal_count: terminals }
}

// ── process trees ───────────────────────────────────────────────────────────

/** Every descendant of `pid`, read from /proc — the same set the Rust side kills. */
function descendantsOf(pid) {
  const children = new Map()
  let entries = []
  try {
    entries = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return []
  }
  for (const entry of entries) {
    let stat = ''
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    // The comm field can contain spaces and parentheses; ppid is the field
    // right after the state that follows the closing one.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const parent = Number(after[1])
    if (!Number.isFinite(parent)) continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(Number(entry))
  }
  const found = []
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (found.includes(child)) continue
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function buildSystemCommands({ ptyHost, send }) {
  const ptyPid = async (ptyId) => {
    const list = await ptyHost.request('list_pty_processes', {}).catch(() => [])
    return list.find((entry) => entry.id === ptyId)?.pid ?? null
  }

  return {
    // ── profiles ──────────────────────────────────────────────────────────
    list_profile_summaries: () => {
      const index = readIndex()
      return index.profiles.map((profile) => ({
        ...profile,
        profile_image_url: '',
        ...profileCounts(profile.id),
        is_active: profile.id === index.active_profile_id,
      }))
    },
    set_active_profile: ({ profileId: id }) => {
      const index = readIndex()
      if (!index.profiles.some((profile) => profile.id === id)) {
        throw new Error(`unknown profile: ${id}`)
      }
      index.active_profile_id = id
      for (const profile of index.profiles) {
        if (profile.id === id) profile.last_used_at_ms = Date.now()
      }
      return writeIndex(index)
    },
    create_profile: ({ name }) => {
      const index = readIndex()
      const label = (name ?? '').trim() || `Profile ${index.profiles.length + 1}`
      const id = profileId(label, new Set(index.profiles.map((profile) => profile.id)))
      const now = Date.now()
      index.profiles.push({ id, name: label, created_at_ms: now, last_used_at_ms: now })
      paths.ensureDir(paths.profileDir(id))
      return writeIndex(index)
    },
    rename_profile: ({ profileId: id, name }) => {
      const index = readIndex()
      const profile = index.profiles.find((entry) => entry.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      const label = (name ?? '').trim()
      if (!label) throw new Error('a profile needs a name')
      profile.name = label
      return writeIndex(index)
    },
    delete_profile: ({ profileId: id }) => {
      const index = readIndex()
      if (index.profiles.length <= 1) throw new Error('the last profile cannot be deleted')
      index.profiles = index.profiles.filter((profile) => profile.id !== id)
      if (index.active_profile_id === id) index.active_profile_id = index.profiles[0].id
      try {
        fs.rmSync(paths.profileDir(id), { recursive: true, force: true })
      } catch {}
      return writeIndex(index)
    },

    // ── filesystem ────────────────────────────────────────────────────────
    delete_filesystem_entry: ({ path: target }) => {
      if (!target || target === os.homedir() || target === '/') {
        throw new Error(`refusing to delete ${target}`)
      }
      // To the trash rather than gone: this is reachable from a context menu.
      return shell.trashItem(target).catch(() => {
        fs.rmSync(target, { recursive: true, force: true })
      })
    },
    rename_filesystem_entry: ({ path: target, newName }) => {
      if (!newName || newName.includes('/') || newName.includes('\\')) {
        throw new Error(`invalid name: ${newName}`)
      }
      const renamed = path.join(path.dirname(target), newName)
      if (fs.existsSync(renamed)) throw new Error(`${newName} already exists`)
      fs.renameSync(target, renamed)
      return renamed
    },
    watch_file: ({ path: target }) => {
      if (watchers.has(target)) return null
      try {
        const watcher = fs.watch(target, { persistent: false }, () => {
          send(WATCH_EVENT, { path: target })
        })
        watcher.on('error', () => {})
        watchers.set(target, watcher)
      } catch {}
      return null
    },
    unwatch_file: ({ path: target }) => {
      watchers.get(target)?.close()
      watchers.delete(target)
      return null
    },

    // ── open in… ──────────────────────────────────────────────────────────
    open_in_vscode: async ({ path: target }) => {
      for (const binary of ['code', 'codium', 'code-insiders', 'cursor']) {
        try {
          await run('/bin/sh', ['-lc', `command -v ${binary}`])
          spawn('/bin/sh', ['-lc', `${binary} ${JSON.stringify(target)}`], {
            detached: true,
            stdio: 'ignore',
          }).unref()
          return null
        } catch {}
      }
      throw new Error('VS Code is not installed')
    },
    open_in_file_explorer: async ({ path: target }) => {
      const stat = fs.existsSync(target) ? fs.statSync(target) : null
      if (stat?.isDirectory()) await shell.openPath(target)
      else shell.showItemInFolder(target)
      return null
    },
    open_in_browser: async ({ target }) => {
      await shell.openExternal(target)
      return null
    },
    open_data_folder: async () => {
      const dir = paths.appLocalDataDir()
      paths.ensureDir(dir)
      await shell.openPath(dir)
      return null
    },
    open_logs_folder: async () => {
      const dir = paths.logsDir()
      paths.ensureDir(dir)
      await shell.openPath(dir)
      return null
    },
    open_spawn_log: async () => {
      const file = path.join(paths.logsDir(), 'spawn.log')
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      await shell.openPath(file)
      return null
    },
    export_logs: async ({ targetPath }) => {
      const dir = paths.logsDir()
      paths.ensureDir(dir)
      await run('zip', ['-r', '-q', targetPath, '.'], { cwd: dir })
      return null
    },

    // ── app lifecycle ─────────────────────────────────────────────────────
    quit_app: () => {
      app.quit()
      return null
    },
    reset_app_data: () => {
      // Clears the active profile's contents but keeps the app running, so the
      // window stays usable until the user relaunches.
      const dir = paths.profileDir(readIndex().active_profile_id)
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        try {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
        } catch {}
      }
      return null
    },
    wipe_all_app_data: () => {
      const root = paths.appLocalDataDir()
      for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        try {
          fs.rmSync(path.join(root, entry), { recursive: true, force: true })
        } catch {}
      }
      return null
    },

    // Windows job objects keep child processes from outliving the app; there is
    // no equivalent here, and the PTY host kills its own trees on exit.
    get_job_guard_status: () => process.platform === 'win32',

    // ── process trees ─────────────────────────────────────────────────────
    get_pty_tree_info: async ({ ptyId }) => {
      const rootPid = await ptyPid(ptyId)
      return {
        pty_id: ptyId,
        root_pid: rootPid,
        descendants: rootPid ? descendantsOf(rootPid) : [],
        alive: rootPid ? alive(rootPid) : false,
      }
    },
    kill_pty_tree_cmd: async ({ ptyId }) => {
      const rootPid = await ptyPid(ptyId)
      if (!rootPid) return []
      const killed = []
      // Children first, so nothing is reparented and left behind.
      for (const pid of [...descendantsOf(rootPid).reverse(), rootPid]) {
        try {
          process.kill(pid, 'SIGKILL')
          killed.push(pid)
        } catch {}
      }
      return killed
    },
  }
}

module.exports = { buildSystemCommands }
