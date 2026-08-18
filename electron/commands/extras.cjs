// The rest of the surface, in the order the app asks for it.
//
// MCP configuration is read and written straight from the JSON files the agent
// CLIs use, so what the panel shows matches what the agents load. The remaining
// entries answer with an empty-but-valid shape: the feature reads as "nothing
// here" instead of erroring while the port continues.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { clipboard } = require('electron')

const MCP_CONFIG_FILES = [
  { agent: 'claude', file: path.join(os.homedir(), '.claude.json'), key: 'mcpServers' },
  {
    agent: 'claude',
    file: path.join(os.homedir(), '.claude', 'settings.json'),
    key: 'mcpServers',
  },
  { agent: 'codex', file: path.join(os.homedir(), '.codex', 'config.toml'), key: null },
]

function readServers() {
  const servers = []
  for (const source of MCP_CONFIG_FILES) {
    if (!source.key) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(source.file, 'utf8'))
      const entries = parsed?.[source.key] ?? {}
      for (const [name, value] of Object.entries(entries)) {
        servers.push({
          name,
          agent: source.agent,
          scope: 'user',
          transport: value?.type ?? (value?.url ? 'http' : 'stdio'),
          command: value?.command ?? null,
          args: value?.args ?? [],
          url: value?.url ?? null,
          env: value?.env ?? {},
          enabled: value?.disabled !== true,
          source: source.file,
        })
      }
    } catch {}
  }
  return servers
}

function readClaudeConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeClaudeConfig(file, parsed, name) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2))
  fs.renameSync(tmp, file)
  return { changed: [name], errors: [] }
}

function writeServer(name, config) {
  const file = path.join(os.homedir(), '.claude.json')
  const parsed = readClaudeConfig(file)
  parsed.mcpServers = parsed.mcpServers ?? {}
  if (config) parsed.mcpServers[name] = config
  else delete parsed.mcpServers[name]
  return writeClaudeConfig(file, parsed, name)
}

function buildExtraCommands() {
  const none = () => null
  const empty = () => []

  return {
    // ── MCP ──────────────────────────────────────────────────────────────
    mcp_scan: () => ({ servers: readServers(), errors: [] }),
    mcp_config_paths: () => MCP_CONFIG_FILES.map((entry) => entry.file),
    // Writes go to the same file the CLI reads, so a server added here shows up
    // in the agent's next session.
    mcp_upsert: ({ name, config }) => writeServer(name, config),
    mcp_remove: ({ name }) => writeServer(name, null),
    mcp_set_enabled: ({ name, enabled }) => {
      const file = path.join(os.homedir(), '.claude.json')
      const parsed = readClaudeConfig(file)
      const entry = parsed.mcpServers?.[name]
      if (!entry) return { changed: [], errors: [`server not found: ${name}`] }
      entry.disabled = !enabled
      return writeClaudeConfig(file, parsed, name)
    },
    mcp_sync: () => ({ changed: [], errors: [] }),
    mcp_reveal_env: () => ({}),

    // ── agent installation ───────────────────────────────────────────────

    // ── backup ───────────────────────────────────────────────────────────

    // ── graphify / planning / scheduler / handoff ────────────────────────
    graphify_codex_config_write: none,
    graphify_opencode_config_write: none,
    ai_memory_detect: () => ({ installed: false }),
    ai_memory_mcp_config_path: none,
    ai_memory_codex_config_write: none,
    ai_memory_opencode_config_write: none,
    gsd_opencode_plugin_write: none,
    start_gsd_watcher: none,
    stop_gsd_watcher: none,
    publish_event: none,
    scheduler_list: empty,
    handoff_prepare: none,

    // ── github ───────────────────────────────────────────────────────────

    // ── clipboard ────────────────────────────────────────────────────────
    // An image on the clipboard is written to a temp file and reported as a
    // path, which is what a terminal can actually receive.
    read_clipboard_payload: () => {
      const text = clipboard.readText()
      if (text) return { kind: 'text', text }
      const image = clipboard.readImage()
      if (!image.isEmpty()) {
        const file = path.join(os.tmpdir(), `arco-clipboard-img-${Date.now()}.png`)
        try {
          fs.writeFileSync(file, image.toPNG())
          return { kind: 'image', path: file }
        } catch {}
      }
      return { kind: 'empty' }
    },
    read_clipboard_text: () => clipboard.readText(),
    write_clipboard_text: ({ text }) => {
      clipboard.writeText(text ?? '')
      return null
    },
  }
}

module.exports = { buildExtraCommands, readServers }
