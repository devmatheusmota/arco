// MCP server for the sessions Arco starts.
//
// The same surface as the `arco` command line, as typed tools: an agent calls
// `todo_add` with a `priority` the schema enumerates instead of composing a shell
// line whose typos the parser has to guess at. It is served by the hook listener
// the app already runs (`POST /mcp`, streamable HTTP, JSON responses only), so a
// pane costs no extra process. Every tool is answered by the same frontend
// handlers the command line reaches, through the same `/cli/*` dispatch.
//
// Stateless: no `Mcp-Session-Id`, no server-initiated stream. The caller names
// its own pane through the `X-Arco-Session` header, which is how `current`
// resolves without a working directory.
//
// A tool with `run` instead of `route` is answered in the main process: it acts
// on the desktop, not on the workspace the frontend owns.

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const STATUSES = ['todo', 'in-progress', 'review', 'done']
const PRIORITIES = ['high', 'normal', 'low']
const AGENTS = ['claude', 'codex', 'opencode', 'shell']
const SEND_TEXT_MAX = 100_000

const INSTRUCTIONS = [
  "Arco's task board and panes, as typed tools. They cover what the `arco` shell command does;",
  'prefer them: arguments are validated, a refusal comes back as an error instead of a silent',
  'fallback, and output is never truncated. The server already knows which pane is calling, so',
  '`session: "current"` needs no id. Move a task to in-progress when you pick it up and to review',
  'when you hand the work back.',
].join(' ')

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const flag = (description) => ({ type: 'boolean', description })
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description })
const ref = string('Task: short id from todo_list, full id, or a unique piece of its title', {
  minLength: 1,
})
const pane = string('Pane reference like pa-3576, as session_list prints it', { minLength: 1 })

