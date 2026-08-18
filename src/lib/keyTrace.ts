import { recordAppEvent } from './tauri'

/**
 * Splits the latency of a keystroke into the parts that can each be fixed
 * differently:
 *
 *   queue  — event.timeStamp to the handler running. This is time the key spent
 *            waiting for the main thread; if it is high, something else is
 *            hogging the renderer and nothing downstream matters.
 *   data   — handler to xterm's onData, i.e. xterm's own key handling.
 *   frame  — onData to the next animation frame, i.e. how long until the
 *            display could show the character.
 *
 * Enabled with ARCO_KEY_TRACE=1; results go to `app-events.log` every batch,
 * which is the only channel a release build has.
 */

const BATCH = 12
const FLUSH_AFTER_MS = 8_000

let queueLags: number[] = []
let dataLags: number[] = []
let frameLags: number[] = []
let pendingKeyAt: number | null = null
let firstSampleAt = 0
// Resolved on first use: the injected flag lands after this module is evaluated.
let enabled: boolean | null = null

function tracing(): boolean {
  if (enabled === null) {
    enabled = Boolean((window as Window & { __ARCO_KEY_TRACE__?: boolean }).__ARCO_KEY_TRACE__)
  }
  return enabled
}

function stats(label: string, values: number[]): string {
  if (values.length === 0) return `${label}=none`
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  return `${label} mean=${mean.toFixed(1)} p50=${sorted[Math.floor(sorted.length / 2)].toFixed(1)} p95=${p95.toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`
}

function flush(): void {
  void recordAppEvent(
    'key.trace',
    `${stats('queueMs', queueLags)} | ${stats('dataMs', dataLags)} | ${stats('frameMs', frameLags)} | n=${queueLags.length}`,
  ).catch(() => {})
  queueLags = []
  dataLags = []
  frameLags = []
}

/** Records how long the key waited for the main thread before any JS ran. */
export function traceKeyDown(event: KeyboardEvent): void {
  if (!tracing()) return
  if (firstSampleAt === 0) firstSampleAt = performance.now()
  const now = performance.now()
  pendingKeyAt = now
  // event.timeStamp shares the performance.now() timeline in WebKit.
  const queued = now - event.timeStamp
  if (Number.isFinite(queued) && queued >= 0 && queued < 5_000) queueLags.push(queued)
}

/** Records xterm turning that key into PTY input, and the frame after it. */
export function traceKeyData(): void {
  if (!tracing() || pendingKeyAt === null) return
  const at = performance.now()
  dataLags.push(at - pendingKeyAt)
  pendingKeyAt = null
  requestAnimationFrame(() => {
    frameLags.push(performance.now() - at)
    if (frameLags.length >= BATCH || performance.now() - firstSampleAt > FLUSH_AFTER_MS) {
      firstSampleAt = 0
      flush()
    }
  })
}

/** Kept so the entry point can stay explicit; the flag is read lazily. */
export function installKeyTraceIfRequested(): void {
  enabled = null
}
