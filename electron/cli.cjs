// Terminal subcommands, handled by the binary itself.
//
// These used to live only in the shell shim the app installs under
// ~/.local/bin. When that file is missing — never installed, or removed while
// cleaning up an old install — `arco todo` reached the binary instead, which
// knew nothing about it and fell through to "open a window", so the command
// hung instead of answering.
//
// Handled here, before Electron starts, the binary answers the same way the
// shim does and exits. The shim stays: it is what puts `arco` on PATH.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SETTINGS_FILE = path.join(os.tmpdir(), 'arco-agent-hooks.json')

/**
 * Writes and exits without losing the output.
 *
 * `process.stdout.write` is asynchronous when stdout is a pipe, and
 * `process.exit` drops whatever is still buffered — so the command printed
 * nothing at all when its output was captured, while looking fine in a
 * terminal. Writing straight to the file descriptor is synchronous either way.
 */
function writeOut(text) {
  fs.writeSync(1, text)
}

function writeErr(text) {
  fs.writeSync(2, text)
}

const USAGE = `arco — abre diretorios e comanda o Arco a partir do terminal.

  arco                        abre o diretorio atual
  arco <caminho>              abre o diretorio informado

  arco session [opcoes]       cria uma sessao de agente
      --agent claude|codex|opencode|shell   (padrao: claude)
      --project <nome>        projeto alvo; sem isso, deduz pelo diretorio atual
      --name <rotulo>         nome do pane
      --prompt <texto>        texto enviado ao agente ao abrir
      --worktree              forca worktree nova
      --no-worktree           forca a mesma arvore

  arco todo <titulo> [--project <nome>] [--tag <tag>]... [--status <status>]
                    [--priority <nivel>] [--notes <texto>] [--ado <url|id>]
  arco todo list [--json] [--status <status>]
      lista as tarefas; sem --json sai em tabela com id curto

  arco todo edit <ref> [opcoes]   edita uma tarefa existente
      --title <texto>         novo titulo
      --tag <tag>...          substitui as tags
      --add-tag <tag>...      acrescenta tags
      --remove-tag <tag>...   remove tags
      --status <status>       todo | in-progress | review | done
      --priority <nivel>      high | normal | low
      --notes <texto>         substitui as notas
      --append-notes <texto>  adiciona ao final das notas, separadas por linha em branco
      --project <nome>        move a tarefa de projeto
      --ado <url|id>          liga a um work item ou PR do Azure DevOps
      --clear-ado             remove a ligacao com o Azure DevOps

  arco todo status <ref> <status>   atalho para --status

<ref> e o id (inteiro ou o prefixo que aparece em "arco todo list") ou um
trecho do titulo, desde que so uma tarefa corresponda.

Os subcomandos exigem o app aberto: falam com o listener local dele.`

/** Endpoint and token come from the file the hook listener writes when it binds. */
function listener() {
  let settings
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    throw new Error(`o app nao esta rodando (sem ${SETTINGS_FILE})`)
  }
  const hook = settings.hooks?.SubagentStart?.[0]?.hooks?.[0]
  const token = hook?.headers?.['X-Arco-Token']
  if (!hook?.url || !token) throw new Error(`nao consegui ler endpoint/token em ${SETTINGS_FILE}`)
  return { base: hook.url.replace(/\/hook$/, ''), token }
}

async function post(route, payload) {
  const { base, token } = listener()
  let response
  try {
    response = await fetch(`${base}/cli/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Arco-Token': token },
      body: JSON.stringify(payload ?? {}),
    })
  } catch {
    throw new Error('falha ao falar com o app')
  }
  if (!response.ok) throw new Error(`o app respondeu ${response.status}`)
  return response
}

/** Options first, everything else joined as the title — the shim's rules. */
function parseTodo(args) {
  const tags = []
  const words = []
  let project = null
  let status = null
  let priority = null
  let notes = null
  let adoRefInput = null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--project') project = args[++index]
    else if (args[index] === '--tag') tags.push(args[++index])
    else if (args[index] === '--status') status = args[++index]
    else if (args[index] === '--priority') priority = args[++index]
    else if (args[index] === '--notes') notes = args[++index]
    else if (args[index] === '--ado') adoRefInput = args[++index]
    else words.push(args[index])
  }
  return {
    title: words.join(' '),
    tags: tags.filter(Boolean),
    project,
    status,
    priority,
    notes,
    adoRefInput,
  }
}

/**
 * `arco todo edit <ref> [flags]`.
 *
 * Only the flags that appear are sent, so an edit never clears a field it was
 * not asked about — the difference between renaming a task and wiping its notes.
 */
function parseTodoEdit(args) {
  const [ref, ...rest] = args
  const payload = { ref: ref ?? '' }
  const push = (key, value) => {
    if (!value) return
    payload[key] = [...(payload[key] ?? []), value]
  }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--title') payload.title = rest[++index]
    else if (flag === '--tag') push('tags', rest[++index])
    else if (flag === '--add-tag') push('addTags', rest[++index])
    else if (flag === '--remove-tag') push('removeTags', rest[++index])
    else if (flag === '--status') payload.status = rest[++index]
    else if (flag === '--priority') payload.priority = rest[++index]
    else if (flag === '--notes') payload.notes = rest[++index]
    else if (flag === '--append-notes') payload.appendNotes = rest[++index]
    else if (flag === '--project') payload.project = rest[++index]
    else if (flag === '--ado') payload.adoRefInput = rest[++index]
    else if (flag === '--clear-ado') payload.clearAdoRef = true
    else throw new Error(`arco todo edit: opcao desconhecida: ${flag}`)
  }
  if (!payload.ref) throw new Error('arco todo edit: informe a tarefa (id ou trecho do titulo)')
  if (Object.keys(payload).length === 1) throw new Error('arco todo edit: informe o que mudar')
  return payload
}

const STATUS_LABEL = {
  todo: 'todo',
  in_progress: 'in-progress',
  review: 'review',
  done: 'done',
}

/** Status as stored, so `--status` on the app side sees the same word it prints. */
function statusOf(todo) {
  if (todo.completed) return 'done'
  return STATUS_LABEL[todo.status] ? todo.status : 'todo'
}

/** Table with the short id `arco todo edit` takes, so a listing is directly actionable. */
function formatTodoTable(todos) {
  if (todos.length === 0) return 'nenhuma tarefa\n'
  const rows = todos.map((todo) => ({
    id: String(todo.id ?? '').slice(0, 8),
    status: STATUS_LABEL[statusOf(todo)],
    title: String(todo.title ?? ''),
    tags: (todo.tags ?? []).map((tag) => `#${tag}`).join(' '),
  }))
  const width = (key) => Math.max(...rows.map((row) => row[key].length))
  const idWidth = width('id')
  const statusWidth = width('status')
  return `${rows
    .map(
      (row) =>
        `${row.id.padEnd(idWidth)}  ${row.status.padEnd(statusWidth)}  ${row.title}${
          row.tags ? `  ${row.tags}` : ''
        }`,
    )
    .join('\n')}\n`
}

