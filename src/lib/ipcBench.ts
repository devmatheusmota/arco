import { useTerminalsStore } from '../stores/terminalsStore'
import { listenPtyData, recordAppEvent, writePty } from './tauri'

/**
 * Measures the round trip a keystroke actually takes, so input lag can be
 * attributed instead of guessed:
 *
 *   write  — `invoke('write_pty')` resolving, i.e. the IPC hop out
 *   echo   — that byte coming back as a `pty://data` event, i.e. the full loop
 *
 * Enabled only when the process was started with ARCO_IPC_BENCH=1. Results land
 * in `app-events.log`, which is the only channel a release build has.
 */

const SAMPLES = 30
const START_DELAY_MS = 6_000
const ECHO_TIMEOUT_MS = 2_000

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0
}

function summarize(label: string, values: number[]): string {
  if (values.length === 0) return `${label}=none`
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return `${label} mean=${mean.toFixed(1)}ms p50=${percentile(values, 50).toFixed(1)} p95=${percentile(values, 95).toFixed(1)}`
}

async function runBench(ptyId: string): Promise<void> {
  const writeTimes: number[] = []
  const echoTimes: number[] = []

  let pendingEcho: ((at: number) => void) | null = null
  const unlisten = await listenPtyData(ptyId, () => {
    pendingEcho?.(performance.now())
    pendingEcho = null
  })

  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now()
    const echoed = new Promise<number>((resolve) => {
      pendingEcho = resolve
      window.setTimeout(() => resolve(Number.NaN), ECHO_TIMEOUT_MS)
    })
    await writePty(ptyId, ' \b')
    writeTimes.push(performance.now() - started)
    const echoAt = await echoed
    if (Number.isFinite(echoAt)) echoTimes.push(echoAt - started)
    await new Promise((resolve) => window.setTimeout(resolve, 60))
  }

  unlisten()
  await recordAppEvent(
    'ipc.bench',
    `${summarize('write', writeTimes)} | ${summarize('echo', echoTimes)} | samples=${SAMPLES}`,
  ).catch(() => {})
}

export function startIpcBenchIfRequested(): void {
  if (!(window as Window & { __ARCO_IPC_BENCH__?: boolean }).__ARCO_IPC_BENCH__) return
  window.setTimeout(() => {
    const ptyId = Object.keys(useTerminalsStore.getState().byPtyId)[0]
    if (!ptyId) {
      void recordAppEvent('ipc.bench', 'no pty to measure').catch(() => {})
      return
    }
    void runBench(ptyId)
  }, START_DELAY_MS)
}
