import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { freemem, platform, totalmem } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

// The module reads `app` from electron at load time; outside the app that
// require resolves to the binary path, so the stub has to be in the cache first.
require.cache[require.resolve('electron')] = {
  loaded: true,
  exports: { app: { getAppMetrics: () => [] } },
} as unknown as NodeJS.Module

const nodeFs = require('node:fs') as typeof import('node:fs')
const { buildResourceCommands, parsePsTable, systemAvailableMb } =
  require('../../electron/commands/resources.cjs') as {
    buildResourceCommands: (ctx: {
      ptyHost: { request: (cmd: string, args: unknown) => Promise<unknown> }
    }) => Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
    parsePsTable: (
      output: string,
    ) => Map<
      number,
      { parentPid: number | null; workingSetMb: number; cpuPercent: number; name: string }
    >
    systemAvailableMb: () => number
  }

afterEach(() => {
  vi.restoreAllMocks()
})

// `ps -axo pid=,ppid=,rss=,pcpu=,comm=` as macOS prints it: right-aligned
// columns, resident size in kilobytes, and the executable's full path.
const MACOS_PS = [
  '    1     0  24576   0.0 /sbin/launchd',
  '  412     1 152048   1.4 /Applications/Arco.app/Contents/MacOS/Arco',
  '  980   412  38912   0.0 /bin/zsh',
  ' 1024   980 421376  12.5 /opt/homebrew/bin/node',
].join('\n')

describe('parsePsTable', () => {
  it('reads the columns ps prints without headers', () => {
    const table = parsePsTable(MACOS_PS)

    expect(table.size).toBe(4)
    expect(table.get(1024)).toEqual({
      parentPid: 980,
      workingSetMb: 421376 / 1024,
      cpuPercent: 12.5,
      name: 'node',
    })
  })

  it('names a process by its binary, not by the path it was started from', () => {
    expect(parsePsTable(MACOS_PS).get(412)?.name).toBe('Arco')
  })

  it('treats the pid with no parent as a root', () => {
    expect(parsePsTable(MACOS_PS).get(1)?.parentPid).toBeNull()
  })

  it('keeps the tree walkable — every child points at a listed parent', () => {
    const table = parsePsTable(MACOS_PS)
    const parents = [...table.values()].map((entry) => entry.parentPid).filter(Boolean)

    expect(parents.every((pid) => table.has(pid as number))).toBe(true)
  })

  it('skips headers and blank lines instead of inventing processes', () => {
    const table = parsePsTable(`  PID  PPID   RSS  %CPU COMMAND\n\n${MACOS_PS}\n`)

    expect(table.size).toBe(4)
  })

  it('reads the real process table of this machine', () => {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    const table = parsePsTable(output)

    expect(table.size).toBeGreaterThan(1)
    expect(table.get(process.pid)?.workingSetMb).toBeGreaterThan(0)
  })
})

describe('systemAvailableMb', () => {
  it('reports memory the machine can still hand out', () => {
    const available = systemAvailableMb()

    expect(available).toBeGreaterThan(0)
    expect(available).toBeLessThanOrEqual(totalmem() / 1048576)
  })

  it.runIf(platform() === 'linux')('counts what MemAvailable reports, not MemFree', () => {
    // MemFree excludes the page cache the kernel hands back on demand, so it is
    // always the smaller of the two on a machine that has been up a while.
    expect(systemAvailableMb()).toBeGreaterThanOrEqual(freemem() / 1048576 - 512)
  })
})

describe.runIf(platform() === 'linux')('get_runtime_snapshot', () => {
  it('scans the process table once per sample, however many terminals there are', async () => {
    const ptys = ['a', 'b', 'c'].map((id) => ({ id, pid: process.pid }))
    const commands = buildResourceCommands({ ptyHost: { request: async () => ptys } })
    const readdirSync = vi.spyOn(nodeFs, 'readdirSync')

    const snapshot = (await commands.get_runtime_snapshot()) as {
      ptys: Array<{ id: string; processCount: number }>
    }

    const procScans = readdirSync.mock.calls.filter(([target]) => target === '/proc')
    expect(procScans).toHaveLength(1)
    expect(snapshot.ptys.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(snapshot.ptys.every((entry) => entry.processCount >= 1)).toBe(true)
  })
})
