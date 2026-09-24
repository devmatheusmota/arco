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

/** Scratch word to sleep on while a full pipe drains. Never signalled. */
const DRAIN_SLOT = new Int32Array(new SharedArrayBuffer(4))

/**
 * Writes the whole text to a descriptor, synchronously.
 *
 * `process.stdout.write` is asynchronous when stdout is a pipe, and
 * `process.exit` drops whatever is still buffered — so the command printed
 * nothing at all when its output was captured, while looking fine in a
 * terminal. Writing straight to the file descriptor is synchronous either way.
 *
 * One `writeSync` is not enough, though: it writes as much as fits and reports
 * how much that was. With `2>&1` both descriptors share one pipe, which Node
 * leaves in non-blocking mode, so the write stopped at the pipe buffer — 64 KB
 * of a 200 KB listing, valid exit code, JSON cut mid-string. Looping over the
 * offset is what makes the output whole; `EAGAIN` means the buffer is full and
 * the reader has not drained it yet, and `Atomics.wait` yields the CPU it needs
 * instead of spinning on it.
 */
function writeTo(fd, text) {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    } catch (error) {
      if (error.code === 'EAGAIN') {
        Atomics.wait(DRAIN_SLOT, 0, 0, 1)
        continue
      }
      // The reader went away — `arco todo list | head`. Stop quietly, the way
      // the default SIGPIPE would have, instead of dying on a broken pipe.
      if (error.code === 'EPIPE') return
      throw error
    }
  }
}

function writeOut(text) {
  writeTo(1, text)
}

function writeErr(text) {
  writeTo(2, text)
}

