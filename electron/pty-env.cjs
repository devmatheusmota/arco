// Environment a terminal must not inherit from the process that started the app.
//
// Two sources: the agent session Arco itself was launched from, and the AppImage
// mount the bundled build runs out of. Both are the launcher's business, not the
// pane's.

const path = require('node:path')

// Session markers an agent CLI sets for its own children.
//
// Launching the app from a terminal that already runs an agent — a pane of this
// very app, for instance — leaks these into every PTY it spawns. The agent then
// believes it is a child session, turns transcript saving off, and reuses the
// parent's session id. Panes are new sessions, not children, so the markers go.
//
// Only parentage is dropped. Install paths (CLAUDE_CODE_EXECPATH), plugin data
// (CLAUDE_PLUGIN_DATA) and the entrypoint tag stay: they describe where the CLI
// lives and how it was started, not which session spawned it, and removing them
// breaks plugins instead of fixing anything.

const INHERITED_SESSION_VARS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_COMPANION_SESSION_ID',
]

/** Copy of `env` without the markers that would make a pane look like a child session. */
function clearInheritedAgentSession(env) {
  const cleaned = { ...env }
  for (const key of INHERITED_SESSION_VARS) delete cleaned[key]
  return cleaned
}

// Variables an AppImage's `AppRun` exports so the bundled app finds its own
// runtime. They point into the mount (`$APPDIR`) and must never reach a pane:
// `PYTHONHOME` alone breaks every `python3` a pane runs ("Fatal Python error:
// Failed to import encodings module"), and `LD_LIBRARY_PATH` makes native
// binaries load the bundle's libraries instead of the system's.
//
// Any variable whose value mentions `$APPDIR` is rewritten: path lists keep
// their remaining entries, single-value variables go entirely. Some AppRun
// builds stash the pre-launch value in `<NAME>_ORIG`, which wins when present.
// No-op outside an AppImage, so ordinary builds keep the environment intact.

const APPIMAGE_OWN_VARS = ['APPDIR', 'APPIMAGE', 'APPIMAGE_UUID', 'ARGV0', 'OWD']

/** Value a child should see for a variable the AppImage rewrote, or `null` when
 * the variable only ever pointed into the mount and has to go entirely. */
function sanitizeAppImageValue(appdir, value) {
  const kept = value
    .split(path.delimiter)
    .filter((entry) => entry && !entry.startsWith(appdir))
    .join(path.delimiter)
  return kept || null
}

/** Copy of `env` with everything the AppImage mount owns rewritten or dropped. */
function stripAppImageEnv(env) {
  const appdir = env.APPDIR
  if (!appdir) return { ...env }

  const cleaned = { ...env }
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith('_ORIG') || typeof value !== 'string' || !value.includes(appdir)) continue
    const original = env[`${key}_ORIG`]
    if (original !== undefined) {
      cleaned[key] = original
      continue
    }
    const kept = sanitizeAppImageValue(appdir, value)
    if (kept === null) delete cleaned[key]
    else cleaned[key] = kept
  }
  for (const key of Object.keys(env)) if (key.endsWith('_ORIG')) delete cleaned[key]
  for (const key of APPIMAGE_OWN_VARS) delete cleaned[key]
  return cleaned
}

module.exports = {
  APPIMAGE_OWN_VARS,
  INHERITED_SESSION_VARS,
  clearInheritedAgentSession,
  stripAppImageEnv,
}
