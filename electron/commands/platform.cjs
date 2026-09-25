// The remaining platform surface: MCP capability and health, GitHub sync, the
// `arco` CLI shim, economy agents, provider models, contract checks and health
// probes.
//
// Everything here reads and writes the same files and endpoints the Rust
// backend does, so a machine can switch between the two shells and see the same
// state.

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const githubSync = require('./github-sync.cjs')
const paths = require('./paths.cjs')

const SHIM_DIR = path.join(os.homedir(), '.local', 'bin')
const SHIM_PATH = path.join(SHIM_DIR, 'arco')
const SHIM_MARKER = '# arco-cli-shim'

/**
 * The first words the shim hands to the app instead of reading as a directory.
 *
 * Listed in the shim itself, so a subcommand added after it was installed does
 * not reach the app: `arco project` came back as "diretorio nao encontrado:
 * project" until the shim was written again. `shimStatus` compares this line to
 * catch that, the same way it catches a shim pointing at an old binary.
 */
const SHIM_ROUTED = 'session|group|todo|project|help|--help|-h|version|--version|-v'

// ── MCP ─────────────────────────────────────────────────────────────────────

/** What each agent's MCP implementation supports, mirroring the Rust table. */
const MCP_CAPABILITIES = [
  {
    agent: 'claude',
    projectScope: true,
    enabledFlag: true,
    envPassthrough: true,
    timeouts: true,
    headers: true,
    remote: true,
  },
  {
    agent: 'codex',
    projectScope: true,
    enabledFlag: false,
    envPassthrough: true,
    timeouts: false,
    headers: false,
    remote: false,
  },
  {
    agent: 'opencode',
    projectScope: true,
    enabledFlag: true,
    envPassthrough: true,
    timeouts: false,
    headers: false,
    remote: true,
  },
]

/**
 * Health of each configured server.
 *
 * A stdio server is probed by starting it and seeing whether it survives its
 * first second and answers an `initialize`; an HTTP one by reaching its URL.
 * Anything else is reported unknown rather than guessed.
 */
async function checkServer(server) {
  if (server.url) {
    try {
      const response = await fetch(server.url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(4000),
      })
      return { name: server.name, status: response.ok ? 'ok' : 'error' }
    } catch {
      return { name: server.name, status: 'error' }
    }
  }
  if (!server.command) return { name: server.name, status: 'unknown' }
  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ name: server.name, status })
    }
    const child = spawn(server.command, server.args ?? [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(server.env ?? {}) },
    })
    child.on('error', () => finish('error'))
    child.stdout.on('data', () => finish('ok'))
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'arco' } },
      })}\n`,
    )
    setTimeout(() => finish(child.exitCode === null ? 'ok' : 'error'), 3000)
  })
}

// ── CLI shim ────────────────────────────────────────────────────────────────

/**
 * Path the shim should call.
 *
 * Inside an AppImage `process.execPath` points at that run's temporary mount,
 * which is gone by the time the shim runs again — `APPIMAGE` is the stable path
 * to the file the user actually keeps.
 */
function appBinary() {
  return process.env.APPIMAGE || process.execPath
}

/**
 * How the shim invokes the app, as a shell command.
 *
 * Running from source, `process.execPath` is Electron itself and knows nothing
 * about this app until it is handed the entry point — so a shim installed from
 * a development run used to point at a binary that opens an empty window. That
 * is the run whose commands differ most from the installed build, which makes
 * it exactly the one worth being able to reach.
 */
function appCommand() {
  let packaged = true
  let appPath = ''
  try {
    const { app } = require('electron')
    packaged = app.isPackaged
    appPath = app.getAppPath()
  } catch {}
  if (packaged) return `"${appBinary()}"`
  return `"${appBinary()}" --no-sandbox "${path.join(appPath, 'electron', 'main.cjs')}"`
}

function shimScript() {
  return `#!/bin/sh
