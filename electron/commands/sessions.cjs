// Session discovery: reads the transcript directories agent CLIs write to, the
// same files the Rust backend reads, so resume and history keep working.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

/** Past this length Claude cuts the directory name and appends a hash of the full path. */
const CLAUDE_PROJECT_DIR_MAX = 200

/** Java's `String.hashCode`, the hash Claude uses to tell long paths apart. */
function claudePathHash(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

/**
 * The directory Claude writes a project's transcripts to.
 *
 * Every character that is not an ASCII letter or digit becomes `-`, not only
 * the separators: a worktree named `cl-uVV6_A` lives under `...cl-uVV6-A`.
 * Missing that directory means every session in it reads as gone, and a pane
 * that points at one reopens on a blank conversation.
 */
function claudeProjectDir(cwd) {
  const trimmed = (cwd ?? '').replace(/[/\\]+$/, '')
  const encoded = trimmed.replace(/[^a-zA-Z0-9]/g, '-')
  const name =
    encoded.length <= CLAUDE_PROJECT_DIR_MAX
      ? encoded
      : `${encoded.slice(0, CLAUDE_PROJECT_DIR_MAX)}-${claudePathHash(trimmed)}`
  return path.join(os.homedir(), '.claude', 'projects', name)
}

/**
 * A transcript line can be tens of MB — a pasted file, an image payload, a tool
 * result. Holding a whole one in memory is what made a scan over a project's
 * history allocate gigabytes, so a line is capped and the rest of it dropped.
 */
const MAX_LINE_CHARS = 2 * 1024 * 1024

/** A record's own fields come before `message`, so its type sits near the start. */
const HEADER_CHARS = 4 * 1024

const RECORD_TYPE = /"type":"(user|assistant|ai-title)"/

/**
 * Reads a file line by line, capping each line, without loading it whole.
 * `onLine` returning `true` stops the read there.
 */
function forEachLine(file, onLine) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return
  }
  const decoder = new StringDecoder('utf8')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let line = ''
  let truncated = false

  const append = (part) => {
    if (!part) return
    if (line.length + part.length <= MAX_LINE_CHARS) {
      line += part
      return
    }
    line += part.slice(0, MAX_LINE_CHARS - line.length)
    truncated = true
  }
  let stopped = false
  const flush = () => {
    if (line && onLine(line, truncated) === true) stopped = true
    line = ''
    truncated = false
  }

  try {
    let read
    while (!stopped && (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const text = decoder.write(chunk.subarray(0, read))
      let from = 0
      for (;;) {
        const index = text.indexOf('\n', from)
        if (index === -1) break
        append(text.slice(from, index))
        flush()
        if (stopped) break
        from = index + 1
      }
      if (!stopped) append(text.slice(from))
    }
    if (!stopped) {
      append(decoder.end())
      flush()
    }
  } catch {
    // A transcript written while it is read can fail mid-scan; keep what the
    // scan already collected instead of dropping the session from the list.
  } finally {
    fs.closeSync(fd)
  }
}

function firstTextBlock(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const content = entry?.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find((part) => part?.type === 'text')?.text ?? '')
        : ''
  return text.trim() || null
}

/**
 * `<command-name>`, `<local-command-stdout>` and the caveat the CLI prepends to
 * a command run are injected text, not a prompt someone typed, and naming a
 * session after one of them says nothing about the conversation.
 */
function isTypedPrompt(text) {
  return !text.startsWith('<') && !text.startsWith('Caveat:')
}

/**
 * Title, first prompt and message count of one transcript, in a single pass.
 *
 * Claude appends an `ai-title` record once it has named the conversation and
 * renames it as the conversation grows, so the last one is the current name;
 * before the first one the earliest thing the user typed is the best label
 * there is. Records are recognized by the head of the line instead of parsing
 * every one of them — a full value tree per record is what makes this scan
 * expensive over a project's whole history.
 */
function readSessionMeta(file) {
  let title = null
  let firstUserPrompt = null
  let messageCount = 0

  forEachLine(file, (line, truncated) => {
    const match = RECORD_TYPE.exec(line.length > HEADER_CHARS ? line.slice(0, HEADER_CHARS) : line)
    if (!match) return

    if (match[1] === 'ai-title') {
      if (truncated) return
      try {
        const entry = JSON.parse(line)
        const value = (entry.aiTitle ?? entry.ai_title ?? '').trim()
        if (value) title = value
      } catch {
        // The header matched text inside a payload, not a record of its own.
      }
      return
    }

    messageCount += 1
    if (match[1] !== 'user' || firstUserPrompt !== null || truncated) return
    const text = firstTextBlock(line)
    if (text && isTypedPrompt(text)) firstUserPrompt = text.slice(0, 240)
  })

  return { title, first_user_prompt: firstUserPrompt, message_count: messageCount }
}