const TOOLS = [
  {
    name: 'session_list',
    description:
      'Panes open in Arco: reference (pa-1234), front, agent, status, project, name and directory. `current: true` marks the pane calling.',
    readOnly: true,
    properties: {},
    route: 'session/list',
    payload: () => ({}),
    result: (data) => ({ sessions: data?.sessions ?? [] }),
  },
  {
    name: 'session_send',
    description:
      'Types text into a running pane and submits it. The receiving agent is told who sent it and how to answer. Refused when the pane is not running.',
    properties: {
      target: pane,
      text: string('What to deliver', { minLength: 1, maxLength: SEND_TEXT_MAX }),
      raw: flag('Leave out the line that names you as the sender'),
    },
    required: ['target', 'text'],
    route: 'session/send',
    payload: (args) => ({
      target: args.target,
      text: args.text,
      ...(args.raw ? { raw: true } : {}),
    }),
  },
  {
    name: 'session_open',
    description:
      'Opens a pane. Without `group` it lands in the front of the pane calling and shares its worktree; a `group` name that matches no front opens that front.',
    properties: {
      agent: string('Agent to start (default claude)', { enum: AGENTS }),
      project: string('Project name or id (default: the one owning the caller directory)'),
      group: string('Front name, or the reference of a pane inside it'),
      name: string('Pane name (default: the task title, then the agent)'),
      prompt: string('First message typed into the new session'),
      todo: string('Task to tie to the new session'),
      worktree: string(
        'inherit (default), new for an isolated worktree, none for the project tree',
        {
          enum: ['inherit', 'new', 'none'],
        },
      ),
      force: flag('Take the task even when another session holds it'),
    },
    route: 'session',
    payload: (args) => ({
      agent: args.agent ?? 'claude',
      worktree: args.worktree ?? 'inherit',
      ...pick(args, ['project', 'group', 'name', 'prompt', 'todo', 'force']),
    }),
    result: (data) => data ?? {},
  },
  {
    name: 'session_close',
    description:
      'Closes one pane; its front stays open. A pane with a worktree of its own deletes it too, and needs `confirm: true`.',
    destructive: true,
    properties: { target: pane, confirm: flag('Also delete the worktree the pane owns') },
    required: ['target'],
    route: 'session/close',
    payload: (args) => ({ target: args.target, ...(args.confirm ? { confirmed: true } : {}) }),
  },
  {
    name: 'group_list',
    description: 'Fronts of work open in every project, with the panes in each.',
    readOnly: true,
    properties: {},
    route: 'group/list',
    payload: () => ({}),
    result: (data) => ({ groups: data?.groups ?? [] }),
  },
  {
    name: 'group_close',
    description:
      'Closes a front and every pane in it, the calling pane included when it sits there. A front with a worktree of its own deletes it too, and needs `confirm: true`. The answer says when the worktree stayed on disk.',
    destructive: true,
    properties: {
      target: string(
        'Front: its id from group_list, a piece of its name no other front has, or the reference of a pane inside it (pa-3576, or "current" for yours)',
        { minLength: 1 },
      ),
      confirm: flag('Also delete the worktree the front owns'),
    },
    required: ['target'],
    route: 'group/close',
    payload: (args) => ({ target: args.target, ...(args.confirm ? { confirmed: true } : {}) }),
    result: (data) => data ?? {},
  },
  {
    name: 'todo_list',
    description: 'Tasks on the board, with the short id the other todo tools take.',
    readOnly: true,
    properties: {
      project: string('Only the tasks filed under this project (name or id)'),
      status: string('Only the tasks in this status', { enum: STATUSES }),
    },
    route: 'todo/list',
    payload: (args) => pick(args, ['project']),
    result: (data, args) => ({
      todos: (data?.todos ?? [])
        .map(todoRow)
        .filter((todo) => !args.status || todo.status === args.status),
    }),
  },
  {
    name: 'todo_show',
    description: 'One task in full: notes, tags, priority, project and the session that holds it.',
    readOnly: true,
    properties: { ref },
    required: ['ref'],
    route: 'todo/show',
    payload: (args) => ({ ref: args.ref }),
    result: (data) => ({
      todo: data?.todo ? { ...data.todo, status: statusOf(data.todo) } : null,
      projectName: data?.projectName ?? null,
    }),
  },
  {
    name: 'todo_add',
    description:
      'Creates a task. Without `project` it is filed under the project owning the caller directory; a project that does not exist is an error.',
    properties: {
      title: string('Task title', { minLength: 1 }),
      tags: strings('Tags, without #'),
      project: string('Project name or id'),
      status: string('Initial status (default todo)', { enum: STATUSES }),
      priority: string('Priority (default normal)', { enum: PRIORITIES }),
      notes: string('Notes'),
      session: string(
        '"current" ties the task to the calling pane; a pane reference ties it there',
      ),
      force: flag('Take the task even when another session holds it'),
    },
    required: ['title'],
    route: 'todo',
    payload: (args) => ({
      title: args.title,
      tags: args.tags ?? [],
      ...pick(args, ['project', 'status', 'priority', 'notes', 'session', 'force']),
    }),
    result: todoResult,
  },
  {
    name: 'todo_edit',
    description: 'Changes a task. Only the fields given change; the rest stay as they are.',
    properties: {
      ref,
      title: string('New title', { minLength: 1 }),
      tags: strings('Replaces every tag'),
      addTags: strings('Tags to add'),
      removeTags: strings('Tags to remove'),
      status: string('New status', { enum: STATUSES }),
      priority: string('New priority', { enum: PRIORITIES }),
      notes: string('Replaces the notes'),
      appendNotes: string('Appended to the notes on a new line'),
      project: string('Moves the task to this project; an empty string leaves it in none'),
      session: string(
        '"current" ties the task to the calling pane; a pane reference ties it there',
      ),
      clearSession: flag('Unties the task from its session'),
      force: flag('Take the task even when another session holds it'),
    },
    required: ['ref'],
    atLeastOneOf: [
      'title',
      'tags',
      'addTags',
      'removeTags',
      'status',
      'priority',
      'notes',
      'appendNotes',
      'project',
      'session',
      'clearSession',
    ],
    route: 'todo/edit',
    payload: (args) => args,
    result: todoResult,
  },
  {
    name: 'todo_status',
    description: 'Moves a task: todo, in-progress, review or done.',
    properties: { ref, status: string('New status', { enum: STATUSES }) },
    required: ['ref', 'status'],
    route: 'todo/edit',
    payload: (args) => ({ ref: args.ref, status: args.status }),
    result: todoResult,
  },
  {
    name: 'open_url',
    description:
      'Opens a web page in the default browser and brings the browser to the front, like the "Open in browser" item of the link menu. Only http and https addresses.',
    openWorld: true,
    properties: {
      url: string('Address to open, starting with http:// or https://', { minLength: 1 }),
    },
    required: ['url'],
    run: async (args, { openUrl }) => {
      const address = webAddress(args.url)
      if (address.problem) return toolError(`open_url: ${address.problem}`)
      try {
        await openUrl(address.href)
      } catch (error) {
        return toolError(`open_url: the browser did not open: ${error?.message ?? error}`)
      }
      return toolResult({ opened: address.href })
    },
  },
  {
    name: 'project_list',
    description:
      'Projects and their directories; `current: true` marks the one owning the caller directory. Other tools take the name as `project`.',
    readOnly: true,
    properties: {},
    route: 'project/list',
    payload: () => ({}),
    result: (data) => ({ projects: data?.projects ?? [] }),
  },
]

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

