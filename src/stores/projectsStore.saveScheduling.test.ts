import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saveProjectsFile = vi.fn(async (..._args: unknown[]) => undefined)

vi.mock('../lib/tauri', () => ({
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(async () => null),
  saveProjectsFile: (...args: unknown[]) => saveProjectsFile(...args),
  recordAppEvent: vi.fn(async () => undefined),
  recordFrontendError: vi.fn(async () => undefined),
  killPty: vi.fn(async () => undefined),
}))

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { USAGE_TOUCH_INTERVAL_MS } from '../lib/terminalFactory'
import { useProjectsStore } from './projectsStore'

const SAVE_WAIT_MS = 1_000

const pane = (id: string, lastUsedAt: number, completionUnread = false) => ({
  id,
  name: id,
  cwd: '/repo',
  activeTabId: `${id}-t`,
  disabled: false,
  lastUsedAt,
  tabs: [
    {
      id: `${id}-t`,
      type: 'claude' as const,
      name: 'claude',
      cwd: '/repo',
      ptyId: id,
      lastUsedAt,
      completionUnread,
    },
  ],
})

function seed(now: number) {
  const container = {
    projectId: 'p1',
    paneIds: ['a', 'b'],
    activePaneId: 'a',
    sidePaneId: null,
    size: 0,
    collapsed: false,
  }
  const snapshot = {
    containers: [container],
    activeProjectId: 'p1',
    focusedTerminalId: null,
    fullscreenContainerId: null,
  }
  useProjectsStore.setState({
    hydrated: true,
    projects: [
      {
        id: 'p1',
        name: 'SOA',
        defaultCwd: '/repo',
        collapsed: false,
        createdAt: 1,
        groups: [],
        terminals: [pane('a', now - 1_000), pane('b', now - 5_000, true)],
      },
    ],
    projectOrder: ['p1'],
    todos: [],
    activeProjectId: 'p1',
    workspace: {
      containers: [container],
      recentProjectIds: [],
      recentTabs: [],
      tabs: [
        {
          id: 'tab1',
          kind: 'project',
          projectId: 'p1',
          label: 'SOA',
          snapshot,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      closedTabs: [],
      activeTabId: 'tab1',
      focusedTerminalId: null,
      history: [],
      historyIndex: -1,
    },
  } as never)
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS)
}

beforeEach(async () => {
  vi.useFakeTimers()
  seed(Date.now())
  // Drain whatever an earlier test left scheduled, then start counting.
  await settle()
  saveProjectsFile.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('saving the workspace', () => {
  it('writes nothing for an update that changes nothing', async () => {
    const before = useProjectsStore.getState()
    const store = useProjectsStore.getState()
    store.clearTerminalCompletionUnread('p1', 'a')
    store.setActivePane('p1', 'a')
    store.setActiveTab('p1', 'a', 'missing-tab')
    await settle()

    expect(useProjectsStore.getState().projects).toBe(before.projects)
    expect(useProjectsStore.getState().workspace).toBe(before.workspace)
    expect(saveProjectsFile).not.toHaveBeenCalled()
  })

  it('does not touch a pane already in use moments ago', async () => {
    const before = useProjectsStore.getState().projects
    useProjectsStore.getState().markTerminalUsed('p1', 'a')
    await settle()

    expect(useProjectsStore.getState().projects).toBe(before)
    expect(saveProjectsFile).not.toHaveBeenCalled()
  })

  it('touches a pane that was not the last one used', async () => {
    useProjectsStore.getState().markTerminalUsed('p1', 'b')
    await settle()

    const [a, b] = useProjectsStore.getState().projects[0].terminals
    expect(b.lastUsedAt).toBeGreaterThan(a.lastUsedAt ?? 0)
    expect(saveProjectsFile).toHaveBeenCalledTimes(1)
  })

  it('touches the last pane used again once its use is old', async () => {
    await vi.advanceTimersByTimeAsync(USAGE_TOUCH_INTERVAL_MS)
    useProjectsStore.getState().markTerminalUsed('p1', 'a')
    await settle()

    expect(saveProjectsFile).toHaveBeenCalledTimes(1)
  })

  it('saves a real change once, compact, with the project count', async () => {
    useProjectsStore.getState().clearTerminalCompletionUnread('p1', 'b')
    await settle()

    expect(saveProjectsFile).toHaveBeenCalledTimes(1)
    const [content, , projectCount] = saveProjectsFile.mock.calls[0] as [string, number, number]
    expect(content.includes('\n')).toBe(false)
    expect(JSON.parse(content).projects[0].terminals[1].tabs[0].completionUnread).toBe(false)
    expect(projectCount).toBe(1)
  })

  it('leaves the preferences alone when a patch repeats what they hold', async () => {
    const before = useProjectsStore.getState().preferences
    useProjectsStore.getState().setPreferences({ leftSidebarWidth: before.leftSidebarWidth })
    await settle()

    expect(useProjectsStore.getState().preferences).toBe(before)
    expect(saveProjectsFile).not.toHaveBeenCalled()

    useProjectsStore.getState().setPreferences({ leftSidebarWidth: before.leftSidebarWidth + 10 })
    await settle()
    expect(saveProjectsFile).toHaveBeenCalledTimes(1)
  })
})