/**
 * Feeds `onLine` every complete line of `file` from byte `start`, and returns the
 * byte offset just past the last one. A line longer than `MAX_LINE_CHARS` bytes
 * arrives cut, flagged as such; the partial line at the end is left for the next
 * call, since the writer is still appending it.
 */
function forEachLineFrom(file, start, onLine) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return start
  }
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let position = start
  let consumed = start
  let carry = []
  let carryLength = 0
  let truncated = false
  try {
    let read
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, position)) > 0) {
      let from = 0
      for (;;) {
        const index = chunk.indexOf(10, from)
        if (index === -1 || index >= read) break
        const tail = chunk.subarray(from, index)
        const line = carryLength > 0 ? Buffer.concat([...carry, tail]) : tail
        onLine(line, truncated)
        consumed = position + index + 1
        carry = []
        carryLength = 0
        truncated = false
        from = index + 1
      }
      if (from < read) {
        const room = MAX_LINE_CHARS - carryLength
        if (room > 0) {
          const kept = Buffer.from(chunk.subarray(from, Math.min(read, from + room)))
          carry.push(kept)
          carryLength += kept.length
        }
        if (read - from > room) truncated = true
      }
      position += read
    }
  } catch {
    // Keep what was read; the next call resumes from `consumed`.
  } finally {
    fs.closeSync(fd)
  }
  return consumed
}

/**
 * What the title scan learned of each transcript, and how far it read.
 *
 * Transcripts only grow, and the sidebar asks for a title again on every mount
 * of a pane and on a backoff while a session has none. Reading a 50 MB
 * conversation from the top each time, on the main process, is what that used
 * to cost; now each call reads the bytes appended since the last one.
 */
const titleScans = new Map()

function scanTitle(file) {
  let stats
  try {
    stats = fs.statSync(file)
  } catch {
    titleScans.delete(file)
    return { title: null, first_user_prompt: null }
  }
  let scan = titleScans.get(file)
  // Shorter than what was read: rewritten, not appended. Start over.
  if (!scan || stats.size < scan.offset) {
    scan = { offset: 0, title: null, first_user_prompt: null }
  }
  if (stats.size > scan.offset) {
    scan.offset = forEachLineFrom(file, scan.offset, (buffer, truncated) => {
      const head = buffer.toString('utf8', 0, Math.min(buffer.length, HEADER_CHARS))
      const match = RECORD_TYPE.exec(head)
      if (!match || truncated) return
      if (match[1] === 'ai-title') {
        try {
          const entry = JSON.parse(buffer.toString('utf8'))
          const value = (entry.aiTitle ?? entry.ai_title ?? '').trim()
          if (value) scan.title = value
        } catch {
          // The header matched text inside a payload, not a record of its own.
        }
        return
      }
      if (match[1] !== 'user' || scan.first_user_prompt !== null) return
      const text = firstTextBlock(buffer.toString('utf8'))
      if (text && isTypedPrompt(text)) scan.first_user_prompt = text.slice(0, 240)
    })
  }
  titleScans.set(file, scan)
  return scan
}

