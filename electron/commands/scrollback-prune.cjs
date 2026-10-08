// Removes the scrollback records no pane will ever replay.
//
// The PTY host writes one file per terminal and nothing ever deleted them: a
// closed pane, a restarted one (it gets a new id) and every agent worker left
// its record behind, hundreds of files a few months in. A record is kept while
// any profile still points a tab at it, while its terminal is running, and for
// a week after it was last written, so a pane closed by mistake and reopened
// from history still finds its output.

const fs = require('node:fs')
const path = require('node:path')

const KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Every terminal id a tab of any profile points at, or `null` when a profile's
 * document exists and cannot be read: that is not proof its panes are gone.
 */
async function referencedPtyIds(profilesDir) {
  const ids = new Set()
  let profiles
  try {
    profiles = await fs.promises.readdir(profilesDir)
  } catch {
    return null
  }
  for (const profile of profiles) {
    let raw
    try {
      raw = await fs.promises.readFile(path.join(profilesDir, profile, 'projects.json'), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      return null
    }
    let document
    try {
      document = JSON.parse(raw)
    } catch {
      return null
    }
    for (const project of document?.projects ?? []) {
      for (const terminal of project?.terminals ?? []) {
        for (const tab of terminal?.tabs ?? []) {
          if (typeof tab?.ptyId === 'string' && tab.ptyId) ids.add(tab.ptyId)
        }
      }
    }
  }
  return ids
}

/** Deletes the records in `dir` that nothing references. Returns how many went. */
async function pruneScrollback({ dir, profilesDir, liveIds = [], now = Date.now() }) {
  let names
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return 0
  }
  const keep = await referencedPtyIds(profilesDir)
  if (!keep || keep.size === 0) return 0
  for (const id of liveIds) keep.add(id)
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.bin') && !name.endsWith('.bin.tmp')) continue
    const id = name.slice(0, name.indexOf('.bin'))
    if (keep.has(id)) continue
    const file = path.join(dir, name)
    try {
      const stats = await fs.promises.stat(file)
      if (now - stats.mtimeMs < KEEP_FOR_MS) continue
      await fs.promises.unlink(file)
      removed += 1
    } catch {}
  }
  return removed
}

module.exports = { pruneScrollback, referencedPtyIds }