function pick(source, keys) {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  )
}

/** Status as the board shows it, with `in-progress` spelled the way the tools take it. */
function statusOf(todo) {
  if (todo?.completed) return 'done'
  const status = String(todo?.status ?? 'todo').replace(/_/g, '-')
  return STATUSES.includes(status) ? status : 'todo'
}

/** A listing row: what picks a task out, not everything the task holds. */
function todoRow(todo) {
  return {
    ref: String(todo.id ?? '').slice(0, 8),
    id: todo.id,
    title: todo.title,
    status: statusOf(todo),
    priority: todo.priority ?? 'normal',
    tags: todo.tags ?? [],
    ...(todo.session?.id ? { session: String(todo.session.id).slice(0, 8) } : {}),
  }
}

/**
 * The address `open_url` hands the browser, or why it does not.
 *
 * The URL usually comes from data nobody here wrote (a pull request link read
 * from Azure DevOps), and the system opener would run a `file:` path or any
 * scheme a desktop app registered. Only web pages go through.
 */
function webAddress(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { problem: `"${value}" is not a URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { problem: `only http and https addresses open (got ${parsed.protocol})` }
  }
  return { href: parsed.href }
}

function todoResult(data) {
  const todo = data?.todo
  return { todo: todo ? { ...todoRow(todo), notes: todo.notes ?? '' } : null }
}

function toolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      ...(tool.required ? { required: tool.required } : {}),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: Boolean(tool.readOnly),
      destructiveHint: Boolean(tool.destructive),
      openWorldHint: Boolean(tool.openWorld),
    },
  }
}

/**
 * Checks arguments against the tool's schema.
 *
 * Clients are not required to validate before calling, and the command line's
 * worst habits came from accepting whatever arrived: an unknown priority became
 * `normal` and nothing said so. Anything the schema does not allow is refused.
 */
function validate(tool, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'arguments must be an object'
  }
  for (const key of Object.keys(args)) {
    if (!(key in tool.properties)) {
      return `unknown argument "${key}" (accepted: ${Object.keys(tool.properties).join(', ') || 'none'})`
    }
  }
  for (const key of tool.required ?? []) {
    if (args[key] === undefined) return `missing required argument "${key}"`
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.properties[key]
    if (spec.type === 'boolean' && typeof value !== 'boolean')
      return `"${key}" must be true or false`
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        return `"${key}" must be a list of non-empty strings`
      }
    }
    if (spec.type === 'string') {
      if (typeof value !== 'string') return `"${key}" must be a string`
      if (spec.minLength && value.trim().length < spec.minLength)
        return `"${key}" must not be empty`
      if (spec.maxLength && value.length > spec.maxLength) {
        return `"${key}" has ${value.length} characters, past the limit of ${spec.maxLength}; write it to a file and send the path`
      }
      if (spec.enum && !spec.enum.includes(value)) {
        return `"${key}" must be one of: ${spec.enum.join(', ')} (got "${value}")`
      }
    }
  }
  if (tool.atLeastOneOf && !tool.atLeastOneOf.some((key) => args[key] !== undefined)) {
    return `nothing to change: pass at least one of ${tool.atLeastOneOf.join(', ')}`
  }
  return null
}

/**
 * The frontend words its refusals for the command line. The flags that map one
 * to one onto a tool argument are renamed, and so are the commands a tool
 * covers, so the fix it suggests is one the caller can type.
 */
function forTools(message) {
  return String(message ?? '')
    .replace(/--yes\b/g, '`confirm: true`')
    .replace(/--force\b/g, '`force: true`')
    .replace(/--clear-session\b/g, '`clearSession: true`')
    .replace(/--session <id>/g, '`session: "<id>"`')
    .replace(/\barco group list\b/g, 'group_list')
    .replace(/\barco group close ("[^"]*"|[^\s"]+?)(?=[.,;:]?(?:\s|$))/g, (_, handle) => {
      const quoted = handle.startsWith('"') ? handle : `"${handle}"`
      return `group_close with \`target: ${quoted}\``
    })
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function toolResult(structured) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