/** The name a session shows in the sidebar. */
function sessionTitle(cwd, sessionId) {
  if (!sessionId || /[/\\.]/.test(sessionId)) return null
  const scan = scanTitle(path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`))
  return scan.title ?? scan.first_user_prompt
}

// ── Codex transcripts ─────────────────────────────────────────────────────

function codexSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions')
}

/** Codex nests a rollout under `sessions/<year>/<month>/<day>`, so the walk recurses. */
function collectJsonlFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectJsonlFiles(full, out, depth + 1)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/** Reads the head of a file, up to the first newline. */
function readFirstLine(file, maxBytes = 64 * 1024) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const chunk = Buffer.allocUnsafe(maxBytes)
    const read = fs.readSync(fd, chunk, 0, maxBytes, 0)
    if (read <= 0) return null
    const text = chunk.toString('utf8', 0, read)
    const index = text.indexOf('\n')
    return index === -1 ? text : text.slice(0, index)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The id and working directory a rollout opens with, memoized by path.
 *
 * The snapshot runs on every spawn and again on the timer that waits for a new
 * session to appear, while Codex keeps every project's rollouts in one tree —
 * re-reading all of them each pass is what that costs. A rollout never changes
 * its own header, so the first read is the only one a file needs.
 */
const codexMetaByFile = new Map()

function codexSessionMeta(file) {
  const cached = codexMetaByFile.get(file)
  if (cached !== undefined) return cached
  const line = readFirstLine(file)
  let meta = null
  if (line) {
    try {
      const entry = JSON.parse(line)
      const payload = entry?.type === 'session_meta' ? entry.payload : null
      const id = payload?.id ?? payload?.session_id
      if (typeof id === 'string' && typeof payload?.cwd === 'string') {
        meta = { id, cwd: payload.cwd }
      }
    } catch {
      // A rollout truncated mid-write has no header to read yet.
    }
  }
  // Only a header that parsed is worth keeping. Caching its absence would pin a
  // session created moments before this pass as unreadable for the rest of the
  // run, which is exactly the session the discovery timer is waiting for.
  if (meta) codexMetaByFile.set(file, meta)
  return meta
}

/** Compares two working directories the way the platform compares paths. */
function normalizeCwd(cwd) {
  const trimmed = (cwd ?? '').trim().replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
}

/** Every Codex session started in `cwd`, newest first. */
function snapshotCodexSessions(cwd) {
  const target = normalizeCwd(cwd)
  if (!target) return []

  const files = collectJsonlFiles(codexSessionsDir())
    .map((file) => {
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        return null
      }
      return { file, modified_at_ms: stats.mtimeMs, size_bytes: stats.size }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)

  const seen = new Set()
  const sessions = []
  for (const entry of files) {
    const meta = codexSessionMeta(entry.file)
    if (!meta || normalizeCwd(meta.cwd) !== target || seen.has(meta.id)) continue
    seen.add(meta.id)
    sessions.push({
      id: meta.id,
      cwd: meta.cwd,
      modified_at_ms: entry.modified_at_ms,
      size_bytes: entry.size_bytes,
    })
  }
  return sessions
}

/** The rollout of one session, found by the id its file name carries. */
function codexSessionFile(sessionId) {
  const files = collectJsonlFiles(codexSessionsDir())
  const named = files.filter((file) => path.basename(file).includes(sessionId))
  for (const file of named.length > 0 ? named : files) {
    if (codexSessionMeta(file)?.id === sessionId) return file
  }
  return null
}

/**
 * `# AGENTS.md instructions`, `<skill>` and `<environment_context>` reach the
 * model as user messages but are injected by the CLI, and naming a session
 * after one of them says nothing about the conversation.
 */
function isTypedCodexPrompt(text) {
  return !text.startsWith('<') && !text.startsWith('# AGENTS.md')
}

/** The earliest thing someone typed into a rollout. */
function codexFirstPrompt(file) {
  let prompt = null
  forEachLine(file, (line, truncated) => {
    if (prompt !== null || truncated || !line.includes('"role":"user"')) return
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const payload = entry?.payload
    if (payload?.type !== 'message' || payload.role !== 'user') return
    const content = Array.isArray(payload.content) ? payload.content : []
    const text = content.find((part) => typeof part?.text === 'string')?.text?.trim()
    if (text && isTypedCodexPrompt(text)) prompt = text.slice(0, 240)
  })
  return prompt
}

/**
 * The name a Codex session shows in the sidebar.
 *
 * Codex names a thread in `session_index.jsonl` and appends a line every time
 * it renames one, so the last entry for an id is the current name. Before the
 * first one the earliest typed prompt is the best label there is — the same
 * order `sessionTitle` follows for Claude.
 */
function codexSessionTitle(sessionId) {
  if (!sessionId || /[/\\]/.test(sessionId)) return null

  let title = null
  forEachLine(path.join(os.homedir(), '.codex', 'session_index.jsonl'), (line, truncated) => {
    if (truncated || !line.includes(sessionId)) return
    try {
      const entry = JSON.parse(line)
      if (entry?.id !== sessionId) return
      const value = String(entry.thread_name ?? '').trim()
      if (value) title = value
    } catch {
      // A line written while the index is read is skipped, not fatal.
    }
  })
  if (title) return title

  const file = codexSessionFile(sessionId)
  return file ? codexFirstPrompt(file) : null
}

/** How far into a transcript the snapshot looks for its first prompt. */
const HEAD_RECORDS = 20

/**
 * The records at the head of a transcript, up to and including the first one
 * someone sent. That record is all `isInteractive` and `firstUserText` read, so
 * the scan stops there instead of loading the rest: a project's transcripts add
 * up to hundreds of MB, and this runs on the main process, where every
 * keystroke and every byte of terminal output waits for it.
 */
function readHeadEntries(file, limit = HEAD_RECORDS) {
  const entries = []
  forEachLine(file, (line) => {
    let entry = null
    try {
      entry = JSON.parse(line)
    } catch {
      // A capped line is not valid JSON; it still counts toward the limit.
    }
    entries.push(entry)
    return entry?.type === 'user' || entries.length >= limit
  })
  return entries
}

/**
 * Whether a transcript belongs to a conversation someone typed.
 *
 * Automated runs — `/security-review`, agent SDK calls — land in the same
 * project directory as the real conversations and are usually the most recent
 * file there. A pane looking for "the newest session with content" would pick
 * one of those and show the user a review instead of their own work, so the
 * entrypoint the transcript records is what tells the two apart.
 */
function isInteractive(entries) {
  for (const entry of entries) {
    if (entry?.type !== 'user') continue
    if (typeof entry.entrypoint === 'string') return entry.entrypoint === 'cli'
    if (typeof entry.promptSource === 'string') return entry.promptSource !== 'sdk'
    return true
  }
  // Nothing to judge by — an unreadable or brand new transcript is taken at
  // face value, the same way `hasTranscript` treats a missing size.
  return true
}

function firstUserText(entries) {
  for (const entry of entries) {
    const content = entry?.message?.content
    if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 120)
    if (Array.isArray(content)) {
      const text = content.find((part) => part?.type === 'text')?.text
      if (text?.trim()) return text.trim().slice(0, 120)
    }
  }
  return ''
}

/**
 * What the head of each transcript said, per directory and file name.
 *
 * The first prompt of a transcript never changes once it is written, so a file
 * whose head already held one is never opened again; one that did not yet is
 * read again only when it has grown. The snapshot runs on every pane spawn and
 * again on a timer for as long as a Claude pane is open, so after the first
 * pass it costs a directory listing and a stat per file.
 */
const headCache = new Map()

function transcriptHead(cache, file, size) {
  const cached = cache.get(file)
  if (cached && (cached.settled || cached.size === size)) return cached
  const entries = readHeadEntries(file)
  const head = {
    size,
    settled: entries.some((entry) => entry?.type === 'user'),
    preview: firstUserText(entries),
    interactive: isInteractive(entries),
  }
  cache.set(file, head)
  return head
}

function snapshotDir(dir, extension = '.jsonl') {
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(extension))
  } catch {
    headCache.delete(dir)
    return []
  }
  const previous = headCache.get(dir) ?? new Map()
  // Rebuilt from this listing, so a transcript deleted from disk leaves the cache too.
  const current = new Map()
  const sessions = names
    .map((name) => {
      const file = path.join(dir, name)
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        return null
      }
      const head = transcriptHead(previous, file, stats.size)
      current.set(file, head)
      return {
        id: path.basename(name, extension),
        preview: head.preview,
        modified_at_ms: stats.mtimeMs,
        size_bytes: stats.size,
        interactive: head.interactive,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)
  headCache.set(dir, current)
  return sessions
}