${SHIM_MARKER}
# arco — abre diretorios e comanda o Arco a partir do terminal.
#
# Gerado automaticamente pelo Arco (Configuracoes > Integracoes > Comando de
# terminal). Nao edite a mao: reinstale por la, principalmente depois de mover
# ou reinstalar o app.
#
# arco                        -> abre o diretorio atual
# arco ~/projeto              -> abre o diretorio informado
#
# arco session [opcoes]       -> cria uma sessao de agente
#     --agent claude|codex|opencode|shell   (padrao: claude)
#     --project <nome>        projeto alvo; sem isso, deduz pelo diretorio atual
#     --name <rotulo>         nome do pane
#     --prompt <texto>        texto enviado ao agente ao abrir
#     --worktree              forca worktree nova
#     --no-worktree           forca a mesma arvore
#                             sem nenhum dos dois, segue o padrao do projeto
#
# arco session list [--json]  -> lista as sessoes abertas
# arco session send <ref> <texto>  -> manda texto para um pane ja aberto
# arco session rename <nome> [--session <id>]  -> renomeia a sessao
#
# arco group list [--json]     -> lista as frentes de trabalho
# arco group close <ref>       -> fecha a frente e a worktree dela
#
# arco todo list [--json]     -> lista as tarefas
# arco todo show <ref>        -> mostra uma tarefa inteira
# arco todo add <titulo> [--project <nome>] [--tag <tag>]... [--status <status>]
#                    [--priority <nivel>] [--notes <texto>] [--ado <url|id>]
# arco todo edit <ref> [--title|--tag|--add-tag|--remove-tag|--status|--ado|...]
# arco todo status <ref> <status>
# arco todo delete <ref> [--yes]
#
# arco project list [--json]  -> lista os projetos e o diretorio de cada um
# arco project add [<nome>] --cwd <dir>  -> cria um projeto para o diretorio
#
# arco --version              -> versao do app
#
# "arco help" lista todas as opcoes.
#
# Os subcomandos exigem o app aberto: falam com o listener local dele.

set -e

# Os subcomandos vivem no binario do app: uma implementacao so, que responde
# igual com ou sem este atalho. Aqui eles sao apenas repassados.
case "\${1:-}" in
  ${SHIM_ROUTED})
    exec ${appCommand()} "$@"
    ;;
esac

target=\${1:-.}

if [ ! -d "$target" ]; then
  echo "arco: diretorio nao encontrado: $target" >&2
  exit 1
fi

# Caminho absoluto: o app compara com o cwd salvo dos projetos.
target=$(cd "$target" && pwd)