const USAGE = `arco — abre diretorios e comanda o Arco a partir do terminal.

O Arco organiza o trabalho em frentes; cada frente tem panes (sessoes de agente).
Um pane atende por uma referencia curta: pa-3576. A sua esta em $ARCO_PANE_ID.

  arco session list           quem esta aberto agora; o seu pane vem com *
  arco session close <ref>    fecha um pane; a frente continua aberta, mesmo vazia
  arco session send <ref> ... manda texto para outro pane; ele responde la
  arco session [opcoes]       abre um pane novo, na sua frente
  arco group list             as frentes de trabalho abertas
  arco group close <ref>      fecha uma frente e a worktree dela
  arco todo list              as tarefas

Detalhe de cada um abaixo.

  arco                        abre o diretorio atual
  arco <caminho>              abre o diretorio informado
  arco --version              versao do app

  arco session [opcoes]       cria uma sessao de agente
      --agent claude|codex|opencode|shell   (padrao: claude)
      --group <nome|ref>      abre em outra frente; nome que nao existe abre uma
                              frente nova; sem isso, na frente deste pane
      --project <nome>        projeto alvo; sem isso, deduz pelo diretorio atual
      --name <rotulo>         nome do pane
      --prompt <texto>        texto enviado ao agente ao abrir
      --worktree              forca worktree nova; recusado quando a frente ja
                              tem uma, em vez de entrar nela calado
      --no-worktree           forca a mesma arvore
      --todo <ref>            ja nasce amarrada a essa tarefa
      --force                 tira a tarefa da sessao que a segura hoje

  arco session list [--json]
      lista as sessoes abertas: referencia curta, frente, agente, estado e nome

  arco group list [--json]
      lista as frentes de trabalho abertas: id curto, nome, projeto e as sessoes
      de cada uma

  arco group close <ref> [--yes]
      fecha uma frente, com as sessoes dela; se a frente criou uma worktree,
      ela tambem e apagada
      <ref> e a frente: o id dela (a primeira coluna de "arco group list") ou
      um trecho do nome que so ela tenha; ou uma sessao dela (pa-3576, current).
      Assim tambem fecha uma frente que ficou sem panes. Um <ref> que serve a
      mais de uma frente falha e lista as candidatas

  arco session send <ref> <texto>
      manda texto para um pane que ja esta aberto; entra quando o agente ficar ocioso
      <ref> e a referencia curta (pa-3576, ou so 3576), o id do pane, ou "current"
      --prompt <texto>        o mesmo que o texto solto
      --file <caminho>        le o texto de um arquivo
      --raw                   entrega so o texto, sem a linha que diz quem mandou
      sem texto e sem --file, le da entrada padrao: git log | arco session send pa-3576

  arco session close <ref> [--yes]
      fecha um pane; a frente e os outros panes dela continuam abertos
      no ultimo pane de uma frente, ela fica aberta e vazia (a worktree dela
      tambem fica) e a resposta traz o "arco group close" que a fecha
      --yes                   confirma quando o pane tem worktree propria, que sai junto

  arco session rename <nome> [--session <id|current>]
      renomeia a sessao; sem --session, a que roda neste terminal

  arco todo list [--json] [--status <status>]
      lista as tarefas; sem --json sai em tabela com id curto

  arco todo show <ref> [--json]   mostra uma tarefa inteira: notas, tags, card do ADO

  arco todo add <titulo> [--project <nome>] [--tag <tag>]... [--status <status>]
                    [--priority <nivel>] [--notes <texto>] [--ado <url|id>]
                    [--session <id|current>]
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
      --session <id|current>  amarra a tarefa a uma sessao do Arco
      --clear-session         solta a tarefa da sessao
      --force                 troca a sessao mesmo com outra ja amarrada

  arco todo status <ref> <status>   atalho para --status
  arco todo delete <ref> [--yes]    apaga a tarefa; --yes dispensa a confirmacao

<ref> e o id (inteiro ou o prefixo que aparece em "arco todo list") ou um
trecho do titulo, desde que so uma tarefa corresponda.

--session current resolve a sessao deste terminal: pelo ARCO_SESSION_ID que o
pane exporta e, na falta dele, pelo diretorio atual. Duas sessoes na mesma
arvore nao dao para distinguir dessa forma, e o comando pede --session <id>.

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
  if (body && body.ok === false)
    throw new Error(body.message || `o app respondeu ${response.status}`)
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
  let session = null
  let force = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--project') project = args[++index]
    else if (arg === '--tag') tags.push(args[++index])
    else if (arg === '--status') status = args[++index]
    else if (arg === '--priority') priority = args[++index]
    else if (arg === '--notes') notes = args[++index]
    else if (arg === '--ado') adoRefInput = args[++index]
    else if (arg === '--session') session = args[++index]
    else if (arg === '--force') force = true
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
    session,
    force,
  }
}

/**
 * What the app needs to answer `--session current`.
 *
 * The pane exports its own id, and that is the only answer that survives two
 * sessions sharing one tree. The directory is the fallback, for a session that
 * started before the app exported anything and for a terminal it did not spawn.
 */
function sessionScope() {
  const sessionId = (process.env.ARCO_SESSION_ID ?? '').trim()
  return {
    ...(sessionId ? { sessionId } : {}),
    sessionCwd: process.cwd(),
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
    else if (flag === '--session') payload.session = rest[++index]
    else if (flag === '--clear-session') payload.clearSession = true
    else if (flag === '--force') payload.force = true
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
    // A task nobody can trace back to a session reads the same as one that was
    // never claimed, so the marker carries the session it belongs to.
    session: sessionIdOf(todo) ? `@${sessionIdOf(todo).slice(0, 8)}` : '',
  }))
  const width = (key) => Math.max(...rows.map((row) => row[key].length))
  const idWidth = width('id')
  const statusWidth = width('status')
  return `${rows
    .map(
      (row) =>
        `${row.id.padEnd(idWidth)}  ${row.status.padEnd(statusWidth)}  ${row.title}${
          row.tags ? `  ${row.tags}` : ''
        }${row.session ? `  ${row.session}` : ''}`,
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

/** The session a task belongs to, or an empty string when it belongs to none. */
function sessionIdOf(todo) {
  const id = todo?.session?.id
  return typeof id === 'string' ? id : ''
}

function formatSession(session) {
  const id = sessionIdOf({ session })
  if (!id) return null
  const parts = [id.slice(0, 8)]
  if (session.name) parts.push(String(session.name))
  if (session.agent) parts.push(`(${session.agent})`)
  return parts.join(' ')
}

function formatAdoRef(ref) {
  if (!ref) return null
  const parts = [`${ref.org}/${ref.project}`]
  if (ref.workItemId) parts.push(`#${ref.workItemId}`)
  for (const pr of ref.prs ?? []) {
    parts.push(` !${pr.id}`)
    if (pr.repository) parts.push(` (${pr.repository})`)
  }
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
    ['sessao', formatSession(todo.session) || '-'],
  ]
  if (todo.createdAt) lines.push(['criada em', new Date(todo.createdAt).toISOString()])
  const width = Math.max(...lines.map(([label]) => label.length))
  const head = lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')
  const notes = String(todo.notes ?? '').trim()
  return `${head}\n${notes ? `notas\n${notes.replace(/^/gm, '  ')}\n` : ''}`
}

/** What `arco session` answers to, named in the error when a bare word is not one of them. */
const SESSION_SUBCOMMANDS = 'list, send, rename, new'

/**
 * Ceiling on a single message.
 *
 * `readBody` in the listener destroys the request past 1 MB without explaining
 * itself, so the refusal has to happen here, where it can say what was wrong.
 * Anything near this is a file the agent should be told to read, not text to
 * paste into its composer.
 */
const SEND_TEXT_MAX = 100_000

/**
 * `arco session list` as a table, in the shape `formatTodoTable` prints.
 *
 * The reference goes in whole — it is four digits — because it is the column
 * every other command takes as an argument. The working directory stays out:
 * a path is long enough to push the name off the line, and the name is what
 * tells two panes apart at a glance. `--json` still carries it.
 */
function formatSessionTable(sessions) {
  if (sessions.length === 0) return 'nenhuma sessao\n'
  const rows = sessions.map((session) => ({
    here: session.current ? '*' : '',
    ref: String(session.ref ?? ''),
    // The front is what the session belongs to; the project is one level above
    // it and already implied by the front's own listing.
    group: String(session.group ?? ''),
    agent: String(session.agent ?? ''),
    status: String(session.status ?? ''),
    project: String(session.project ?? ''),
    name: String(session.name ?? ''),
    marks: [
      session.pinned ? '[orq]' : '',
      session.parked ? '[parked]' : '',
      session.todo ? `#${String(session.todo).slice(0, 8)}` : '',
      session.worktree ? `[${session.worktree}]` : '',
    ]
      .filter(Boolean)
      .join(' '),
  }))
  const width = (key) => Math.max(...rows.map((row) => row[key].length))
  const hereWidth = width('here')
  const refWidth = width('ref')
  const groupWidth = width('group')
  const agentWidth = width('agent')
  const statusWidth = width('status')
  const projectWidth = width('project')
  return `${rows
    .map(
      (row) =>
        `${hereWidth ? `${row.here.padEnd(hereWidth)} ` : ''}${row.ref.padEnd(refWidth)}  ${
          groupWidth ? `${row.group.padEnd(groupWidth)}  ` : ''
        }${row.agent.padEnd(agentWidth)}  ${row.status.padEnd(
          statusWidth,
        )}  ${row.project.padEnd(projectWidth)}  ${row.name}${row.marks ? `  ${row.marks}` : ''}`,
    )
    .join('\n')}\n`
}

/** What `arco group` answers to, named in the error when a bare word is not one of them. */
const GROUP_SUBCOMMANDS = 'list, close'

/** `arco group list` as a table: the front, its project, and the sessions in it. */
function formatGroupTable(groups) {
  if (groups.length === 0) return 'nenhuma frente de trabalho\n'
  const rows = groups.map((group) => ({
    // The short id is what `arco group close` takes when two fronts share a
    // name, or when a front has no pane left to be named by.
    id: String(group.id ?? '').slice(0, 8),
    name: String(group.name ?? ''),
    project: String(group.project ?? ''),
    panes: `${group.panes ?? 0} pane(s)`,
    // The references are what `arco session send` and `arco group close` take,
    // so a listing is directly actionable without a second lookup.
    refs: (group.refs ?? []).join(' '),
    worktree: group.worktree ? `[${group.worktree}]` : '',
  }))
  const width = (key) => Math.max(...rows.map((row) => row[key].length))
  const idWidth = width('id')
  const nameWidth = width('name')
  const projectWidth = width('project')
  const panesWidth = width('panes')
  return `${rows
    .map((row) =>
      `${idWidth ? `${row.id.padEnd(idWidth)}  ` : ''}${row.name.padEnd(nameWidth)}  ${row.project.padEnd(
        projectWidth,
      )}  ${row.panes.padEnd(panesWidth)}  ${row.refs}${row.worktree ? `  ${row.worktree}` : ''}`.trimEnd(),
    )
    .join('\n')}\n`
}

async function runGroupList(args) {
  const unknown = args.find((arg) => arg !== '--json')
  if (unknown) throw new Error(`arco group list: opcao desconhecida: ${unknown}`)
  const result = await post('group/list')
  const groups = result.data?.groups ?? []
  writeOut(args.includes('--json') ? `${JSON.stringify(groups)}\n` : formatGroupTable(groups))
}

/**
 * `arco group close <ref> [--yes]`.
 *
 * The reference is resolved by the app, which is the only side that knows the
 * fronts: an id, a piece of a name or a session inside one.
 */
function parseGroupClose(args) {
  let target = null
  let yes = false
  for (const arg of args) {
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg.startsWith('--')) throw new Error(`arco group close: opcao desconhecida: ${arg}`)
    else if (target === null) target = arg
    else throw new Error(`arco group close: argumento a mais: ${arg}`)
  }
  if (!target) {
    throw new Error(
      'arco group close: informe a frente (id ou trecho do nome) ou uma sessao dela (pa-3576 ou current)',
    )
  }
  return { target, yes }
}

