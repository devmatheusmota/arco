// Agent library, backup and Graphify.
//
// The agent library is markdown files under `<project>/.claude/agents`; backup
// is a zip of the profile directory; Graphify shells out to the CLI when the
// project has a graph. All three read and write exactly what the Rust backend
// does, so the two shells stay interchangeable.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const paths = require('./paths.cjs')

function agentsDir(folder) {
  return path.join(folder, '.claude', 'agents')
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message))
      else resolve(stdout)
    })
  })
}

const GRAPH_SUBDIR = 'graphify-out'
const GRAPH_FILE = 'graph.json'
const SNAPSHOTS_SUBDIR = 'graph-snapshots'
const MAX_VIZ_NODES = 3000

/** The worktree root for a path, so snapshots land beside the right graph. */
async function repositoryRoot(repo) {
  return run('git', ['rev-parse', '--show-toplevel'], { cwd: repo })
    .then((out) => out.trim())
    .catch(() => repo)
}

function snapshotsDir(root) {
  return path.join(root, '.arco', SNAPSHOTS_SUBDIR)
}

function snapshotFile(root, id) {
  if (!/^[0-9]+$/.test(String(id ?? ''))) throw new Error('invalid_snapshot_id')
  const file = path.join(snapshotsDir(root), `${id}.json`)
  if (!fs.existsSync(file)) throw new Error('snapshot_not_found')
  return file
}

function readGraph(file) {
  if (!fs.existsSync(file)) throw new Error('graph_not_found')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`invalid_graph_json:${error.message}`, { cause: error })
  }
}

/** Node and edge identity sets, for counting what a snapshot changed. */
function idSets(file) {
  const graph = readGraph(file)
  const nodes = new Set(
    (graph.nodes ?? []).map((node) => identifier(node?.id)).filter((id) => id !== null),
  )
  const edges = new Set(
    (graph.edges ?? graph.links ?? [])
      .map((edge) => {
        const source = identifier(edge?.source)
        const target = identifier(edge?.target)
        return source === null || target === null ? null : `${source}->${target}`
      })
      .filter(Boolean),
  )
  return { nodes, edges }
}