/**
 * Builds the handler the listener calls for `POST /mcp`.
 *
 * `dispatch(route, payload)` is the `/cli/*` path: it resolves to what the
 * frontend answered, or `null` when it did not answer in time. `openUrl(href)`
 * hands an address to the system browser.
 */
function createMcpServer({ dispatch, version, openUrl }) {
  async function callTool(params, caller) {
    const tool = TOOLS_BY_NAME.get(params?.name)
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params?.name}` } }
    const args = params.arguments ?? {}
    const problem = validate(tool, args)
    if (problem) return { result: toolError(`${tool.name}: ${problem}`) }
    if (tool.run) return { result: await tool.run(args, { openUrl }) }

    const payload = { ...tool.payload(args), ...(caller ? { sessionId: caller } : {}) }
    const answer = await dispatch(tool.route, payload)
    if (!answer) return { result: toolError('Arco did not answer in time; is the window open?') }
    if (answer.ok === false) return { result: toolError(forTools(answer.message) || 'refused') }

    const structured = tool.result ? tool.result(answer.data, args) : {}
    if (answer.message && answer.message !== 'criada' && answer.message !== 'editada') {
      structured.message = forTools(answer.message)
    }
    if (answer.stale) structured.warning = 'Arco did not answer; this listing was read from disk'
    return { result: toolResult(structured) }
  }

  async function handleMessage(message, caller) {
    const { id, method, params } = message
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        return {
          result: {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'arco', title: 'Arco', version: version() ?? '0.0.0' },
            instructions: INSTRUCTIONS,
          },
        }
      }
      case 'ping':
        return { result: {} }
      case 'tools/list':
        return { result: { tools: TOOLS.map(toolSchema) } }
      case 'tools/call':
        return callTool(params, caller)
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` }, id }
    }
  }

  /** One HTTP request: `{ status, body }`, with `body` null for a bare 202. */
  async function handlePost(raw, caller) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return {
        status: 400,
        body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      }
    }
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0'
    ) {
      return {
        status: 400,
        body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
      }
    }
    // Notifications and responses expect no answer.
    if (message.id === undefined || message.method === undefined) return { status: 202, body: null }
    let outcome
    try {
      outcome = await handleMessage(message, caller)
    } catch (error) {
      outcome = { error: { code: -32603, message: String(error?.message ?? error).slice(0, 200) } }
    }
    return {
      status: 200,
      body: outcome.error
        ? { jsonrpc: '2.0', id: message.id, error: outcome.error }
        : { jsonrpc: '2.0', id: message.id, result: outcome.result },
    }
  }

  return { handlePost }
}

module.exports = { createMcpServer, TOOLS }