async function runGroupClose(args) {
  const { target, yes } = parseGroupClose(args)
  // Closing a front deletes its worktree, which is not undoable. The app asks
  // again when the tree has uncommitted work; this is the terminal's own guard,
  // for the case where nobody is looking at the window.
  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new Error('arco group close: sem terminal interativo, use --yes para confirmar')
    }
    const readline = require('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise((resolve) => {
      rl.question(
        `fechar a frente indicada por "${target}" e apagar a worktree dela, se tiver? [s/N] `,
        resolve,
      )
    })
    rl.close()
    if (!/^(s|sim|y|yes)$/i.test(String(answer).trim())) {
      writeOut('cancelado\n')
      return
    }
  }
  // `confirmed` tells the window the question was already answered here. Left
  // out, the window raises its own `window.confirm`, which blocks the renderer
  // entirely — nobody is looking at it, and the app stops answering anything.
  const result = await post('group/close', { target, confirmed: true, ...sessionScope() })
  writeOut(`${result.message || 'frente fechada'}\n`)
}

/**
 * `arco session close <ref> [--yes]`.
 *
 * No prompt of its own: closing a pane that owns no worktree takes nothing off
 * disk, and the app refuses the one case that does until `--yes` says so.
 */
function parseSessionClose(args) {
  let target = null
  let yes = false
  for (const arg of args) {
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg.startsWith('--')) throw new Error(`arco session close: opcao desconhecida: ${arg}`)
    else if (target === null) target = arg
    else throw new Error(`arco session close: argumento a mais: ${arg}`)
  }
  if (!target) throw new Error('arco session close: informe o pane (pa-3576)')
  return { target, ...(yes ? { confirmed: true } : {}) }
}

