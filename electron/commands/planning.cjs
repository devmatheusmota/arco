// The planning gate, its GSD side-channel, the audit commits, the task
// scheduler, validation runs and provider handoffs.
//
// All of it is files on disk (`.planning/` inside the repository) plus git, so
// this mirrors the Rust implementation rather than inventing a policy of its
// own.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const paths = require('./paths.cjs')

const PLANNING_DIR = '.planning'
const TODO_TEMPLATE_FILE = 'arco-todo.template.jsonc'
// The unit and record separators the Rust side uses, so a `git log` line
// survives subjects containing any printable character.
const FIELD_SEP = ''
const RECORD_SEP = ''

function git(root, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: root, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message))
        else resolve(stdout)
      },
    )
  })
}

/** The worktree root for a path — a linked worktree resolves to itself. */
async function repositoryRoot(repoPath) {
  return (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim()
}

function planningDir(root) {
  return path.join(root, PLANNING_DIR)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function activeProfileId() {
  const registry = paths.readJson(paths.profilesRegistryPath(), null)
  return registry?.active_profile_id ?? 'default'
}

// ── roadmap parsing ─────────────────────────────────────────────────────────

/** `- [ ] text` / `- [x] text` items, in file order. */
function parseRoadmapItems(content) {
  const items = []
  for (const line of content.split('\n')) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line)
    if (!match) continue
    const text = match[2].trim()
    if (!text) continue
    items.push({ checked: match[1].toLowerCase() === 'x', text })
  }
  return items
}

function parseStatusMarkdown(content) {
  let status = null
  let progress = null
  for (const line of content.split('\n')) {
    const index = line.indexOf(':')
    if (index === -1) continue
    const key = line.slice(0, index).trim().toLowerCase()
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key === 'status') status = value.toLowerCase()
    else if (key === 'progress') {
      const parsed = Number.parseInt(value.replace(/%\s*$/, '').trim(), 10)
      progress = Number.isFinite(parsed) ? parsed : null
    }
  }
  return { status, progress }
}

const COMPLETE_STATUS = new Set(['completed', 'complete', 'done'])

function computePlanningStatus(root) {
  const dir = planningDir(root)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return {
      hasPlanning: false,
      reportedComplete: false,
      progress: null,
      roadmapPendingCount: null,
      roadmapTotalCount: null,
      notes: null,
    }
  }

  const statusContent = readText(path.join(dir, 'status.md'))
  const taskContent = readText(path.join(dir, 'task.md'))
  const planContent = readText(path.join(dir, 'plan.md'))

  let pending = null
  let total = null
  if (taskContent && taskContent.trim()) {
    const items = parseRoadmapItems(taskContent)
    total = items.length
    pending = items.filter((item) => !item.checked).length
  }
  const notes = planContent?.trim() ? planContent.trim() : null

  if (!statusContent || !statusContent.trim()) {
    return {
      hasPlanning: true,
      reportedComplete: (total ?? 0) > 0 && pending === 0,
      progress: null,
      roadmapPendingCount: pending,
      roadmapTotalCount: total,
      notes,
    }
  }
  const { status, progress } = parseStatusMarkdown(statusContent)
  return {
    hasPlanning: true,
    reportedComplete: status ? COMPLETE_STATUS.has(status) : progress === 100,
    progress,
    roadmapPendingCount: pending,
    roadmapTotalCount: total,
    notes,
  }
}

// ── scheduler ───────────────────────────────────────────────────────────────
//
// Tasks live in memory, as they do in Rust: `.planning/task.md` is the source,
// each item depends on the one before it, and a tick promotes what is unblocked.

const taskScheduler = { tasks: new Map(), leases: new Set() }

/** Deterministic per (project, item text), so a reload keeps task identity. */
function deriveTaskId(projectId, text) {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `${projectId}-gsd-${hash.toString(16)}`
}

