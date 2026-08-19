// Session discovery: reads the transcript directories agent CLIs write to, the
// same files the Rust backend reads, so resume and history keep working.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Claude encodes a project path into a directory name by replacing separators. */
function claudeProjectDir(cwd) {
  const trimmed = (cwd ?? '').replace(/[/\\]+$/, '')
  const encoded = trimmed.replace(/[:\\/.]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded)
}

/**
 * The name a session shows in the sidebar.
 *
 * Claude writes an `ai-title` record once it has named the conversation; until
 * then the first thing the user typed is the best label there is — which is
 * exactly the order the Rust build uses.
 */
function sessionTitle(cwd, sessionId) {
  if (!sessionId || /[/\\.]/.test(sessionId)) return null
  const file = path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`)
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return null
  }
  let firstUserPrompt = null
  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'ai-title') {
      const title = (entry.aiTitle ?? entry.ai_title ?? '').trim()
      if (title) return title
    }
    if (entry.type === 'user' && !firstUserPrompt) {
      const content = entry?.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content.find((part) => part?.type === 'text')?.text ?? '')
            : ''
      const trimmed = text.trim()
      if (trimmed) firstUserPrompt = trimmed.slice(0, 240)
    }
  }
  return firstUserPrompt
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

function buildSessionCommands() {
  const empty = () => []
  return {
    snapshot_claude_sessions: ({ cwd }) => snapshotDir(claudeProjectDir(cwd ?? os.homedir())),
    snapshot_codex_sessions: () => snapshotDir(path.join(os.homedir(), '.codex', 'sessions')),
    snapshot_opencode_sessions: empty,
    snapshot_antigravity_sessions: empty,
    list_claude_sessions: ({ cwd }) => snapshotDir(claudeProjectDir(cwd ?? os.homedir())),
    get_claude_session_title: ({ cwd, sessionId }) => sessionTitle(cwd, sessionId),

    // Usage and cost reporting are read-only dashboards; report "no data"
    // rather than failing, until they are ported.
  }
}

module.exports = { buildSessionCommands, isInteractive }