function parseSession(args) {
  const payload = { agent: 'claude', cwd: process.cwd(), worktree: 'inherit' }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--agent') payload.agent = args[++index]
    else if (flag === '--project') payload.project = args[++index]
    else if (flag === '--name') payload.name = args[++index]
    else if (flag === '--prompt') payload.prompt = args[++index]
    else if (flag === '--worktree') payload.worktree = 'new'
    else if (flag === '--no-worktree') payload.worktree = 'none'
    else throw new Error(`arco session: opcao desconhecida: ${flag}`)
  }
  return payload
}

async function run(argv) {
  const [command, ...rest] = argv

  if (command === 'todo') {
    if (rest[0] === 'list') {
      const wantsJson = rest.includes('--json')
      const statusIndex = rest.indexOf('--status')
      const wantedStatus = statusIndex === -1 ? null : rest[statusIndex + 1]
      const response = await post('todo/list')
      const todos = await response.json()
      const filtered = wantedStatus
        ? todos.filter((todo) => statusOf(todo) === wantedStatus.replace(/-/g, '_'))
        : todos
      writeOut(wantsJson ? `${JSON.stringify(filtered)}\n` : formatTodoTable(filtered))
      return
    }

    if (rest[0] === 'edit') {
      await post('todo/edit', parseTodoEdit(rest.slice(1)))
      return
    }

    if (rest[0] === 'status') {
      const [, ref, status] = rest
      if (!ref || !status) throw new Error('arco todo status: informe a tarefa e o status')
      await post('todo/edit', { ref, status })
      return
    }

    const { title, tags, project, status, priority, notes, adoRefInput } = parseTodo(rest)
    if (!title) throw new Error('arco todo: informe um titulo')
    await post('todo', {
      title,
      tags,
      ...(project ? { project } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(notes !== null ? { notes } : {}),
      ...(adoRefInput ? { adoRefInput } : {}),
    })
    return
  }

  if (command === 'session') {
    await post('session', parseSession(rest))
    return
  }

  throw new Error(`arco: subcomando desconhecido: ${command}`)
}

const HANDLED = new Set(['todo', 'session'])
const HELP = new Set(['--help', '-h', 'help'])

/**
 * Finds where the user's arguments start.
 *
 * Counting from a fixed offset does not survive contact with reality: the
 * executable path, Chromium's own switches and, when running unpackaged, the
 * script path all sit in front, in an order that changes with how the app was
 * started. The subcommand is the first word that names one.
 */
function userArgs(argv) {
  const start = argv.findIndex((arg) => HANDLED.has(arg) || HELP.has(arg))
  return start === -1 ? [] : argv.slice(start)
}

/**
 * Runs a subcommand and exits, or returns false so the caller starts the app.
 *
 * `exit` comes from the caller because leaving through `process.exit` kills the
 * main process and orphans Chromium's helpers — every `arco todo` would leave a
 * GPU and a utility process behind. Electron's own `app.exit` takes them down.
 */
function handleCli(rawArgv, exit = process.exit) {
  const argv = userArgs(rawArgv)
  const [command] = argv
  if (HELP.has(command)) {
    writeOut(`${USAGE}\n`)
    exit(0)
    return true
  }
  if (!HANDLED.has(command)) return false
  run(argv).then(
    () => exit(0),
    (error) => {
      writeErr(`${error.message}\n`)
      exit(1)
    },
  )
  return true
}

module.exports = { handleCli, USAGE, parseTodo, parseTodoEdit, formatTodoTable, statusOf }