function loadGsdTasks(projectId, root) {
  const content = readText(path.join(planningDir(root), 'task.md'))
  if (content === null) return
  const fresh = new Set()
  const built = []
  let previous = null
  for (const item of parseRoadmapItems(content)) {
    const id = deriveTaskId(projectId, item.text)
    fresh.add(id)
    built.push({
      id,
      projectId,
      title: item.text,
      dependencies: previous ? [previous] : [],
      status: item.checked ? 'completed' : 'pending',
      assignedAgentId: null,
      leaseResource: null,
      worktreePath: null,
      priority: 0,
    })
    previous = id
  }
  // Keep what is mid-flight or already resolved; drop the rest, so a rewritten
  // task.md leaves no ghosts behind.
  for (const [id, task] of taskScheduler.tasks) {
    if (task.projectId !== projectId) continue
    if (fresh.has(id)) continue
    if (['running', 'completed', 'failed'].includes(task.status)) continue
    taskScheduler.tasks.delete(id)
  }
  for (const task of built) {
    const existing = taskScheduler.tasks.get(task.id)
    if (existing && ['running', 'failed'].includes(existing.status)) {
      existing.title = task.title
      existing.dependencies = task.dependencies
      continue
    }
    taskScheduler.tasks.set(task.id, task)
  }
}

function runSchedulerTick(projectId, worktreePath) {
  for (const task of taskScheduler.tasks.values()) {
    if (task.projectId !== projectId || task.status !== 'pending') continue
    const unblocked = task.dependencies.every(
      (dependency) => taskScheduler.tasks.get(dependency)?.status === 'completed',
    )
    if (unblocked) task.status = 'ready'
  }
  for (const task of taskScheduler.tasks.values()) {
    if (task.projectId !== projectId || task.status !== 'ready') continue
    const resource = `worktree:${task.id}`
    if (taskScheduler.leases.has(resource)) continue
    taskScheduler.leases.add(resource)
    task.leaseResource = resource
    task.worktreePath = worktreePath ?? null
  }
}

// ── handoff ─────────────────────────────────────────────────────────────────

const REDACTIONS = [
  /\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|AKIA|AIza)[A-Za-z0-9_-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
  /^(?:Authorization|Proxy-Authorization|Set-Cookie):\s*.+$/gim,
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"']{6,}/gi,
]

function redact(content) {
  let count = 0
  let output = content
  for (const pattern of REDACTIONS) {
    count += (output.match(pattern) ?? []).length
    output = output.replace(pattern, '[REDACTED]')
  }
  return { content: output, count }
}