async function runSessionClose(args) {
  const result = await post('session/close', { ...parseSessionClose(args), ...sessionScope() })
  writeOut(`${result.message || 'pane fechado'}\n`)
}

async function runSessionList(args) {
  const unknown = args.find((arg) => arg !== '--json')
  if (unknown) throw new Error(`arco session list: opcao desconhecida: ${unknown}`)
  const result = await post('session/list', sessionScope())
  const sessions = result.data?.sessions ?? []
  writeOut(args.includes('--json') ? `${JSON.stringify(sessions)}\n` : formatSessionTable(sessions))
}

/**
 * `arco session send <ref> [texto] [--prompt <texto>] [--file <caminho>]`.
 *
 * The target is the first bare word and the message is everything after it,
 * joined — the same shape `parseSessionRename` uses, for the same reason: a
 * message is a sentence, and quoting should not be the only way to write one.
 *
 * Two sources at once is a typo, not an intent to concatenate, so it is refused
 * rather than guessed at.
 */
function parseSessionSend(args) {
  const words = []
  let target = null
  let prompt = null
  let file = null
  let raw = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--prompt') prompt = args[++index]
    else if (arg === '--raw') raw = true
    else if (arg === '--file') file = args[++index]
    else if (arg.startsWith('--')) throw new Error(`arco session send: opcao desconhecida: ${arg}`)
    else if (target === null) target = arg
    else words.push(arg)
  }
  if (!target) throw new Error('arco session send: informe o pane de destino (pa-3576 ou current)')
  const loose = words.join(' ').trim()
  const flagged = (prompt ?? '').trim()
  if (loose && flagged)
    throw new Error('arco session send: use o texto solto ou --prompt, nao os dois')
  const text = loose || flagged
  if (text && file) throw new Error('arco session send: use o texto ou --file, nao os dois')
  return { target, text: text || null, file: file || null, raw }
}

