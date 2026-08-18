/**
 * Output a pane missed while it was hidden.
 *
 * A hidden pane stops receiving the `data` channel, so the bytes it misses have
 * to reach it somehow when it comes back. Replaying the session's whole
 * scrollback is the wrong answer: the raw stream carries the relative repaints
 * (cursor-up, erase-line) a TUI emitted under whatever geometry it had at the
 * time, and re-running them against the current screen leaves the agent and the
 * terminal disagreeing about where its status block sits — repeated frames,
 * characters interleaved on one line, sometimes a blank pane.
 *
 * The host keeps forwarding those bytes on the activity channel, so the pane can
 * simply take what it missed, in order, and never reset. This holds them until
 * the pane is visible again.
 */

/** Matches the host's scrollback cap: past it, the host no longer holds the rest either. */
const DEFAULT_CAP_BYTES = 512 * 1024

/** How far back a replay is scanned for the seam with bytes that arrived during the fetch. */
const OVERLAP_SCAN_LIMIT = 64 * 1024

export type HiddenBacklog = {
  push(chunk: string): void
  /** Returns everything buffered and empties it. */
  drain(): string
  /** True once more was produced than the host itself retains, so a full resync is the only option. */
  readonly overflowed: boolean
  reset(): void
}

export function createHiddenBacklog(capBytes: number = DEFAULT_CAP_BYTES): HiddenBacklog {
  let chunks: string[] = []
  let bytes = 0
  let overflowed = false

  return {
    push(chunk: string) {
      if (!chunk || overflowed) return
      bytes += chunk.length
      if (bytes > capBytes) {
        overflowed = true
        chunks = []
        bytes = 0
        return
      }
      chunks.push(chunk)
    },
    drain() {
      if (chunks.length === 0) return ''
      const joined = chunks.join('')
      chunks = []
      bytes = 0
      return joined
    },
    get overflowed() {
      return overflowed
    },
    reset() {
      chunks = []
      bytes = 0
      overflowed = false
    },
  }
}

/**
 * Drops the part of `pending` the replay already contains.
 *
 * A resync reads the host's snapshot over IPC, and chunks that arrive while that
 * request is in flight may already be inside it — the host appends to the
 * scrollback before it emits. Writing them again duplicates output on screen, so
 * the seam is found by matching the head of `pending` against the tail of the
 * replay and only the remainder is written.
 */
export function dropReplayOverlap(replay: string, pending: string): string {
  if (!replay || !pending) return pending

  const tail = replay.length > OVERLAP_SCAN_LIMIT ? replay.slice(-OVERLAP_SCAN_LIMIT) : replay
  const first = pending[0]

  // Scanning left to right finds the longest overlap first: the earlier the
  // match starts in the tail, the more of `pending` it covers.
  for (let index = tail.indexOf(first); index !== -1; index = tail.indexOf(first, index + 1)) {
    const length = tail.length - index
    if (length > pending.length) continue
    if (tail.startsWith(pending.slice(0, length), index)) return pending.slice(length)
  }
  return pending
}