/**
 * Every session in a project directory, named the way the history modal shows
 * it. `snapshotDir` reads only the head of each file because it runs on every
 * spawn; a name and a message count need the whole transcript, so the listing
 * someone opens on purpose gets its own pass.
 */
function listClaudeSessions(dir) {
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const sessions = names
    .map((name) => {
      const file = path.join(dir, name)
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        return null
      }
      const meta = readSessionMeta(file)
      return {
        id: path.basename(name, '.jsonl'),
        title: meta.title,
        first_user_prompt: meta.first_user_prompt,
        message_count: meta.message_count,
        modified_at_ms: stats.mtimeMs,
        size_bytes: stats.size,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)

  // A transcript that holds a header and no message — the CLI recreating one
  // whose file was deleted, or a session that died before the first prompt —
  // has nothing to come back to, and offering it means resuming an id that
  // opens an empty conversation. Hidden only when the directory proves the scan
  // works, so a future transcript format cannot empty the whole list.
  const withMessages = sessions.filter((session) => session.message_count > 0)
  return withMessages.length > 0 ? withMessages : sessions
}

function buildSessionCommands() {
  const empty = () => []
  return {
    snapshot_claude_sessions: ({ cwd }) => snapshotDir(claudeProjectDir(cwd ?? os.homedir())),
    snapshot_codex_sessions: ({ cwd }) => snapshotCodexSessions(cwd ?? os.homedir()),
    snapshot_opencode_sessions: empty,
    snapshot_antigravity_sessions: empty,
    list_claude_sessions: ({ cwd }) => listClaudeSessions(claudeProjectDir(cwd ?? os.homedir())),
    get_claude_session_title: ({ cwd, sessionId }) => sessionTitle(cwd, sessionId),
    get_codex_session_title: ({ sessionId }) => codexSessionTitle(sessionId),

    // Usage and cost reporting are read-only dashboards; report "no data"
    // rather than failing, until they are ported.
  }
}

module.exports = {
  buildSessionCommands,
  claudeProjectDir,
  codexSessionTitle,
  isInteractive,
  listClaudeSessions,
  readSessionMeta,
  sessionTitle,
  snapshotClaudeDir: snapshotDir,
  snapshotCodexSessions,
}
