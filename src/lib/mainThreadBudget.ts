import { recordAppEvent } from './tauri'

/**
 * Attributes main-thread time while input is lagging.
 *
 * A keystroke can only be handled when the main thread is free, and the trace
 * in `keyTrace.ts` shows it queueing for tens of milliseconds. This says where
 * that time goes: how much the app's own callbacks account for, and therefore
 * how much is the WebView doing work of its own (layout, paint, compositing).
 *
 * Active with ARCO_KEY_TRACE=1. A report lands in `app-events.log` every 10 s.
 */

const REPORT_MS = 10_000

const totals = new Map<string, number>()
const counts = new Map<string, number>()
let windowStart = 0
let enabled: boolean | null = null
let reporting = false

function tracing(): boolean {
  if (enabled === null) {
    enabled = Boolean((window as Window & { __ARCO_KEY_TRACE__?: boolean }).__ARCO_KEY_TRACE__)
    if (enabled) startReporting()
  }
  return enabled
}

/**
 * Counts forced layout reads. `react-resizable-panels` sorts its panels with a
 * comparator that reads offsetLeft/offsetWidth, so every sort flushes layout —
 * this shows how often that happens per second.
 */
let layoutReads = 0

function countLayoutReads(): void {
  const proto = HTMLElement.prototype
  for (const prop of ['offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop)
    const original = descriptor?.get
    if (!original) continue
    Object.defineProperty(proto, prop, {
      configurable: true,
      get(this: HTMLElement) {
        layoutReads += 1
        return original.call(this)
      },
    })
  }
}

function startReporting(): void {
  if (reporting) return
  reporting = true
  countLayoutReads()
  windowStart = performance.now()
  window.setInterval(() => {
    const elapsed = performance.now() - windowStart
    windowStart = performance.now()
    if (totals.size === 0) return
    const parts = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([label, ms]) =>
          `${label}=${ms.toFixed(0)}ms/${((ms / elapsed) * 100).toFixed(1)}%/${counts.get(label) ?? 0}x`,
      )
    const accounted = [...totals.values()].reduce((total, value) => total + value, 0)
    totals.clear()
    counts.clear()
    const reads = layoutReads
    layoutReads = 0
    void recordAppEvent(
      'main.budget',
      `window=${elapsed.toFixed(0)}ms accounted=${((accounted / elapsed) * 100).toFixed(1)}% layoutReads=${reads} (${(reads / (elapsed / 1000)).toFixed(0)}/s) | ${parts.join(' ')}`,
    ).catch(() => {})
  }, REPORT_MS)
}

/** Times `run` and books it under `label`. */
export function measure<T>(label: string, run: () => T): T {
  if (!tracing()) return run()
  const started = performance.now()
  try {
    return run()
  } finally {
    const spent = performance.now() - started
    totals.set(label, (totals.get(label) ?? 0) + spent)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
}

/** Books a React commit under `react.render`, so UI work is separable. */
export function recordReactRender(_id: string, _phase: string, actualDuration: number): void {
  if (!tracing()) return
  totals.set('react.render', (totals.get('react.render') ?? 0) + actualDuration)
  counts.set('react.render', (counts.get('react.render') ?? 0) + 1)
}

/** Whether to wrap the tree in a Profiler at all; it is not free when idle. */
export function reactRenderTracingEnabled(): boolean {
  return tracing()
}
