import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { applySample, buildUsageCommands, emptyDay } =
  require('../../electron/commands/usage.cjs') as {
    applySample: (day: DayStats, sample: Record<string, unknown>) => void
    emptyDay: () => DayStats
    buildUsageCommands: () => {
      get_multi_agent_activity: (args: {
        days: number
      }) => Promise<Array<{ date: string; count: number }>>
      get_activity_summary: (args: { dates: string[] }) => {
        totals: Record<string, number>
        agents: Record<string, Record<string, number>>
        projects: Record<string, Record<string, number>>
      }
      record_activity_samples: (args: { samples: unknown[] }) => null
      clear_activity_stats: () => null
    }
  }

type DayStats = {
  totals: Record<string, number>
  agents: Record<string, Record<string, number>>
  projects: Record<string, Record<string, number>>
}

const agent = (name: string, projectId: string, terminalId: string, state: string) => ({
  agent: name,
  projectId,
  terminalId,
  state,
})

let home: string

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Writes a Claude transcript where the activity scan looks for one. */
function writeTranscript(project: string, name: string, records: object[]): void {
  const dir = join(home, '.claude', 'projects', project)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )
}

function statsFile(): string {
  return join(
    home,
    '.local',
    'share',
    'com.mota.arco',
    'profiles',
    'default',
    'activity-stats.json',
  )
}

