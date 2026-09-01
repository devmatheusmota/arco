// What a session is called, in one place.
//
// Three surfaces used to answer this question differently: the sidebar showed
// the title the agent generated for the conversation, the tab lane mirrored it,
// and Find/Jump searched `terminal.name`. So a name read on screen could not be
// found by typing it, and renaming a pane appeared to do nothing at all — the
// rename writes `terminal.name`, which the sidebar reached last, behind a chain
// that never ran out.

import { AGENT_TYPE_LABELS, type SubTab, type Terminal } from './types'

/** Prefixes that mark a title as context the agent echoed back, not a subject. */
const ECHOED_CONTEXT = [
  'base directory for this skill',
  'you are an ai assistant',
  'system prompt',
  'the user',
  'caveat:',
]

/**
 * Openers that repeat across tasks and say nothing about which one this is.
 *
 * A bracketed tag is always a tag. A bare word only counts as a prefix when a
 * separator follows it: "Bug mesa trancada sem ocupante" is a subject that
 * happens to start with "Bug", while "Bug: mesa trancada" is a label plus one.
 */
const STRUCTURAL_PREFIX =
  /^(?:\[[^\]]{1,16}\]\s*|(?:task|tarefa|bug|fix|feat|chore|docs)\s*[:\-–]\s+)/i

const GENERIC_NAMES = new Set(
  [...Object.values(AGENT_TYPE_LABELS), ...Object.keys(AGENT_TYPE_LABELS)].map((label) =>
    label.toLowerCase(),
  ),
)

/** Whether a name is a placeholder the app picked rather than a subject. */
export function isGenericSessionName(name: string): boolean {
  return GENERIC_NAMES.has(name.trim().toLowerCase())
}

/**
 * The part of a path worth showing when the whole thing does not fit.
 *
 * A path identifies by its end, so cutting the tail throws away the only part
 * that distinguishes it: `/home/mota/.claude/skills/pr-review` and a dozen
 * siblings all truncate to the same `/home/mota/.clau…`.
 */
function shortenPath(value: string, max: number): string {
  const segments = value.split('/').filter(Boolean)
  const base = segments[segments.length - 1] ?? value
  if (base.length >= max) return base.slice(0, max - 1) + '…'
  const head = value.startsWith('/') ? '/' : ''
  return `${head}…/${base}`
}

/** Whether the text reads as a filesystem path rather than prose. */
function looksLikePath(value: string): boolean {
  return /^[~/]|^[A-Za-z]:\\/.test(value) || (value.includes('/') && !value.includes(' '))
}

/**
 * The conversation title, reduced to the part that identifies it — or `null`
 * when there is nothing worth showing.
 *
 * Agents name a conversation after whatever opened it, which is often the
 * context the app injected rather than the work: a title beginning "Base
 * directory for this skill: /home/..." names every session started from a
 * skill, so it is rejected outright instead of being truncated more cleverly.
 */
export function cleanChatTitle(raw: string | null | undefined, max = 48): string | null {
  const title = raw?.replace(/\s+/g, ' ').trim()
  if (!title) return null

  const lowered = title.toLowerCase()
  if (ECHOED_CONTEXT.some((prefix) => lowered.startsWith(prefix))) return null
  if (looksLikePath(title)) return shortenPath(title, max)

  const trimmed = title.replace(STRUCTURAL_PREFIX, '').trim()
  const subject = trimmed.length >= 3 ? trimmed : title
  if (subject.length <= max) return subject

  // A trailing path inside prose carries the identity the same way a bare path
  // does — keep its last segment rather than the sentence that introduces it.
  const tail = subject.split(' ').pop() ?? ''
  if (tail.includes('/') && tail.length > 3) {
    const head = subject.slice(0, Math.max(0, max - shortenPath(tail, 20).length - 2)).trim()
    return `${head} ${shortenPath(tail, 20)}`
  }
  return subject.slice(0, max - 1).trimEnd() + '…'
}

/**
 * The name to show for a pane.
 *
 * Precedence, most deliberate first: a name someone typed, then the task the
 * session was started for, then the conversation's own title, then whatever the
 * pane was created with — and only as a last resort the agent's label, which is
 * what every unnamed pane would otherwise show.
 */
export function sessionDisplayLabel(
  terminal: Pick<Terminal, 'name' | 'nameSource' | 'tabs'>,
  chatTitle?: string | null,
): string {
  const name = terminal.name?.trim() ?? ''
  if (name && (terminal.nameSource === 'user' || terminal.nameSource === 'task')) return name

  const title = cleanChatTitle(chatTitle)
  if (title) return title

  if (name && !isGenericSessionName(name)) return name

  const activeTab: SubTab | undefined =
    terminal.tabs?.find((tab) => tab.id === (terminal as Terminal).activeTabId) ??
    terminal.tabs?.[0]
  return name || activeTab?.name || ''
}
