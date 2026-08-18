// Memory and CPU reporting, and the policy that drives Smart LRU.
//
// Numbers come from /proc for the PTY trees and from Chromium's own metrics for
// the app itself, so what the dashboard shows is measured rather than guessed.
// Private memory is read from smaps_rollup, which is expensive, so it is cached
// per process and refreshed a few at a time — the same amortisation the Rust
// sampler does.

const fs = require('node:fs')
const os = require('node:os')
const { app } = require('electron')

const PRIVATE_TTL_MS = 30_000
const PRIVATE_PER_CYCLE = 40
const PAGE_SIZE = 4096
const CLOCK_TICKS = 100

const privateCache = new Map()
const cpuCache = new Map()

const state = {
  policy: {
    mode: 'smart-lru',
    memoryBudgetMb: 8_192,
    warningThresholdMb: 6_144,
    recoveryTargetMb: 5_120,
    hiddenAgentIdleMinutes: 20,
    hiddenShellIdleMinutes: 10,
    spawnGraceSeconds: 60,
  },
  metas: new Map(),
  triggerCount: 0,
  lastSuspendedId: null,
}

function readProc(pid, file) {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8')
  } catch {
    return null
  }
}

/** Resident size in MB, from statm — two numbers, no parsing cost. */
function workingSetMb(pid) {
  const statm = readProc(pid, 'statm')
  if (!statm) return 0
  const resident = Number(statm.split(' ')[1])
  return Number.isFinite(resident) ? (resident * PAGE_SIZE) / 1048576 : 0
}

/**
 * Private (non-shared) memory in MB. smaps_rollup walks the whole address
 * space, so a value is reused for PRIVATE_TTL_MS and only a few processes are
 * refreshed per sample.
 */
function privateCommitMb(pid, budget) {
  const cached = privateCache.get(pid)
  const now = Date.now()
  if (cached && now - cached.at < PRIVATE_TTL_MS) return cached.value
  if (budget.remaining <= 0) return cached?.value ?? workingSetMb(pid)
  budget.remaining -= 1
  const rollup = readProc(pid, 'smaps_rollup')
  if (!rollup) {
    const fallback = workingSetMb(pid)
    privateCache.set(pid, { value: fallback, at: now })
    return fallback
  }
  let kb = 0
  for (const line of rollup.split('\n')) {
    if (line.startsWith('Private_Clean:') || line.startsWith('Private_Dirty:')) {
      kb += Number(line.replace(/\D+/g, ''))
    }
  }
  const value = kb / 1024
  privateCache.set(pid, { value, at: now })
  return value
}

/** Process name and parent, straight out of /proc/<pid>/stat. */
function processInfo(pid) {
  const stat = readProc(pid, 'stat')
  if (!stat) return null
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  const name = stat.slice(open + 1, close)
  const fields = stat.slice(close + 2).split(' ')
  const utime = Number(fields[11])
  const stime = Number(fields[12])
  return {
    name,
    parentPid: Number(fields[1]) || null,
    cpuTicks: (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0),
  }
}

/** CPU share since the previous sample of this same process. */
function cpuPercent(pid, ticks) {
  const now = Date.now()
  const previous = cpuCache.get(pid)
  cpuCache.set(pid, { ticks, at: now })
  if (!previous || now === previous.at) return 0
  const elapsedSeconds = (now - previous.at) / 1000
  const used = (ticks - previous.ticks) / CLOCK_TICKS
  return Math.max(0, Math.min(100, (used / elapsedSeconds) * 100))
}

/** Every pid in the tree rooted at `pid`, itself included. */
function processTree(pid) {
  const children = new Map()
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const info = processInfo(entry)
    if (!info?.parentPid) continue
    if (!children.has(info.parentPid)) children.set(info.parentPid, [])
    children.get(info.parentPid).push(Number(entry))
  }
  const tree = [pid]
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (tree.includes(child)) continue
      tree.push(child)
      queue.push(child)
    }
  }
  return tree
}

/** What Chromium says its own processes cost — browser, renderers, GPU. */
function appMemoryMb() {
  let total = 0
  let webview = 0
  let count = 0
  for (const metric of app.getAppMetrics()) {
    const mb = (metric.memory?.workingSetSize ?? 0) / 1024
    total += mb
    if (metric.type === 'Tab' || metric.type === 'renderer') webview += mb
    count += 1
  }
  return { total, webview, count }
}