/** Reads the message from wherever it was pointed at, defaulting to standard input. */
function readSendText(parsed) {
  if (parsed.file) {
    try {
      return fs.readFileSync(path.resolve(process.cwd(), parsed.file), 'utf8')
    } catch {
      throw new Error(`arco session send: nao consegui ler ${parsed.file}`)
    }
  }
  if (parsed.text) return parsed.text
  // A pipe is the useful form for an agent: `git log | arco session send pa-3576`.
  if (process.stdin.isTTY) return ''
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Refuses a message the app could not act on, before the request leaves. */
function assertSendText(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('arco session send: nao ha texto para enviar')
  if (text.length > SEND_TEXT_MAX)
    throw new Error(
      `arco session send: ${text.length} caracteres passam do limite de ${SEND_TEXT_MAX}; use --file com um caminho e peca para o agente ler`,
    )
  return text
}

async function runSessionSend(args) {
  const parsed = parseSessionSend(args)
  const text = assertSendText(readSendText(parsed))
  const result = await post('session/send', {
    target: parsed.target,
    text,
    ...(parsed.raw ? { raw: true } : {}),
    ...sessionScope(),
  })
  writeOut(`${result.message || 'mensagem entregue'}\n`)
}

function parseSession(args) {
  // `sessionScope()` is what lets the new session land in the front the command
  // was run from; without it every `arco session` opens a loose tab.
  const payload = { agent: 'claude', cwd: process.cwd(), worktree: 'inherit', ...sessionScope() }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--agent') payload.agent = args[++index]
    else if (flag === '--project') payload.project = args[++index]
    else if (flag === '--name') payload.name = args[++index]
    else if (flag === '--prompt') payload.prompt = args[++index]
    else if (flag === '--worktree') payload.worktree = 'new'
    else if (flag === '--no-worktree') payload.worktree = 'none'
    else if (flag === '--group') payload.group = args[++index]
    else if (flag === '--todo') payload.todo = args[++index]
    else if (flag === '--force') payload.force = true
    // A bare word here is someone reaching for a subcommand, not an option. It
    // already failed, but as "opcao desconhecida: list", which sends the reader
    // looking for a flag that was never the problem.
    else if (!flag.startsWith('--'))
      throw new Error(
        `arco session: subcomando desconhecido: ${flag} (use: ${SESSION_SUBCOMMANDS})`,
      )
    else throw new Error(`arco session: opcao desconhecida: ${flag}`)
  }
  return payload
}

