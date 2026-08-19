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

const SETTINGS_FILE =
  process.env.ARCO_HOOKS_SETTINGS_FILE || path.join(os.tmpdir(), 'arco-agent-hooks.json')

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
  arco --version              versao do app

  arco session [opcoes]       cria uma sessao de agente
      --agent claude|codex|opencode|shell   (padrao: claude)
      --project <nome>        projeto alvo; sem isso, deduz pelo diretorio atual
      --name <rotulo>         nome do pane
      --prompt <texto>        texto enviado ao agente ao abrir
      --worktree              forca worktree nova
      --no-worktree           forca a mesma arvore

  arco todo list [--json] [--status <status>]
      lista as tarefas; sem --json sai em tabela com id curto

  arco todo show <ref> [--json]   mostra uma tarefa inteira: notas, tags, card do ADO

  arco todo add <titulo> [--project <nome>] [--tag <tag>]... [--status <status>]
                    [--priority <nivel>] [--notes <texto>] [--ado <url|id>]
                    [--watch]
  arco todo <titulo> [opcoes]     atalho de "add", so para titulo com mais de uma palavra

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
      --watch                 acompanha o card no Azure DevOps (exige --ado e PAT)
      --no-watch              para de acompanhar o card

  arco todo status <ref> <status>   atalho para --status
  arco todo delete <ref> [--yes]    apaga a tarefa; --yes dispensa a confirmacao

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

/**
 * Posts a request and returns what the app did with it.
 *
 * The app answers every route with `{ ok, message, data }` after the change has
 * been applied, so a rejected reference or a task that does not exist arrives
 * here as an error instead of an empty success.
 */
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
  let body = null
  try {
    body = await response.json()
  } catch {}
  if (body && body.ok === false) throw new Error(body.message || `o app respondeu ${response.status}`)
  if (!response.ok) throw new Error(body?.message || `o app respondeu ${response.status}`)
  return body ?? {}
}

/**
 * Words that name a subcommand, real or expected.
 *
 * `arco todo <titulo>` creates a task, which used to mean that a mistyped
 * subcommand — `arco todo show abc123` — became a task called "show abc123",
 * printed nothing and exited 0. Four read commands left four junk tasks on a
 * real board before anyone noticed. Anything that reads like a verb is refused
 * instead: creating still works, through `add` or a plain multi-word title.
 */
const TODO_SUBCOMMANDS = new Set([
  'list',
  'ls',
  'show',
  'get',
  'view',
  'info',
  'add',
  'new',
  'create',
  'edit',
  'update',
  'set',
  'status',
  'delete',
  'del',
  'rm',
  'remove',
  'done',
  'complete',
  'close',
  'reopen',
  'open',
  'start',
  'move',
  'tag',
  'note',
  'notes',
  'watch',
  'unwatch',
  'help',
])

/**
 * Whether a lone word reads as a generated id rather than a title.
 *
 * Ids come from nanoid, so they mix cases, digits and `_`/`-` in a way an
 * ordinary word does not: `nEoxCda2` and `r8rxXKOs` are refused, `deploy` and
 * `22657` are titles like any other.
 */
function looksLikeRef(word) {
  if (!/^[A-Za-z0-9_-]{6,24}$/.test(word)) return false
  const mixedCase = /[a-z]/.test(word) && /[A-Z]/.test(word)
  const lettersAndDigits = /[A-Za-z]/.test(word) && /\d/.test(word)
  return mixedCase || lettersAndDigits || word.includes('_')
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
  let watch = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--project') project = args[++index]
    else if (arg === '--tag') tags.push(args[++index])
    else if (arg === '--status') status = args[++index]
    else if (arg === '--priority') priority = args[++index]
    else if (arg === '--notes') notes = args[++index]
    else if (arg === '--ado') adoRefInput = args[++index]
    else if (arg === '--watch') watch = true
    else if (arg === '--no-watch') watch = false
    // A mistyped option used to end up inside the title, which is how
    // `--adoo 22657` became part of a task's name instead of an error.
    else if (arg.startsWith('--')) throw new Error(`arco todo: opcao desconhecida: ${arg}`)
    else words.push(arg)
  }
  return {
    title: words.join(' '),
    tags: tags.filter(Boolean),
    project,
    status,
    priority,
    notes,
    adoRefInput,
    ...(watch === null ? {} : { watch }),
  }
}

/**
 * Guards the implicit `arco todo <titulo>` form.
 *
 * Returns the parsed request, or throws with what to type instead. `add` skips
 * this: naming a task `show` is legitimate when the intent is explicit.
 */