function buildResourceCommands({ ptyHost }) {
  const sample = async () => {
    const budget = { remaining: PRIVATE_PER_CYCLE }
    const list = await ptyHost.request('list_pty_processes', {}).catch(() => [])
    const ptys = []
    for (const entry of list) {
      if (!entry?.pid) continue
      const tree = processTree(entry.pid)
      const processes = []
      let working = 0
      let priv = 0
      for (const pid of tree) {
        const info = processInfo(pid)
        if (!info) continue
        const pidWorking = workingSetMb(pid)
        const pidPrivate = privateCommitMb(pid, budget)
        working += pidWorking
        priv += pidPrivate
        processes.push({
          pid,
          parentPid: info.parentPid,
          name: info.name,
          workingSetMb: pidWorking,
          privateCommitMb: pidPrivate,
          cpuPercent: cpuPercent(pid, info.cpuTicks),
        })
      }
      ptys.push({
        id: entry.id,
        rootPid: entry.pid,
        command: state.metas.get(entry.id)?.kind ?? null,
        cwd: null,
        processCount: processes.length,
        workingSetMb: working,
        privateCommitMb: priv,
        effectiveMemoryMb: Math.max(working, priv),
        processes,
      })
    }

    const chromium = appMemoryMb()
    const ptysMb = ptys.reduce((total, entry) => total + entry.effectiveMemoryMb, 0)
    const memory = {
      total_mb: chromium.total + ptysMb,
      app_mb: chromium.total,
      webview_mb: chromium.webview,
      ptys_mb: ptysMb,
      process_count: chromium.count + ptys.reduce((total, e) => total + e.processCount, 0),
      system_total_mb: os.totalmem() / 1048576,
      system_available_mb: os.freemem() / 1048576,
    }
    return { memory, ptys, ptysMb, chromium }
  }

  /** Hidden runtimes idle past their threshold — what Smart LRU may park. */
  const candidates = () => {
    const now = Date.now()
    const policy = state.policy
    let count = 0
    for (const meta of state.metas.values()) {
      if (meta.visible || meta.focused || meta.protected) continue
      if (now - meta.spawnedAtMs < policy.spawnGraceSeconds * 1000) continue
      const idleMinutes = (now - Math.max(meta.lastIoAtMs, meta.lastUsedAtMs)) / 60_000
      const threshold =
        meta.kind === 'agent' ? policy.hiddenAgentIdleMinutes : policy.hiddenShellIdleMinutes
      if (idleMinutes >= threshold) count += 1
    }
    return count
  }

  const pressureFor = (totalMb) => {
    const { memoryBudgetMb, warningThresholdMb } = state.policy
    const level =
      totalMb >= memoryBudgetMb ? 'critical' : totalMb >= warningThresholdMb ? 'warning' : 'normal'
    return {
      level,
      spawnBlocked: level === 'critical',
      automatic: state.policy.mode === 'smart-lru',
      candidateCount: candidates(),
      lastSuspendedId: state.lastSuspendedId,
    }
  }

  return {
    get_memory_stats: async () => (await sample()).memory,
    get_runtime_snapshot: async () => {
      const { memory, ptys, ptysMb, chromium } = await sample()
      const effectiveTotalMb = chromium.total + ptysMb
      const pressure = pressureFor(effectiveTotalMb)
      if (pressure.level !== 'normal') state.triggerCount += 1
      return {
        sampledAtMs: Date.now(),
        memory,
        privateCommitMb: ptys.reduce((total, entry) => total + entry.privateCommitMb, 0),
        effectiveTotalMb,
        ptys,
        pressure,
      }
    },
    get_resource_metrics: async () => {
      const { memory } = await sample()
      const used = memory.app_mb + memory.ptys_mb
      const ratio = used / Math.max(1, state.policy.memoryBudgetMb)
      const level =
        ratio >= 1
          ? 'Critical'
          : ratio >= 0.85
            ? 'High'
            : ratio >= 0.6
              ? 'Medium'
              : ratio >= 0.4
                ? 'Low'
                : 'Ok'
      return {
        memory_pressure: level,
        system_available_mb: memory.system_available_mb,
        system_total_mb: memory.system_total_mb,
        app_mb: memory.app_mb,
        webview_mb: memory.webview_mb,
        ptys_mb: memory.ptys_mb,
        process_count: memory.process_count,
        policy_trigger_count: state.triggerCount,
      }
    },
    set_resource_policy: ({ policy }) => {
      state.policy = { ...state.policy, ...(policy ?? {}) }
      return null
    },
    update_pty_runtime_meta: ({ metas }) => {
      for (const meta of metas ?? []) state.metas.set(meta.id, meta)
      // Drop what the frontend no longer reports, so a closed pane stops
      // counting as a parking candidate.
      const live = new Set((metas ?? []).map((meta) => meta.id))
      for (const id of state.metas.keys()) if (!live.has(id)) state.metas.delete(id)
      return null
    },

    /**
     * A pane that is not being read gets its output batched instead of streamed
     * — the host keeps every byte, it just stops paying for a repaint nobody
     * is looking at.
     */
    set_pty_read_state: async ({ id, active }) => {
      await ptyHost.request('set_pty_visible', { id, visible: Boolean(active) }).catch(() => null)
      return null
    },
    /** Background trees run at a lower priority so the focused one stays smooth. */
    set_pty_priority: async ({ id, active }) => {
      const list = await ptyHost.request('list_pty_processes', {}).catch(() => [])
      const pid = list.find((entry) => entry.id === id)?.pid
      if (!pid) return null
      const nice = active ? 0 : 5
      for (const target of processTree(pid)) {
        try {
          os.setPriority(target, nice)
        } catch {}
      }
      return null
    },
  }
}

module.exports = { buildResourceCommands }