/**
 * `arco session rename <nome> [--session <id>]`.
 *
 * The name is everything that is not an option, joined — a session is called
 * "revisao do PR 11132" far more often than it is called one word, and quoting
 * it should not be the only way to say so.
 */
function parseSessionRename(args) {
  const words = []
  let session = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--session') session = args[++index]
    else if (arg.startsWith('--'))
      throw new Error(`arco session rename: opcao desconhecida: ${arg}`)
    else words.push(arg)
  }
  const name = words.join(' ').trim()
  if (!name) throw new Error('arco session rename: informe o nome novo')
  return { name, ...(session ? { session } : {}), ...sessionScope() }
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

  if (
    subcommand === 'show' ||
    subcommand === 'get' ||
    subcommand === 'view' ||
    subcommand === 'info'
  ) {
    const ref = args.find((arg) => !arg.startsWith('--'))
    if (!ref) throw new Error('arco todo show: informe a tarefa (id ou trecho do titulo)')
    const result = await post('todo/show', { ref })
    const todo = result.data?.todo
    if (!todo) throw new Error(`nenhuma tarefa encontrada para "${ref}"`)
    writeOut(
      args.includes('--json')
        ? // `sessionId` is lifted to the top level so a caller reading the JSON
          // does not have to know how the link is stored.
          `${JSON.stringify({ ...todo, sessionId: result.data?.sessionId ?? null })}\n`
        : formatTodoDetail(todo, result.data?.projectName),
    )
    return
  }

  if (subcommand === 'edit') {
    const payload = parseTodoEdit(args)
    if (payload.session) Object.assign(payload, sessionScope())
    const result = await post('todo/edit', payload)
    writeOut(formatTodoReceipt('editada', result.data?.todo))
    return
  }

  if (subcommand === 'status') {
    const [ref, status] = args
    if (!ref || !status) throw new Error('arco todo status: informe a tarefa e o status')
    const result = await post('todo/edit', { ref, status })
    writeOut(formatTodoReceipt(status, result.data?.todo))
    return
  }

  if (
    subcommand === 'delete' ||
    subcommand === 'del' ||
    subcommand === 'rm' ||
    subcommand === 'remove'
  ) {
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
    // Without this the task lands in whatever project the window has open,
    // which is not the one the terminal is standing in.
    cwd: process.cwd(),
    ...(parsed.project ? { project: parsed.project } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.notes !== null ? { notes: parsed.notes } : {}),
    ...(parsed.adoRefInput ? { adoRefInput: parsed.adoRefInput } : {}),
    ...(parsed.session ? { session: parsed.session, force: parsed.force, ...sessionScope() } : {}),
  })
  writeOut(formatTodoReceipt('criada', result.data?.todo))
}

/**
 * The part of the usage text that answers for one command.
 *
 * `arco session --help` used to come back as "opcao desconhecida: --help", which
 * is the one answer that teaches nothing: whoever typed it was asking what the
 * options are. The blocks are the ones `arco help` already prints, filtered by
 * the command asked about, so there is a single text to keep correct.
 */
function helpFor(topic) {
  const wanted = `arco ${topic}`
  // Only the detailed half: the summary above it is one block listing every
  // command, so matching there would print the whole index for any topic.
  const detail = USAGE.split('Detalhe de cada um abaixo.').pop() ?? ''
  const blocks = detail.split('\n\n').filter((block) => {
    const head = block.split('\n')[0].trim()
    return head === wanted || head.startsWith(`${wanted} `)
  })
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : null
}

