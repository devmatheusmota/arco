#!/usr/bin/env node
/**
 * Samples the Arco that is running right now: CPU of each process, what the main
 * process reads from disk and what the PTY host writes to it, second by second.
 *
 * The main process relays every keystroke and every byte of terminal output, so
 * a second in which it reads hundreds of megabytes or sits at full CPU is a
 * second in which typing stalls. This is how those seconds were found, on the
 * real app with real sessions; run it again after a change that touches the
 * terminal path. Linux only: it reads /proc.
 *
 *   node scripts/perf-sample.mjs            # 30 seconds
 *   node scripts/perf-sample.mjs 60         # 60 seconds
 *   node scripts/perf-sample.mjs 60 <pid>   # a given main process
 */
import { readdirSync, readFileSync } from 'node:fs'

const seconds = Number(process.argv[2] ?? 30)
const CLOCK_TICKS = 100

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function args(pid) {
  return read(`/proc/${pid}/cmdline`).split('\0').join(' ')
}

function parentOf(pid) {
  const stat = read(`/proc/${pid}/stat`)
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
}

/** The Arco main process: the binary with no `--type`, or electron running main.cjs. */
function findMain() {
  if (process.argv[3]) return Number(process.argv[3])
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const line = args(entry)
    if (line.includes('--type=')) continue
    if (/(^|\/)arco( |$)/.test(line) || line.includes('electron/main.cjs')) return Number(entry)
  }
  return null
}

function roleOf(pid, mainPid) {
  if (pid === mainPid) return 'main'
  const line = args(pid)
  if (line.includes('pty-host.cjs')) return 'pty-host'
  if (line.includes('speech-host.cjs')) return 'speech-host'
  const type = /--type=([a-z-]+)/.exec(line)?.[1]
  return type ?? null
}

/** CPU ticks of a process, or of its main thread when `thread` is set. */
function ticks(pid, thread = false) {
  const stat = read(thread ? `/proc/${pid}/task/${pid}/stat` : `/proc/${pid}/stat`)
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(fields[11]) + Number(fields[12])
}

function io(pid) {
  const values = {}
  for (const line of read(`/proc/${pid}/io`).split('\n')) {
    const [key, value] = line.split(': ')
    if (key) values[key] = Number(value)
  }
  return values
}

const mainPid = findMain()
if (!mainPid) {
  console.error('No running Arco found.')
  process.exit(1)
}

const processes = new Map()
for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue
  const pid = Number(entry)
  let ancestor = pid
  for (let depth = 0; depth < 4 && ancestor > 1; depth += 1) {
    if (ancestor === mainPid) break
    ancestor = parentOf(ancestor)
  }
  if (ancestor !== mainPid) continue
  const role = roleOf(pid, mainPid)
  if (role && !processes.has(role)) processes.set(role, pid)
}

const rendererPid = processes.get('renderer')
const ptyHostPid = processes.get('pty-host')

function snapshot() {
  const cpu = {}
  for (const [role, pid] of processes) cpu[role] = ticks(pid)
  if (rendererPid) cpu['renderer main thread'] = ticks(rendererPid, true)
  return {
    cpu,
    mainRead: io(mainPid).rchar ?? 0,
    hostWrite: ptyHostPid ? (io(ptyHostPid).wchar ?? 0) : 0,
  }
}

console.log(`Sampling Arco (main ${mainPid}) for ${seconds}s…`)
console.log('second  main-read-MB  main-cpu%  renderer-thread-cpu%  pty-host-write-KB')
const first = snapshot()
let previous = first
let worstRead = 0
for (let second = 1; second <= seconds; second += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const current = snapshot()
  const readMb = (current.mainRead - previous.mainRead) / 1048576
  worstRead = Math.max(worstRead, readMb)
  const mainCpu = ((current.cpu.main - previous.cpu.main) / CLOCK_TICKS) * 100
  const rendererCpu = rendererPid
    ? ((current.cpu['renderer main thread'] - previous.cpu['renderer main thread']) / CLOCK_TICKS) *
      100
    : 0
  const hostKb = (current.hostWrite - previous.hostWrite) / 1024
  console.log(
    `${String(second).padStart(6)}  ${readMb.toFixed(1).padStart(12)}  ${mainCpu
      .toFixed(0)
      .padStart(9)}  ${rendererCpu.toFixed(0).padStart(20)}  ${hostKb.toFixed(0).padStart(17)}`,
  )
  previous = current
}

console.log('\nAverage CPU over the run:')
for (const [role] of [...processes, ['renderer main thread']]) {
  const used = previous.cpu[role] - first.cpu[role]
  if (Number.isFinite(used))
    console.log(`  ${role.padEnd(22)} ${((used / CLOCK_TICKS / seconds) * 100).toFixed(1)}%`)
}
console.log(
  `Main process read ${((previous.mainRead - first.mainRead) / 1048576 / seconds).toFixed(2)} MB/s (worst second ${worstRead.toFixed(1)} MB)`,
)
console.log(
  `PTY host wrote ${((previous.hostWrite - first.hostWrite) / 1048576 / seconds).toFixed(3)} MB/s`,
)
