export type SessionSnapshot = {
  id: string
  modified_at_ms: number
  /** Transcript size. Absent for agents whose snapshot does not report it. */
  size_bytes?: number
  /** False for a transcript written by an automated run. Absent for agents that cannot tell. */
  interactive?: boolean
}

/**
 * Whether a session is a conversation someone typed, rather than an automated
 * run such as `/security-review`.
 *
 * Those runs are written to the same per-project directory as the real
 * conversations and are usually the newest file there, so anything that picks
 * "the most recent session" has to skip them or it hands the user someone
 * else's work. Agents whose snapshot does not report this are taken at face
 * value.
 */
export function isInteractiveSession(session: object): boolean {
  const interactive = (session as { interactive?: unknown }).interactive
  return typeof interactive !== 'boolean' || interactive
}

/**
 * Whether a session has anything worth resuming.
 *
 * The agent creates the session directory as soon as it starts and only writes
 * the transcript once there is a conversation, so a brand-new session looks
 * identical to a real one by id alone. Resuming an empty one opens a blank pane
 * and, worse, lets it overwrite the pointer to the conversation that has content.
 */
export function hasTranscript(session: object): boolean {
  // Not every agent's snapshot reports a size; those are taken at face value,
  // since there is nothing to tell an empty one apart by.
  const size = (session as { size_bytes?: unknown }).size_bytes
  return typeof size !== 'number' || size > 0
}

/** Why a saved pointer cannot be resumed as it stands. */
export type PointerProblem = 'not-listed' | 'pointed-session-automated' | 'pointed-session-empty'

export type ResumePlan = {
  problem: PointerProblem
  /** The conversation to come back to instead, if the directory still has one. */
  replacement?: SessionSnapshot
}

/**
 * What a pane should resume when its saved pointer names a session it must not
 * come back to, or `null` when the pointer is fine.
 *
 * Three ways a pointer goes bad, and all of them bury the conversation the pane
 * was in: the session is gone from disk — a transcript deleted by hand, a
 * worktree removed, a cleaned-up `~/.claude` — or it never got a transcript
 * because the agent created the directory and nothing else, or it names an
 * automated run such as `/security-review`, which shares the per-project
 * directory. Falling straight to a new session in any of those cases loses the
 * pointer to the real conversation, since the new id is what gets saved over it.
 */
export function planResume(
  pointerId: string,
  sessions: readonly SessionSnapshot[],
  isUsable: (session: SessionSnapshot) => boolean = () => true,
): ResumePlan | null {
  const match = sessions.find((session) => session.id === pointerId)
  const problem: PointerProblem | null = !match
    ? 'not-listed'
    : !isInteractiveSession(match)
      ? 'pointed-session-automated'
      : !hasTranscript(match)
        ? 'pointed-session-empty'
        : null
  if (!problem) return null
  const replacement = sessions
    .filter(
      (session) =>
        session.id !== pointerId &&
        hasTranscript(session) &&
        isInteractiveSession(session) &&
        isUsable(session),
    )
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)[0]
  return replacement ? { problem, replacement } : { problem }
}

const claimedIds = new Map<string, Set<string>>()

const claimOwners = new Map<string, Array<{ key: string; sessionId: string }>>()

function claimKey(agent: string, cwd: string): string {
  return `${agent}\0${cwd.toLowerCase()}`
}

function trackOwner(ptyId: string | undefined, key: string, sessionId: string): void {
  if (!ptyId) return
  const list = claimOwners.get(ptyId) ?? []
  if (list.some((claim) => claim.key === key && claim.sessionId === sessionId)) return
  list.push({ key, sessionId })
  claimOwners.set(ptyId, list)
}

export function registerSessionClaim(
  agent: string,
  cwd: string,
  sessionId?: string,
  ptyId?: string,
): void {
  if (!sessionId) return
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  claimed.add(sessionId)
  claimedIds.set(key, claimed)
  trackOwner(ptyId, key, sessionId)
}

export function isSessionClaimed(
  agent: string,
  cwd: string,
  sessionId: string,
  ownerId?: string,
): boolean {
  const key = claimKey(agent, cwd)
  if (!claimedIds.get(key)?.has(sessionId)) return false
  if (!ownerId) return true
  return (
    claimOwners
      .get(ownerId)
      ?.some((claim) => claim.key === key && claim.sessionId === sessionId) !== true
  )
}

export function claimDiscoveredSession(
  agent: string,
  cwd: string,
  beforeIds: ReadonlySet<string>,
  sessions: readonly SessionSnapshot[],
  ptyId?: string,
): SessionSnapshot | undefined {
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  // An automated run — `/security-review`, an agent SDK call — writes its
  // transcript to the same per-project directory as the pane's own session and
  // often lands there first. Counting it as a candidate either made the pane
  // adopt the review outright, or left two candidates and the pane never
  // adopted anything, so its pointer stayed on a session that no longer had the
  // conversation.
  const candidates = sessions
    .filter(
      (session) =>
        !beforeIds.has(session.id) && !claimed.has(session.id) && isInteractiveSession(session),
    )
    .sort((a, b) => a.modified_at_ms - b.modified_at_ms)
  if (candidates.length !== 1) return undefined
  const candidate = candidates[0]
  if (!candidate) return undefined
  claimed.add(candidate.id)
  claimedIds.set(key, claimed)
  trackOwner(ptyId, key, candidate.id)
  return candidate
}

export function claimMostRecentSession(
  agent: string,
  cwd: string,
  sessions: readonly SessionSnapshot[],
  ptyId?: string,
): SessionSnapshot | undefined {
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  const candidate = [...sessions]
    .filter((session) => !claimed.has(session.id) && isInteractiveSession(session))
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)[0]
  if (!candidate) return undefined
  claimed.add(candidate.id)
  claimedIds.set(key, claimed)
  trackOwner(ptyId, key, candidate.id)
  return candidate
}

export function releaseSessionClaim(ptyId: string): void {
  const owned = claimOwners.get(ptyId)
  if (!owned) return
  claimOwners.delete(ptyId)
  for (const { key, sessionId } of owned) {
    const set = claimedIds.get(key)
    if (!set) continue
    set.delete(sessionId)
    if (set.size === 0) claimedIds.delete(key)
  }
}

export function resetSessionClaimsForTests(): void {
  claimedIds.clear()
  claimOwners.clear()
}