/**
 * Answers `--help` wherever it appears in a command, before parsing does.
 *
 * It has to run first: every parser treats an unknown `--flag` as an error, and
 * asking for help is not a malformed command.
 */
function helpRequested(args) {
  return args.some((arg) => arg === '--help' || arg === '-h')
}

async function run(argv) {
  const [command, ...rest] = argv

  if (HANDLED.has(command) && helpRequested(rest)) {
    // `arco session send --help` is about `session send`, not about `session`.
    const sub = rest.find((arg) => !arg.startsWith('-'))
    const text = (sub && helpFor(`${command} ${sub}`)) || helpFor(command)
    if (text) {
      writeOut(text)
      return
    }
  }

  if (command === 'todo') {
    await runTodo(rest)
    return
  }

  if (command === 'group') {
    const [subcommand, ...args] = rest
    if (subcommand === 'list' || subcommand === 'ls') {
      await runGroupList(args)
      return
    }
    if (subcommand === 'close' || subcommand === 'rm') {
      await runGroupClose(args)
      return
    }
    throw new Error(
      `arco group: subcomando desconhecido: ${subcommand ?? '(nenhum)'} (use: ${GROUP_SUBCOMMANDS})`,
    )
  }

  if (command === 'session') {
    const [subcommand, ...args] = rest
    if (subcommand === 'list' || subcommand === 'ls') {
      await runSessionList(args)
      return
    }
    if (subcommand === 'send' || subcommand === 'msg') {
      await runSessionSend(args)
      return
    }
    if (subcommand === 'close' || subcommand === 'rm') {
      await runSessionClose(args)
      return
    }
    if (subcommand === 'rename' || subcommand === 'name') {
      const result = await post('session/rename', parseSessionRename(args))
      writeOut(`${result.message || 'sessao renomeada'}\n`)
      return
    }
    // `new`/`create` names what the bare form already does, so the word is
    // dropped before parsing instead of reaching the guard as a stray positional.
    const createArgs = subcommand === 'new' || subcommand === 'create' ? args : rest
    const result = await post('session', parseSession(createArgs))
    writeOut(`${result.message || 'sessao criada'}\n`)
    return
  }

  throw new Error(`arco: subcomando desconhecido: ${command}`)
}

const HANDLED = new Set(['todo', 'session', 'group'])
const HELP = new Set(['--help', '-h', 'help'])
const VERSION = new Set(['--version', '-v', 'version'])

/**
 * Where the manifest can be, in the order worth trying.
 *
 * Running as plain Node there is no `app` to ask the version, and this file sits
 * in `app.asar.unpacked/electron/` — a directory that holds the unpacked files
 * and nothing else. The manifest never leaves the archive, so the packed path
 * has to be tried too, or `arco --version` answers "desconhecida" about itself.
 */
function manifestCandidates(dir) {
  const unpacked = path.join(dir, '..', 'package.json')
  const packed = unpacked.replace(/app\.asar\.unpacked/, 'app.asar')
  return packed === unpacked ? [unpacked] : [unpacked, packed]
}

/** The packaged version, read from Electron when it is up and from the manifest otherwise. */
function appVersion() {
  try {
    return require('electron').app.getVersion()
  } catch {}
  for (const candidate of manifestCandidates(__dirname)) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')).version
    } catch {}
  }
  return 'desconhecida'
}

/**
 * The version of the app that is actually answering, when one is up.
 *
 * `arco --version` reads the binary it was launched from, which is not always
 * the app in front of the user: an update that lands while the old window is
 * still open leaves the two apart, and a number that does not match what the
 * window does is the wrong number to debug against.
 */