exec ${appCommand()} --open-path "$target"
`
}

/**
 * Another `arco` that PATH reaches before the shim, if there is one.
 *
 * Being installed and on PATH is not enough: a package-managed `arco` in
 * `/usr/bin` is found first, and it is a different build that answers to a
 * different set of subcommands. Everything still appears to work — the old
 * binary talks to the running app over HTTP — while the commands this version
 * added come back as unknown options and the ones it changed behave the way
 * they used to. Nothing in the app said so, because nothing looked.
 *
 * Unless that `arco` is this very app: the .deb links `/usr/bin/arco` to the
 * binary it installs, and running it is running this build, which answers
 * exactly as the shim would.
 */
function shadowingShim() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (path.resolve(dir) === path.resolve(SHIM_DIR)) return null
    const candidate = path.join(dir, 'arco')
    try {
      const contents = fs.readFileSync(candidate, 'utf8')
      if (contents.includes(SHIM_MARKER)) continue
    } catch {
      // Not readable as text: a real binary, which is exactly the case that
      // shadows the shim.
    }
    if (fs.existsSync(candidate)) return isThisApp(candidate) ? null : candidate
  }
  return null
}

/** Whether `candidate` resolves to the binary this app runs from. */
function isThisApp(candidate) {
  try {
    return fs.realpathSync(candidate) === fs.realpathSync(appBinary())
  } catch {
    return false
  }
}

function shimStatus() {
  let installed = false
  let stale = false
  try {
    const contents = fs.readFileSync(SHIM_PATH, 'utf8')
    installed = contents.includes(SHIM_MARKER)
    stale =
      installed && (!contents.includes(appCommand()) || !contents.includes(`  ${SHIM_ROUTED})`))
  } catch {}
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(SHIM_DIR)
  return {
    supported: true,
    installed,
    stale,
    path: installed ? SHIM_PATH : null,
    bin_dir: SHIM_DIR,
    on_path: onPath,
    shadowed_by: shadowingShim(),
  }
}

// ── economy agents ──────────────────────────────────────────────────────────

/** Agents the project marks as economy mode, stored beside the project. */
function economyFile(folder) {
  return path.join(folder ?? os.homedir(), '.arco', 'economy-agents.json')
}

function buildPlatformCommands() {
  return {
    mcp_capabilities: () => MCP_CAPABILITIES,
    mcp_health_check: async ({ agent }) => {
      const { readServers } = require('./extras.cjs')
      const servers = readServers().filter((server) => !agent || server.agent === agent)
      return Promise.all(servers.map(checkServer))
    },
    mcp_registry_search: async ({ query, page }) => {
      try {
        const url = new URL('https://api.github.com/search/repositories')
        url.searchParams.set('q', `${query ?? ''} mcp server in:name,description`)
        url.searchParams.set('per_page', '20')
        url.searchParams.set('page', String(page ?? 1))
        const response = await fetch(url, { headers: { 'User-Agent': 'arco' } })
        if (!response.ok) return { items: [], total: 0, page: page ?? 1 }
        const body = await response.json()
        return {
          items: (body.items ?? []).map((item) => ({
            name: item.name,
            description: item.description ?? '',
            url: item.html_url,
            stars: item.stargazers_count ?? 0,
          })),
          total: body.total_count ?? 0,
          page: page ?? 1,
        }
      } catch {
        return { items: [], total: 0, page: page ?? 1 }
      }
    },

    github_sync_status: () => githubSync.status(),
    github_sync_set_token: async ({ token }) => {
      const login = await githubSync.githubUser(token)
      return githubSync.setToken(token, login)
    },
    github_sync_logout: () => githubSync.logout(),
    github_sync_set_auto: ({ enabled, minutes }) => githubSync.setAuto({ enabled, minutes }),

    cli_shim_status: () => shimStatus(),
    cli_shim_install: () => {
      paths.ensureDir(SHIM_DIR)
      fs.writeFileSync(SHIM_PATH, shimScript(), { mode: 0o755 })
      return shimStatus()
    },
    cli_shim_uninstall: () => {
      try {
        if (fs.readFileSync(SHIM_PATH, 'utf8').includes(SHIM_MARKER)) fs.unlinkSync(SHIM_PATH)
      } catch {}
      return shimStatus()
    },

    economy_agents_enabled: ({ folder }) => {
      const stored = paths.readJson(economyFile(folder), { agents: [] })
      return (stored.agents ?? []).length > 0
    },
    set_economy_agents: ({ folder, enabled }) => {
      const agents = enabled ? ['claude', 'codex', 'opencode'] : []
      paths.writeJson(economyFile(folder), { agents })
      return agents
    },

    /** Models a provider actually offers, asked of the provider itself. */
    discover_provider_models: async ({ provider }) => {
      const endpoints = {
        anthropic: {
          url: 'https://api.anthropic.com/v1/models',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
            'anthropic-version': '2023-06-01',
          },
          pick: (body) => (body.data ?? []).map((model) => ({ id: model.id, name: model.id })),
        },
        openai: {
          url: 'https://api.openai.com/v1/models',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
          pick: (body) => (body.data ?? []).map((model) => ({ id: model.id, name: model.id })),
        },
      }
      const config = endpoints[provider]
      if (!config) return []
      try {
        const response = await fetch(config.url, { headers: config.headers })
        if (!response.ok) return []
        return config.pick(await response.json())
      } catch {
        return []
      }
    },

    /** Warns about env vars a compose/env file declares but does not define. */
    contract_check: ({ envPath }) => {
      if (!envPath) return []
      let contents
      try {
        contents = fs.readFileSync(envPath, 'utf8')
      } catch {
        return [{ level: 'error', message: `cannot read ${envPath}` }]
      }
      const warnings = []
      for (const [index, line] of contents.split('\n').entries()) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const [key, ...rest] = trimmed.split('=')
        const value = rest.join('=')
        if (!key.trim()) continue
        if (value.trim() === '') {
          warnings.push({ level: 'warning', message: `${key.trim()} is empty (line ${index + 1})` })
        }
      }
      return warnings
    },

    /** Starts a command and reports whether its port answers before the timeout. */
    health_probe: async ({ startCommand, path: probePath, timeoutMs }) => {
      const deadline = Date.now() + (timeoutMs ?? 15_000)
      const port = Number((probePath ?? '').match(/:(\d+)/)?.[1] ?? 0)
      if (!port) return { ok: false, detail: 'no port in path' }
      if (startCommand) {
        spawn('/bin/sh', ['-lc', startCommand], { stdio: 'ignore', detached: true }).unref()
      }
      while (Date.now() < deadline) {
        const reachable = await new Promise((resolve) => {
          const socket = net.connect({ port, host: '127.0.0.1' }, () => {
            socket.destroy()
            resolve(true)
          })
          socket.on('error', () => resolve(false))
          socket.setTimeout(1000, () => {
            socket.destroy()
            resolve(false)
          })
        })
        if (reachable) return { ok: true, detail: `port ${port} answered` }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return { ok: false, detail: `port ${port} did not answer` }
    },
  }
}

module.exports = { buildPlatformCommands }