/** Graph files write ids as strings or numbers; both are the same identity. */
function identifier(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function buildLibraryCommands() {
  return {
    list_installed_agents: ({ folder }) => {
      if (!folder) return []
      let names
      try {
        names = fs.readdirSync(agentsDir(folder)).filter((name) => name.endsWith('.md'))
      } catch {
        return []
      }
      return names
        .map((name) => {
          const file = path.join(agentsDir(folder), name)
          let contents
          try {
            contents = fs.readFileSync(file, 'utf8')
          } catch {}
          return {
            name: path.basename(name, '.md'),
            from_arco: contents.includes('arco:'),
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    install_agent: ({ folder, name, contents }) => {
      if (!name || /[/\\.]/.test(name)) throw new Error(`nome de agent inválido: ${name}`)
      const dir = agentsDir(folder)
      paths.ensureDir(dir)
      fs.writeFileSync(path.join(dir, `${name}.md`), contents ?? '')
      return null
    },
    uninstall_agent: ({ folder, name }) => {
      if (!name || /[/\\.]/.test(name)) throw new Error(`nome de agent inválido: ${name}`)
      try {
        fs.unlinkSync(path.join(agentsDir(folder), `${name}.md`))
      } catch {}
      return null
    },
    list_agent_library: ({ folder }) => {
      if (!folder) return []
      try {
        return fs
          .readdirSync(agentsDir(folder))
          .filter((name) => name.endsWith('.md'))
          .map((name) => ({ name: path.basename(name, '.md') }))
      } catch {
        return []
      }
    },

    // ── backup: zip of the profile directory ─────────────────────────────
    export_backup: async ({ targetPath }) => {
      const root = paths.appLocalDataDir()
      await run('zip', ['-r', '-q', targetPath, '.'], { cwd: root })
      return null
    },
    export_profile_backup: async ({ profileId, targetPath }) => {
      const root = paths.profileDir(profileId)
      await run('zip', ['-r', '-q', targetPath, '.'], { cwd: root })
      return null
    },
    import_backup: async ({ sourcePath }) => {
      const root = paths.appLocalDataDir()
      paths.ensureDir(root)
      await run('unzip', ['-o', '-q', sourcePath, '-d', root])
      return null
    },

    // ── graphify ─────────────────────────────────────────────────────────
    graphify_status: ({ repo }) => {
      if (!repo) return { enabled: false }
      const graph = path.join(repo, 'graphify-out', 'graph.json')
      return { enabled: fs.existsSync(graph), graphPath: fs.existsSync(graph) ? graph : null }
    },
    graphify_ensure_graph: ({ repo }) => {
      if (!repo) return null
      const graph = path.join(repo, 'graphify-out', 'graph.json')
      if (fs.existsSync(graph)) return null
      // Indexing a large repository takes minutes. A pane must never wait on
      // it, so this is fire-and-forget: the graph appears when it appears.
      run('graphify', ['update', '.'], { cwd: repo }).catch(() => null)
      return null
    },
    graphify_mcp_config_path: ({ repo }) => {
      const config = path.join(repo ?? '', 'graphify-out', 'mcp-config.json')
      return fs.existsSync(config) ? config : null
    },

    // ── graph data and snapshots ─────────────────────────────────────────
    graphify_detect: async ({ command }) => {
      const binary = command || 'graphify'
      const version = await run('/bin/sh', ['-lc', `${binary} --version`])
        .then((out) => out.trim())
        .catch(() => null)
      return { available: version !== null, command: binary, version: version || undefined }
    },
    graphify_read_graph: async ({ repo }) => {
      const root = await repositoryRoot(repo)
      const graph = readGraph(path.join(root, GRAPH_SUBDIR, GRAPH_FILE))
      const nodeValues = Array.isArray(graph.nodes) ? graph.nodes : []
      const edgeValues = Array.isArray(graph.edges)
        ? graph.edges
        : Array.isArray(graph.links)
          ? graph.links
          : []
      const kept = new Set()
      const nodes = []
      for (const node of nodeValues.slice(0, MAX_VIZ_NODES)) {
        const id = identifier(node?.id)
        if (id === null) continue
        kept.add(id)
        nodes.push({
          id,
          label: firstString(node, ['label', 'name', 'title']) ?? id,
          kind: firstString(node, ['type', 'kind', 'category']),
          group: firstString(node, ['group', 'community', 'module']),
        })
      }
      const edges = []
      for (const edge of edgeValues) {
        const source = identifier(edge?.source)
        const target = identifier(edge?.target)
        if (source === null || target === null) continue
        if (!kept.has(source) || !kept.has(target)) continue
        edges.push({
          id: identifier(edge?.id) ?? `${source}->${target}`,
          source,
          target,
          label: firstString(edge, ['label', 'relation', 'type']),
        })
      }
      return {
        nodes,
        edges,
        nodeCount: nodeValues.length,
        edgeCount: edgeValues.length,
        truncated: nodeValues.length > MAX_VIZ_NODES,
      }
    },
    graphify_snapshot: async ({ repo }) => {
      const root = await repositoryRoot(repo)
      const source = path.join(root, GRAPH_SUBDIR, GRAPH_FILE)
      if (!fs.existsSync(source)) throw new Error('graph_not_found')
      const dir = snapshotsDir(root)
      paths.ensureDir(dir)
      const id = String(Date.now())
      const target = path.join(dir, `${id}.json`)
      fs.copyFileSync(source, target)
      return {
        id,
        path: target,
        createdMs: Number(id),
        sizeBytes: fs.statSync(target).size,
      }
    },
    graphify_list_snapshots: async ({ repo }) => {
      const dir = snapshotsDir(await repositoryRoot(repo))
      if (!fs.existsSync(dir)) return []
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const full = path.join(dir, name)
          const id = path.basename(name, '.json')
          return {
            id,
            path: full,
            createdMs: Number(id) || fs.statSync(full).mtimeMs,
            sizeBytes: fs.statSync(full).size,
          }
        })
        .sort((a, b) => b.createdMs - a.createdMs)
    },
    graphify_diff_snapshot: async ({ repo, baseId, targetId }) => {
      const root = await repositoryRoot(repo)
      const base = idSets(snapshotFile(root, baseId))
      const compare = targetId
        ? idSets(snapshotFile(root, targetId))
        : idSets(path.join(root, GRAPH_SUBDIR, GRAPH_FILE))
      const missing = (from, other) => [...from].filter((id) => !other.has(id)).length
      return {
        nodesAdded: missing(compare.nodes, base.nodes),
        nodesRemoved: missing(base.nodes, compare.nodes),
        edgesAdded: missing(compare.edges, base.edges),
        edgesRemoved: missing(base.edges, compare.edges),
      }
    },
    graphify_rollback: async ({ repo, snapshotId }) => {
      const root = await repositoryRoot(repo)
      const source = snapshotFile(root, snapshotId)
      const target = path.join(root, GRAPH_SUBDIR, GRAPH_FILE)
      paths.ensureDir(path.dirname(target))
      // Through a temporary file, so a torn copy never becomes the live graph.
      const temporary = `${target}.tmp`
      fs.copyFileSync(source, temporary)
      fs.renameSync(temporary, target)
      return null
    },
    graphify_prune_snapshots: async ({ repo, keepLast, maxAgeDays }) => {
      const dir = snapshotsDir(await repositoryRoot(repo))
      if (!fs.existsSync(dir)) return null
      const entries = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({ name, createdMs: Number(path.basename(name, '.json')) || 0 }))
        .sort((a, b) => b.createdMs - a.createdMs)
      const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : null
      entries.forEach((entry, index) => {
        const tooOld = cutoff !== null && entry.createdMs < cutoff
        const beyondKeep = keepLast != null && index >= keepLast
        if (tooOld || beyondKeep) {
          try {
            fs.unlinkSync(path.join(dir, entry.name))
          } catch {}
        }
      })
      return null
    },

    probe_install_toolchain: async () => {
      const has = async (command) =>
        run('/bin/sh', ['-lc', `command -v ${command}`])
          .then(() => true)
          .catch(() => false)
      const [npm, bun, brew] = await Promise.all([has('npm'), has('bun'), has('brew')])
      return { npm, bun, brew }
    },
    agent_cli_version: async ({ agent }) => {
      const out = await run('/bin/sh', ['-lc', `${agent} --version`]).catch(() => '')
      return out.trim() || null
    },

    list_skills: ({ folder }) => {
      const dir = path.join(folder ?? os.homedir(), '.claude', 'skills')
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
      } catch {
        return []
      }
    },
  }
}

module.exports = { buildLibraryCommands }