function writeStatsFile(content: object): void {
  mkdirSync(join(home, '.local', 'share', 'com.mota.arco', 'profiles', 'default'), {
    recursive: true,
  })
  writeFileSync(statsFile(), JSON.stringify(content))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'arco-activity-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.XDG_DATA_HOME
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('activity heatmap', () => {
  it('answers one entry per day of the window, ending today', async () => {
    const days = await buildUsageCommands().get_multi_agent_activity({ days: 7 })

    expect(days).toHaveLength(7)
    expect(days[6].date).toBe(today())
    expect(days.every((day) => Number.isFinite(day.count))).toBe(true)
  })

  it('zero-fills the days nobody worked instead of leaving gaps', async () => {
    writeTranscript('-repo-app', 'session', [
      { type: 'user', timestamp: `${today()}T10:00:00.000Z` },
      { type: 'assistant', timestamp: `${today()}T10:00:01.000Z` },
    ])

    const days = await buildUsageCommands().get_multi_agent_activity({ days: 5 })

    expect(days.map((day) => day.count)).toEqual([0, 0, 0, 0, 2])
  })

  it('dates a message by its own timestamp, not by the file', async () => {
    writeTranscript('-repo-app', 'session', [
      { type: 'user', timestamp: '2020-01-02T10:00:00.000Z' },
      { type: 'assistant', timestamp: `${today()}T10:00:00.000Z` },
    ])

    const days = await buildUsageCommands().get_multi_agent_activity({ days: 3 })

    // The old message falls outside the window; only today's is counted.
    expect(days[2]).toEqual({ date: today(), count: 1 })
  })

  it('counts only conversation records', async () => {
    writeTranscript('-repo-app', 'session', [
      { type: 'user', timestamp: `${today()}T10:00:00.000Z` },
      { type: 'ai-title', aiTitle: 'x', timestamp: `${today()}T10:00:00.000Z` },
      { type: 'mode', mode: 'normal', timestamp: `${today()}T10:00:00.000Z` },
    ])

    const days = await buildUsageCommands().get_multi_agent_activity({ days: 2 })

    expect(days[1].count).toBe(1)
  })
})

describe('applySample', () => {
  // Ported from the Rust build's own test: two agents through the same five
  // seconds spend five seconds of the day and ten of agent time.
  it('keeps wall-clock time separate from summed agent time', () => {
    const day = emptyDay()

    applySample(day, {
      date: '2026-06-20',
      durationMs: 5_000,
      appFocused: false,
      userActive: false,
      activeProjectId: null,
      activeTerminalId: null,
      agents: [agent('claude', 'x', 'a', 'working'), agent('codex', 'y', 'b', 'working')],
    })

    expect(day.totals.agentWallMs).toBe(5_000)
    expect(day.totals.agentSumMs).toBe(10_000)
    expect(day.totals.parallelMs).toBe(5_000)
    expect(day.totals.peakConcurrent).toBe(2)
  })

  it('splits focused time into active and idle', () => {
    const day = emptyDay()

    applySample(day, {
      date: '2026-06-20',
      durationMs: 5_000,
      appFocused: true,
      userActive: true,
      activeProjectId: 'x',
      activeTerminalId: 'a',
      agents: [],
    })
    applySample(day, {
      date: '2026-06-20',
      durationMs: 5_000,
      appFocused: true,
      userActive: false,
      activeProjectId: 'x',
      activeTerminalId: 'a',
      agents: [],
    })

    expect(day.totals.appFocusedMs).toBe(10_000)
    expect(day.totals.userActiveMs).toBe(5_000)
    expect(day.totals.userIdleMs).toBe(5_000)
    expect(day.projects.x.activeMs).toBe(5_000)
    expect(day.projects.x.idleMs).toBe(5_000)
  })

  it('caps a tick at the tracker interval, so a suspended app bills no work', () => {
    const day = emptyDay()

    applySample(day, {
      date: '2026-06-20',
      durationMs: 6 * 60 * 60 * 1000,
      appFocused: true,
      userActive: true,
      activeProjectId: null,
      activeTerminalId: null,
      agents: [],
    })

    expect(day.totals.appOpenMs).toBe(15_000)
  })

  it('calls an agent working outside the focused terminal background work', () => {
    const day = emptyDay()

    applySample(day, {
      date: '2026-06-20',
      durationMs: 5_000,
      appFocused: true,
      userActive: true,
      activeProjectId: 'x',
      activeTerminalId: 'a',
      agents: [agent('claude', 'y', 'b', 'working')],
    })

    expect(day.agents.claude.backgroundMs).toBe(5_000)
    expect(day.agents.claude.focusedMs).toBe(0)
    expect(day.totals.agentBackgroundMs).toBe(5_000)
  })
})

describe('activity summary', () => {
  it('aggregates the samples it is given instead of storing them raw', () => {
    const commands = buildUsageCommands()

    commands.record_activity_samples({
      samples: [
        {
          date: '2026-06-20',
          durationMs: 5_000,
          appFocused: true,
          userActive: true,
          activeProjectId: 'x',
          activeTerminalId: 'a',
          agents: [agent('claude', 'x', 'a', 'working')],
        },
      ],
    })

    const summary = commands.get_activity_summary({ dates: ['2026-06-20'] })
    expect(summary.totals.appFocusedMs).toBe(5_000)
    expect(summary.agents.claude.workingMs).toBe(5_000)

    const stored = JSON.parse(readFileSync(statsFile(), 'utf8'))
    expect(stored.version).toBe(1)
    expect(stored.samples).toBeUndefined()
    expect(Object.keys(stored.days)).toEqual(['2026-06-20'])
  })

  it('folds in the raw samples an earlier build left behind', () => {
    writeStatsFile({
      version: 1,
      days: {},
      samples: [
        {
          date: '2026-06-20',
          durationMs: 5_000,
          appFocused: true,
          userActive: true,
          activeProjectId: 'x',
          activeTerminalId: 'a',
          agents: [],
        },
      ],
    })

    const summary = buildUsageCommands().get_activity_summary({ dates: [] })

    expect(summary.totals.appFocusedMs).toBe(5_000)
  })

  it('adds the days already aggregated to the ones it folds in', () => {
    writeStatsFile({
      version: 1,
      days: { '2026-06-19': { ...emptyDay(), totals: { ...emptyDay().totals, appOpenMs: 1_000 } } },
      samples: [
        {
          date: '2026-06-20',
          durationMs: 5_000,
          appFocused: false,
          userActive: false,
          activeProjectId: null,
          activeTerminalId: null,
          agents: [],
        },
      ],
    })

    const summary = buildUsageCommands().get_activity_summary({ dates: [] })

    expect(summary.totals.appOpenMs).toBe(6_000)
  })

  it('keeps the highest concurrency rather than adding it up', () => {
    const commands = buildUsageCommands()
    const sample = (peak: string[]) => ({
      date: '2026-06-20',
      durationMs: 5_000,
      appFocused: false,
      userActive: false,
      activeProjectId: null,
      activeTerminalId: null,
      agents: peak.map((name, index) => agent(name, 'x', `t${index}`, 'working')),
    })

    commands.record_activity_samples({ samples: [sample(['claude', 'codex'])] })
    commands.record_activity_samples({ samples: [sample(['claude'])] })

    expect(commands.get_activity_summary({ dates: [] }).totals.peakConcurrent).toBe(2)
  })

  it('answers only the dates it was asked for', () => {
    const commands = buildUsageCommands()
    const sample = (date: string) => ({
      date,
      durationMs: 5_000,
      appFocused: true,
      userActive: true,
      activeProjectId: null,
      activeTerminalId: null,
      agents: [],
    })

    commands.record_activity_samples({ samples: [sample('2026-06-19'), sample('2026-06-20')] })

    expect(commands.get_activity_summary({ dates: ['2026-06-20'] }).totals.appFocusedMs).toBe(5_000)
    expect(commands.get_activity_summary({ dates: [] }).totals.appFocusedMs).toBe(10_000)
  })

  it('empties the file when the stats are cleared', () => {
    const commands = buildUsageCommands()
    commands.record_activity_samples({
      samples: [
        {
          date: '2026-06-20',
          durationMs: 5_000,
          appFocused: true,
          userActive: true,
          activeProjectId: null,
          activeTerminalId: null,
          agents: [],
        },
      ],
    })

    commands.clear_activity_stats()

    expect(commands.get_activity_summary({ dates: [] }).totals.appOpenMs).toBe(0)
  })
})