function parseTodoImplicit(args) {
  const first = args[0] ?? ''
  if (TODO_SUBCOMMANDS.has(first.toLowerCase())) {
    throw new Error(
      `arco todo: subcomando desconhecido: ${first}. Use: list | show | add | edit | status | delete`,
    )
  }
  const parsed = parseTodo(args)
  const words = parsed.title.split(' ').filter(Boolean)
  // A short title carrying a generated id is a command that went wrong —
  // `show 2vaJ6Oop`, or the same with the subcommand mistyped. A long title
  // that happens to quote an id is left alone.
  const ref = words.length <= 3 ? words.find(looksLikeRef) : undefined
  if (ref) {
    throw new Error(
      `arco todo: "${ref}" parece o id de uma tarefa, nao um titulo. Use "arco todo show ${ref}" para ver, ou "arco todo add ${parsed.title}" para criar mesmo assim`,
    )
  }
  return parsed
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
    else if (flag === '--watch') payload.watch = true
    else if (flag === '--no-watch') payload.watch = false
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

/**
 * One line naming what a write did, so no command exits 0 in silence.
 *
 * Creating and editing printed nothing at all, so the only way to know whether
 * a command took was to run `arco todo list` after it.
 */
function formatTodoReceipt(verb, todo) {
  if (!todo) return `${verb}\n`
  const id = String(todo.id ?? '').slice(0, 8)
  const tags = (todo.tags ?? []).map((tag) => `#${tag}`).join(' ')
  return `${verb}  ${id}  ${STATUS_LABEL[statusOf(todo)]}  ${String(todo.title ?? '')}${
    tags ? `  ${tags}` : ''
  }\n`
}

function formatAdoRef(ref) {
  if (!ref) return null
  const parts = [`${ref.org}/${ref.project}`]
  if (ref.workItemId) parts.push(`#${ref.workItemId}`)
  if (ref.prId) parts.push(` !${ref.prId}`)
  if (ref.repository) parts.push(` (${ref.repository})`)
  return parts.join('')
}

/** `arco todo show` — everything the sidebar shows about a task, as text. */
function formatTodoDetail(todo, projectName) {
  const lines = [
    ['id', String(todo.id ?? '')],
    ['titulo', String(todo.title ?? '')],
    ['status', STATUS_LABEL[statusOf(todo)]],
    ['prioridade', String(todo.priority ?? 'normal')],
    ['tags', (todo.tags ?? []).map((tag) => `#${tag}`).join(' ') || '-'],
    ['projeto', projectName || todo.projectId || '-'],
    ['ado', formatAdoRef(todo.adoRef) || '-'],
    ['watch', todo.watch ? 'sim' : 'nao'],
  ]
  if (todo.createdAt) lines.push(['criada em', new Date(todo.createdAt).toISOString()])
  const width = Math.max(...lines.map(([label]) => label.length))
  const head = lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')
  const notes = String(todo.notes ?? '').trim()
  return `${head}\n${notes ? `notas\n${notes.replace(/^/gm, '  ')}\n` : ''}`
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

/** Prints whatever the app warned about, without failing the command. */
function writeWarnings(result) {
  for (const warning of result?.data?.warnings ?? []) writeErr(`aviso: ${warning}\n`)
}

/** Confirms a delete. Non-interactive callers pass `--yes`; there is no prompt to answer. */
async function confirmDelete(todoLine) {
  if (!process.stdin.isTTY) {
    throw new Error('arco todo delete: sem terminal interativo, use --yes para confirmar')
  }
  const readline = require('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => {
    rl.question(`apagar ${todoLine.trim()}? [s/N] `, (value) => resolve(value))
  })
  rl.close()
  return /^(s|sim|y|yes)$/i.test(answer.trim())
}

async function runTodo(rest) {
  const [subcommand, ...args] = rest

  if (subcommand === 'list' || subcommand === 'ls') {
    const wantsJson = args.includes('--json')
    const statusIndex = args.indexOf('--status')
    const wantedStatus = statusIndex === -1 ? null : args[statusIndex + 1]
    const result = await post('todo/list')
    const todos = result.data?.todos ?? []
    if (result.stale) writeErr('aviso: o app nao respondeu; lista lida do arquivo em disco\n')
    const filtered = wantedStatus
      ? todos.filter((todo) => statusOf(todo) === wantedStatus.replace(/-/g, '_'))
      : todos
    writeOut(wantsJson ? `${JSON.stringify(filtered)}\n` : formatTodoTable(filtered))
    return
  }

  if (subcommand === 'show' || subcommand === 'get' || subcommand === 'view' || subcommand === 'info') {
    const ref = args.find((arg) => !arg.startsWith('--'))
    if (!ref) throw new Error('arco todo show: informe a tarefa (id ou trecho do titulo)')
    const result = await post('todo/show', { ref })
    const todo = result.data?.todo
    if (!todo) throw new Error(`nenhuma tarefa encontrada para "${ref}"`)
    writeOut(
      args.includes('--json')
        ? `${JSON.stringify(todo)}\n`
        : formatTodoDetail(todo, result.data?.projectName),
    )
    return
  }

  if (subcommand === 'edit') {
    const result = await post('todo/edit', parseTodoEdit(args))
    writeOut(formatTodoReceipt('editada', result.data?.todo))
    writeWarnings(result)
    return
  }

  if (subcommand === 'status') {
    const [ref, status] = args
    if (!ref || !status) throw new Error('arco todo status: informe a tarefa e o status')
    const result = await post('todo/edit', { ref, status })
    writeOut(formatTodoReceipt(status, result.data?.todo))
    return
  }

  if (subcommand === 'delete' || subcommand === 'del' || subcommand === 'rm' || subcommand === 'remove') {
    const ref = args.find((arg) => !arg.startsWith('--'))
    if (!ref) throw new Error('arco todo delete: informe a tarefa (id ou trecho do titulo)')
    const found = await post('todo/show', { ref })
    const todo = found.data?.todo
    if (!todo) throw new Error(`nenhuma tarefa encontrada para "${ref}"`)
    const line = formatTodoReceipt('', todo)
    if (!args.includes('--yes') && !args.includes('-y') && !(await confirmDelete(line))) {
      writeOut('cancelado\n')
      return
    }
    const result = await post('todo/delete', { ref: todo.id })
    writeOut(formatTodoReceipt('apagada', result.data?.todo ?? todo))
    return
  }

  const isExplicitAdd = subcommand === 'add' || subcommand === 'new' || subcommand === 'create'
  const parsed = isExplicitAdd ? parseTodo(args) : parseTodoImplicit(rest)
  if (!parsed.title) throw new Error('arco todo: informe um titulo')
  const result = await post('todo', {
    title: parsed.title,
    tags: parsed.tags,
    ...(parsed.project ? { project: parsed.project } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.notes !== null ? { notes: parsed.notes } : {}),
    ...(parsed.adoRefInput ? { adoRefInput: parsed.adoRefInput } : {}),
    ...(parsed.watch === undefined ? {} : { watch: parsed.watch }),
  })
  writeOut(formatTodoReceipt('criada', result.data?.todo))
  writeWarnings(result)
}

async function run(argv) {
  const [command, ...rest] = argv

  if (command === 'todo') {
    await runTodo(rest)
    return
  }

  if (command === 'session') {
    const result = await post('session', parseSession(rest))
    writeOut(`${result.message || 'sessao criada'}\n`)
    return
  }

  throw new Error(`arco: subcomando desconhecido: ${command}`)
}

const HANDLED = new Set(['todo', 'session'])
const HELP = new Set(['--help', '-h', 'help'])
const VERSION = new Set(['--version', '-v', 'version'])

/** The packaged version, read from Electron when it is up and from the manifest otherwise. */
function appVersion() {
  try {
    return require('electron').app.getVersion()
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    return 'desconhecida'
  }
}

/**
 * Finds where the user's arguments start.
 *
 * Counting from a fixed offset does not survive contact with reality: the
 * executable path, Chromium's own switches and, when running unpackaged, the
 * script path all sit in front, in an order that changes with how the app was
 * started. The subcommand is the first word that names one.
 */
function userArgs(argv) {
  const start = argv.findIndex(
    (arg) => HANDLED.has(arg) || HELP.has(arg) || VERSION.has(arg),
  )
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
  // Without this, `arco --version` matched nothing here and fell through to
  // opening a window: the command hung until it was killed.
  if (VERSION.has(command)) {
    writeOut(`arco ${appVersion()}\n`)
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

module.exports = {
  handleCli,
  USAGE,
  parseTodo,
  parseTodoImplicit,
  parseTodoEdit,
  formatTodoTable,
  formatTodoReceipt,
  formatTodoDetail,
  statusOf,
}
