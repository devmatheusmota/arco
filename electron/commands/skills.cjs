// Agent skills and plugins.
//
// Skills are directories holding a SKILL.md, one root per agent under the
// user's home; a skill shared between agents is a symlink into `~/.agents`.
// Plugins are manifests inside the active profile. Both mirror the Rust layout
// so either shell sees the same catalog.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const paths = require('./paths.cjs')

const SKILL_FILE = 'SKILL.md'
const CODEX_SYSTEM_MARKER = '.codex-system-skills.marker'
const MAX_TREE_DEPTH = 4
const MAX_TREE_CHILDREN = 100
const PLUGINS_DIR = 'plugins'
const MANIFEST_FILE = 'manifest.json'

const ROOTS = [
  ['claude', ['.claude', 'skills']],
  ['codex', ['.codex', 'skills']],
  ['opencode', ['.config', 'opencode', 'skill']],
  ['antigravity', ['.gemini', 'skills']],
  ['shared', ['.agents', 'skills']],
]

function skillsHome(segments) {
  return path.join(os.homedir(), ...segments)
}

function rootFor(agent) {
  const entry = ROOTS.find(([name]) => name === agent)
  return entry ? skillsHome(entry[1]) : null
}

function resolve(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function entryCount(dir) {
  try {
    return fs.readdirSync(dir).length
  } catch {
    return 0
  }
}

function readSkillFile(dir) {
  try {
    return fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8')
  } catch {
    return null
  }
}

/** Splits the leading `---` block from the body, tolerating its absence. */
function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { front: '', body: normalized }
  const rest = normalized.slice(4)
  const end = rest.indexOf('\n---')
  if (end === -1) return { front: '', body: normalized }
  return { front: rest.slice(0, end), body: rest.slice(end + 4).replace(/^\n/, '') }
}

