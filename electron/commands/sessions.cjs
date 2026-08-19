// Session discovery: reads the transcript directories agent CLIs write to, the
// same files the Rust backend reads, so resume and history keep working.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

/** Claude encodes a project path into a directory name by replacing separators. */
function claudeProjectDir(cwd) {
  const trimmed = (cwd ?? '').replace(/[/\\]+$/, '')
  const encoded = trimmed.replace(/[:\\/.]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded)
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

/** Reads a file line by line, capping each line, without loading it whole. */
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
  const flush = () => {
    if (line) onLine(line, truncated)
    line = ''
    truncated = false
  }

  try {
    let read
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const text = decoder.write(chunk.subarray(0, read))
      let from = 0
      for (;;) {
        const index = text.indexOf('\n', from)
        if (index === -1) break
        append(text.slice(from, index))
        flush()
        from = index + 1
      }
      append(text.slice(from))
    }
    append(decoder.end())
    flush()
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

/** The name a session shows in the sidebar. */
function sessionTitle(cwd, sessionId) {
  if (!sessionId || /[/\\.]/.test(sessionId)) return null
  const meta = readSessionMeta(path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`))
  return meta.title ?? meta.first_user_prompt
}

function readJsonl(file, limit = 40) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(0, limit).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
  } catch {
    return []
  }
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

function snapshotDir(dir, extension = '.jsonl') {
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(extension))
  } catch {
    return []
  }
  return names
    .map((name) => {
      const file = path.join(dir, name)
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        return null
      }
      const entries = readJsonl(file, 20)
      return {
        id: path.basename(name, extension),
        preview: firstUserText(entries),
        modified_at_ms: stats.mtimeMs,
        message_count: entries.length,
        size_bytes: stats.size,
        interactive: isInteractive(entries),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)
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
    snapshot_codex_sessions: () => snapshotDir(path.join(os.homedir(), '.codex', 'sessions')),
    snapshot_opencode_sessions: empty,
    snapshot_antigravity_sessions: empty,
    list_claude_sessions: ({ cwd }) => listClaudeSessions(claudeProjectDir(cwd ?? os.homedir())),
    get_claude_session_title: ({ cwd, sessionId }) => sessionTitle(cwd, sessionId),

    // Usage and cost reporting are read-only dashboards; report "no data"
    // rather than failing, until they are ported.
  }
}

module.exports = { buildSessionCommands, isInteractive, listClaudeSessions, readSessionMeta }