async function runningVersion() {
  try {
    const { base, token } = listener()
    const response = await fetch(`${base}/version`, {
      headers: { 'X-Arco-Token': token },
      signal: AbortSignal.timeout(1500),
    })
    const body = await response.json()
    return typeof body?.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** Prints the binary's version, and the running app's when the two disagree. */
async function reportVersion() {
  const local = appVersion()
  writeOut(`arco ${local}\n`)
  const running = await runningVersion()
  if (running && running !== local) writeOut(`app  ${running}  (versao do app aberto)\n`)
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
  const start = argv.findIndex((arg) => HANDLED.has(arg) || HELP.has(arg) || VERSION.has(arg))
  return start === -1 ? [] : argv.slice(start)
}

/**
 * Whether this argv names a terminal subcommand rather than a window to open.
 *
 * The caller needs the answer before `handleCli` runs: these subcommands share
 * the app binary, so Chromium is already coming up, and the parts of it that
 * reach the display have to be turned off before they get there.
 */
function handlesCli(rawArgv) {
  const [command] = userArgs(rawArgv)
  return HELP.has(command) || VERSION.has(command) || HANDLED.has(command)
}

/**
 * Switches that belong to Chromium or to how the app is launched, rather than to
 * the command line a person types. Matched by prefix: Chromium's surface is far
 * too large to list, and everything in it is shaped like one of these.
 */
const PASSTHROUGH_PREFIXES = [
  '--open-path',
  '--enable-',
  '--disable-',
  '--no-',
  '--ozone-',
  '--use-',
  '--force-',
  '--in-process-',
  '--user-data-dir',
  '--remote-',
  '--proxy-',
  '--headless',
  '--inspect',
  '--lang',
  '--log-',
  '--trace-',
  '--class',
  '--gtk-',
  '--v=',
  '--vmodule=',
]

/**
 * The mistyped flag this argv carries, if there is one and nothing to open.
 *
 * `arco --hlep` used to fall through to "open what was asked for", find nothing
 * to open, and exit 0 having done nothing — after starting the window layer on
 * the way, which is what wrote libX11's authorization warning over that empty
 * answer. A typo is a usage error, and naming it costs no display at all.
 *
 * Deciding on the outcome rather than on the position of the arguments is what
 * makes this hold in both layouts: packaged, argv is the binary and the user's
 * words; from a checkout, Electron's own path and the script sit in front. A
 * launch with a directory to open is the app starting normally whatever else
 * rides along, and Chromium's switches are let through by shape — `npm run app`
 * passes two of them.
 */
function mistypedFlag(rawArgv) {
  // A subcommand owns its own options — `todo list --json`, `session --agent` —
  // and refuses the ones it does not know with a message that can name the
  // command it belongs to. Reading those here called `--json` a typo and turned
  // every `arco todo list --json` into exit 2.
  if (handlesCli(rawArgv)) return null
  const args = rawArgv.slice(1)
  const unknown = args.find(
    (argument) =>
      argument.startsWith('-') &&
      !HELP.has(argument) &&
      !VERSION.has(argument) &&
      !PASSTHROUGH_PREFIXES.some((prefix) => argument.startsWith(prefix)),
  )
  if (!unknown) return null
  const opens = args.some((argument) => {
    if (argument.startsWith('-')) return false
    try {
      return fs.statSync(path.resolve(argument)).isDirectory()
    } catch {
      return false
    }
  })
  return opens ? null : unknown
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
    reportVersion().then(
      () => exit(0),
      () => exit(0),
    )
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
  handlesCli,
  manifestCandidates,
  mistypedFlag,
  USAGE,
  helpFor,
  helpRequested,
  parseSession,
  formatSessionTable,
  formatGroupTable,
  parseSessionSend,
  parseSessionClose,
  parseGroupClose,
  assertSendText,
  SEND_TEXT_MAX,
  parseTodo,
  parseTodoImplicit,
  parseTodoEdit,
  formatTodoTable,
  formatTodoReceipt,
  formatTodoDetail,
  statusOf,
}