/** `key: value` pairs, including folded and literal blocks. */
function parseFrontmatter(front) {
  const lines = front.split('\n')
  const out = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    index += 1
    if (!line.trim() || /^[ \t#-]/.test(line)) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const rest = line.slice(separator + 1).trim()
    if (rest === '' || rest.startsWith('>') || rest.startsWith('|')) {
      const block = []
      while (index < lines.length) {
        const next = lines[index]
        if (!next.trim()) {
          index += 1
          continue
        }
        if (!/^[ \t]/.test(next)) break
        block.push(next.trim())
        index += 1
      }
      out[key] = block.join(' ')
    } else {
      out[key] = rest.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

/** Codex ships system skills; a marker upwards from the directory says so. */
function hasBundledMarker(dir, root) {
  let current = dir
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(current, CODEX_SYSTEM_MARKER))) return true
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

function lockInfo(name) {
  const file = skillsHome(['.agents', '.skill-lock.json'])
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const entry = value?.skills?.[name]
  if (!entry) return null
  return {
    source: entry.source ?? null,
    sourceUrl: entry.sourceUrl ?? null,
    installedAt: entry.installedAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  }
}

function summarize(agent, root, dir, bundled) {
  const raw = readSkillFile(dir)
  if (raw === null) return null
  const { front } = splitFrontmatter(raw)
  const fields = parseFrontmatter(front)
  const resolved = resolve(dir)
  const sharedRoot = resolve(skillsHome(['.agents', 'skills']))
  return {
    name: path.basename(dir),
    agent,
    path: dir,
    resolved_path: resolved,
    description: fields.description ?? '',
    linked: isLink(dir),
    shared: resolved.startsWith(sharedRoot) && agent !== 'shared',
    bundled: bundled || hasBundledMarker(dir, root),
    entry_count: entryCount(dir),
  }
}

function collectRoot(agent, root) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    const directory = entry.isDirectory() || (entry.isSymbolicLink() && fs.existsSync(full))
    if (!directory) continue
    if (entry.name === '.system') {
      for (const nested of fs.readdirSync(full, { withFileTypes: true })) {
        if (!nested.isDirectory()) continue
        const summary = summarize(agent, root, path.join(full, nested.name), true)
        if (summary) out.push(summary)
      }
      continue
    }
    if (entry.name.startsWith('.')) continue
    const summary = summarize(agent, root, full, false)
    if (summary) out.push(summary)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function buildTree(dir, depth) {
  if (depth >= MAX_TREE_DEPTH) return []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  const truncated = sorted.length > MAX_TREE_CHILDREN
  return sorted.slice(0, MAX_TREE_CHILDREN).map((entry) => {
    const full = path.join(dir, entry.name)
    let size = 0
    try {
      size = entry.isFile() ? fs.statSync(full).size : 0
    } catch {}
    return {
      name: entry.name,
      path: full,
      isDir: entry.isDirectory(),
      size,
      children: entry.isDirectory() ? buildTree(full, depth + 1) : [],
      truncated,
    }
  })
}

function locate(agent, name) {
  const root = rootFor(agent)
  if (!root) throw new Error('unknown_agent')
  for (const candidate of [path.join(root, name), path.join(root, '.system', name)]) {
    if (fs.existsSync(candidate)) return { root, dir: candidate }
  }
  throw new Error('not_found')
}

// ── plugins ─────────────────────────────────────────────────────────────────

function activeProfileId() {
  return (
    paths.readJson(paths.profilesRegistryPath(), { active_profile_id: 'default' })
      .active_profile_id ?? 'default'
  )
}

function pluginsRoot() {
  return path.join(paths.profileDir(activeProfileId()), PLUGINS_DIR)
}

function validatePluginId(id) {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid_plugin_id')
}

function buildSkillsCommands() {
  return {
    skills_scan: () =>
      ROOTS.map(([agent, segments]) => {
        const root = skillsHome(segments)
        const exists = fs.existsSync(root) && fs.statSync(root).isDirectory()
        return { agent, root, exists, skills: exists ? collectRoot(agent, root) : [] }
      }),
    skills_detail: ({ agent, name }) => {
      const { root, dir } = locate(agent, name)
      const summary = summarize(agent, root, dir, false)
      if (!summary) throw new Error('not_found')
      const raw = readSkillFile(dir)
      if (raw === null) throw new Error('not_found')
      const { front, body } = splitFrontmatter(raw)
      return {
        summary,
        frontmatter: parseFrontmatter(front),
        frontmatterRaw: front,
        body,
        tree: buildTree(dir, 0),
        lock: lockInfo(summary.name),
      }
    },
    skills_uninstall: ({ agent, name }) => {
      const { root, dir } = locate(agent, name)
      const summary = summarize(agent, root, dir, false)
      if (!summary) throw new Error('not_found')
      if (summary.bundled) throw new Error('bundled_skill')
      if (summary.linked) {
        // Unlink, never follow: the shared copy other agents point at survives.
        try {
          fs.unlinkSync(dir)
        } catch (error) {
          throw new Error(`remove_failed:${error.message}`, { cause: error })
        }
        return { path: summary.path, removedLinkOnly: true, sharedCopyPath: summary.resolved_path }
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        throw new Error(`remove_failed:${error.message}`, { cause: error })
      }
      return { path: summary.path, removedLinkOnly: false, sharedCopyPath: null }
    },

    plugins_list: ({ kind }) => {
      const root = pluginsRoot()
      if (!fs.existsSync(root)) return []
      const manifests = []
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          manifests.push(
            JSON.parse(fs.readFileSync(path.join(root, entry.name, MANIFEST_FILE), 'utf8')),
          )
        } catch {}
      }
      return manifests
        .filter((manifest) => !kind || manifest.kind === kind)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    },
    plugin_install: ({ manifest }) => {
      validatePluginId(manifest?.id)
      if (!manifest.name?.trim()) throw new Error('invalid_plugin_name')
      const dir = path.join(pluginsRoot(), manifest.id)
      paths.ensureDir(dir)
      fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
      return null
    },
    plugin_uninstall: ({ id }) => {
      validatePluginId(id)
      fs.rmSync(path.join(pluginsRoot(), id), { recursive: true, force: true })
      return null
    },
  }
}

module.exports = { buildSkillsCommands }