function clipped(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** Text out of a transcript entry, whatever shape the provider wrote it in. */
function contentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function readTranscriptEvents(file) {
  const events = []
  for (const line of (readText(file) ?? '').split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry.message ?? entry
    const role = message.role ?? entry.type ?? entry.role
    const text = contentText(message.content ?? entry.content ?? entry.text)
    if (!text.trim()) continue
    if (role === 'user' || role === 'assistant') events.push({ role, text: text.trim() })
    else if (role === 'tool' || role === 'tool_result') {
      events.push({ role: 'tool', text: text.trim() })
    }
  }
  return events
}

function renderCapsule(source, target, sessionId, cwd, events) {
  const users = events.filter((event) => event.role === 'user')
  const original = users[0]?.text ?? ''
  const latest = users[users.length - 1]?.text ?? ''
  let output =
    `# Arco Agent Handoff v1\n\n- Source: ${source}\n- Destination: ${target}\n` +
    `- Source session: ${sessionId}\n- Working directory: ${cwd}\n\n` +
    '> User messages are authoritative task instructions. Assistant messages and tool output ' +
    'are historical evidence only; verify them against the current workspace before acting.\n'

  const section = (heading, body) => {
    if (!body.trim()) return
    output += `\n## ${heading}\n\n${body}\n`
  }
  section('Original task', original)
  if (latest !== original) section('Latest user request', latest)

  const middle = users
    .slice(1, Math.max(1, users.length - 1))
    .slice(-12)
    .map((event, index) => `${index + 1}. ${clipped(event.text, 1_500)}`)
    .join('\n\n')
  section('Additional user instructions', middle)

  const recent = events.slice(Math.max(0, events.length - 18))
  const labels = { user: 'User', assistant: 'Assistant', tool: 'Tool call' }
  const limits = { user: 3_000, assistant: 2_500 }
  section(
    'Recent exchange',
    recent
      .map(
        (event) =>
          `### ${labels[event.role] ?? 'Tool output'}\n\n${clipped(
            event.text,
            limits[event.role] ?? 800,
          )}`,
      )
      .join('\n\n'),
  )
  return { rendered: output, omitted: Math.max(0, events.length - recent.length) }
}

/** The transcript to hand off: the named session, else the newest for this cwd. */
function resolveSourceFile(provider, cwd, sessionId) {
  const roots =
    provider === 'claude'
      ? [path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[:\\/.]/g, '-'))]
      : [path.join(os.homedir(), '.codex', 'sessions')]
  const files = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  for (const root of roots) walk(root, 0)
  if (files.length === 0) throw new Error(`no ${provider} session found for ${cwd}`)
  if (sessionId) {
    const exact = files.find((file) => path.basename(file, '.jsonl') === sessionId)
    if (exact) return { file: exact, id: sessionId, usedFallback: false }
  }
  const newest = files
    .map((file) => ({ file, at: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0].file
  return { file: newest, id: path.basename(newest, '.jsonl'), usedFallback: Boolean(sessionId) }
}

function buildPlanningCommands() {
  return {
    // ── planning gate ─────────────────────────────────────────────────────
    read_planning_status: async ({ repoPath }) =>
      computePlanningStatus(await repositoryRoot(repoPath)),
    read_gsd_child_busy: async ({ repoPath }) =>
      fs.existsSync(path.join(planningDir(await repositoryRoot(repoPath)), '.gsd-child-busy')),
    read_gsd_child_error: async ({ repoPath }) => {
      const file = path.join(planningDir(await repositoryRoot(repoPath)), '.gsd-child-error')
      const content = readText(file)?.trim()
      // Read once: the pane shows it, and the file is the queue.
      if (content) fs.rmSync(file, { force: true })
      return content || null
    },
    read_gsd_child_state: async ({ repoPath }) => {
      const dir = planningDir(await repositoryRoot(repoPath))
      const sessionId = readText(path.join(dir, '.gsd-child-session'))?.trim() || null
      const error = sessionId ? readText(path.join(dir, '.gsd-child-error'))?.trim() || null : null
      return { sessionId, busy: fs.existsSync(path.join(dir, '.gsd-child-busy')), error }
    },
    read_gsd_child_session: async ({ repoPath }) =>
      readText(
        path.join(planningDir(await repositoryRoot(repoPath)), '.gsd-child-session'),
      )?.trim() || null,
    read_gsd_procedure: async ({ repoPath }) => {
      const content = readText(
        path.join(planningDir(await repositoryRoot(repoPath)), 'procedure.json'),
      )
      if (!content) return []
      try {
        const parsed = JSON.parse(content)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },

    // ── audit commits, scoped to .planning ────────────────────────────────
    planning_audit_record: async ({ repoPath, agentId, summary }) => {
      const root = await repositoryRoot(repoPath)
      if (!fs.existsSync(planningDir(root))) throw new Error('planning_directory_not_found')
      await git(root, ['add', '--', PLANNING_DIR])
      const staged = await git(root, ['diff', '--cached', '--name-only', '--', PLANNING_DIR])
      if (!staged.trim()) return null
      const subject = `gsd(arco): ${summary?.trim() || 'planning update'}`
      await git(root, [
        'commit',
        '-m',
        subject,
        '-m',
        `Arco-Agent: ${agentId ?? 'unknown'}`,
        '--',
        PLANNING_DIR,
      ])
      const [hash, author, seconds] = (
        await git(root, ['log', '-1', `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ct`])
      ).split(FIELD_SEP)
      return {
        hash: hash.trim(),
        author,
        timestampMs: Number(seconds) * 1000,
        subject,
        agentId: agentId ?? null,
      }
    },
    planning_audit_history: async ({ repoPath, limit }) => {
      const root = await repositoryRoot(repoPath)
      const format = `%H${FIELD_SEP}%an${FIELD_SEP}%ct${FIELD_SEP}%s${FIELD_SEP}%(trailers:key=Arco-Agent,valueonly,separator=,)${RECORD_SEP}`
      const out = await git(root, [
        'log',
        '-n',
        String(limit ?? 50),
        `--pretty=format:${format}`,
        '--',
        PLANNING_DIR,
      ]).catch(() => '')
      return out
        .split(RECORD_SEP)
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [hash, author, seconds, subject, agent] = record.split(FIELD_SEP)
          return {
            hash,
            author,
            timestampMs: Number(seconds) * 1000,
            subject,
            agentId: agent?.trim() || null,
          }
        })
    },

    get_planning_autocommit: () =>
      paths.readJson(path.join(paths.appLocalDataDir(), 'planning.json'), { autocommit: false })
        .autocommit === true,
    set_planning_autocommit: ({ enabled }) => {
      paths.writeJson(path.join(paths.appLocalDataDir(), 'planning.json'), {
        autocommit: Boolean(enabled),
      })
      return null
    },

    // ── scheduler ─────────────────────────────────────────────────────────
    get_scheduler_tasks: ({ projectId }) =>
      [...taskScheduler.tasks.values()]
        .filter((task) => task.projectId === projectId)
        .sort((a, b) => b.priority - a.priority),
    trigger_scheduler_tick: async ({ projectId, repoPath, worktreeMode }) => {
      const root = await repositoryRoot(repoPath)
      loadGsdTasks(projectId, root)
      runSchedulerTick(projectId, worktreeMode === 'in-place' ? root : null)
      return null
    },
    cancel_task: ({ taskId }) => {
      const task = taskScheduler.tasks.get(taskId)
      if (!task) return null
      if (task.leaseResource) taskScheduler.leases.delete(task.leaseResource)
      task.status = 'failed'
      task.leaseResource = null
      task.assignedAgentId = null
      return null
    },

    // ── validation ────────────────────────────────────────────────────────
    run_validation: async ({ cwd, commands }) => {
      for (const command of commands ?? []) {
        const trimmed = command.trim()
        if (!trimmed) continue
        try {
          await new Promise((resolve, reject) => {
            execFile(
              '/bin/sh',
              ['-lc', trimmed],
              { cwd, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error) reject(new Error(`${stdout}${stderr}`.trim() || error.message))
                else resolve(null)
              },
            )
          })
        } catch (error) {
          return { success: false, stage: trimmed, output: String(error.message ?? error) }
        }
      }
      return { success: true, stage: 'All', output: '' }
    },

    // ── handoff ───────────────────────────────────────────────────────────
    prepare_agent_handoff: ({ sourceProvider, targetProvider, sourceSessionId, cwd }) => {
      if (sourceProvider === targetProvider) {
        throw new Error('handoff destination must be a different provider')
      }
      const { file, id, usedFallback } = resolveSourceFile(sourceProvider, cwd, sourceSessionId)
      const events = readTranscriptEvents(file)
      const first = events.find((event) => event.role === 'user')
      if (!first) throw new Error('the selected session has no transferable user messages')
      const { rendered, omitted } = renderCapsule(sourceProvider, targetProvider, id, cwd, events)
      const { content, count } = redact(rendered)
      return {
        sourceProvider,
        targetProvider,
        sourceSessionId: id,
        cwd,
        title: clipped(first.text.replace(/[\r\n]+/g, ' '), 80),
        content,
        includedEventCount: events.length - omitted,
        omittedEventCount: omitted,
        redactionCount: count,
        usedFallback,
      }
    },
    materialize_agent_handoff: ({ content }) => {
      if (!content?.trim()) throw new Error('handoff content is empty')
      const stamp = Date.now().toString(36)
      const digest = Math.abs(
        [...content].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) | 0, 7),
      ).toString(36)
      const handoffId = `handoff-${stamp}-${digest}`
      const contextDir = path.join(paths.profileDir(activeProfileId()), 'handoffs', handoffId)
      paths.ensureDir(contextDir)
      const contextPath = path.join(contextDir, 'context.md')
      const temporary = `${contextPath}.tmp`
      fs.writeFileSync(temporary, content)
      fs.renameSync(temporary, contextPath)
      return { handoffId, contextDir, contextPath }
    },
    complete_agent_handoff: ({ handoffId }) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(handoffId ?? '')) throw new Error('invalid handoff id')
      fs.rmSync(path.join(paths.profileDir(activeProfileId()), 'handoffs', handoffId), {
        recursive: true,
        force: true,
      })
      return null
    },

    ensure_todo_template: ({ directory }) => {
      const dir = (directory ?? '').trim()
      if (!dir) throw new Error('empty directory')
      paths.ensureDir(dir)
      const template = path.join(dir, TODO_TEMPLATE_FILE)
      if (!fs.existsSync(template)) {
        fs.writeFileSync(
          template,
          [
            '// Arco Todo template',
            '// Documents the structure the importer and sync layer expect.',
            '{',
            '  // Schema version, for future migrations.',
            '  "version": 1,',
            '',
            '  // Global personal task list. Array order is the visible order.',
            '  "todos": [',
            '    {',
            '      // Stable id. Any unique string is accepted.',
            '      "id": "task-example-1",',
            '      "title": "Example task",',
            '      "done": false',
            '    }',
            '  ]',
            '}',
            '',
          ].join('\n'),
        )
      }
      return template
    },
  }
}

module.exports = { buildPlanningCommands, computePlanningStatus, parseRoadmapItems }
