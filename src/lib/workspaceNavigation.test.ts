import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type Project,
  type WorkspaceViewSnapshot,
} from './types'
import {
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  enforceTabScope,
  MAX_WORKSPACE_HISTORY,
  pushWorkspaceHistory,
  sanitizeWorkspaceSnapshot,
} from './workspaceNavigation'

const preferences: Preferences = {
  ...DEFAULT_PREFERENCES,
  onboardingDone: true,
  accountCreated: true,
}

const projects: Project[] = [
  {
    id: 'project-a',
    name: 'Project A',
    groupId: null,
    terminals: [
      {
        id: 'terminal-a',
        name: 'Terminal A',
        cwd: 'C:\\a',
        tabs: [],
        activeTabId: '',
        disabled: false,
      },
    ],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
  },
]

function snapshot(projectId = 'project-a', terminalId = 'terminal-a'): WorkspaceViewSnapshot {
  return captureWorkspaceSnapshot({
    containers: [
      {
        projectId,
        paneIds: [terminalId],
        size: 1,
        internalLayout: 'auto',
        collapsed: false,
      },
    ],
    activeProjectId: projectId,
    focusedTerminalId: terminalId,
    preferences,
  })
}

describe('workspaceNavigation', () => {
  it('pushWorkspaceHistory truncates the forward branch', () => {
    const a = snapshot()
    const first = pushWorkspaceHistory([], -1, {
      id: 'h1',
      tabId: 'tab-a',
      label: 'A',
      snapshot: a,
      visitedAt: 1,
    })
    const second = pushWorkspaceHistory(first.history, first.historyIndex, {
      id: 'h2',
      tabId: 'tab-b',
      label: 'B',
      snapshot: a,
      visitedAt: 2,
    })
    const branched = pushWorkspaceHistory(second.history, 0, {
      id: 'h3',
      tabId: 'tab-c',
      label: 'C',
      snapshot: a,
      visitedAt: 3,
    })

    expect(branched.history.map((entry) => entry.id)).toEqual(['h1', 'h3'])
    expect(branched.historyIndex).toBe(1)
  })

  it('history keeps only the latest configured entries', () => {
    let history: ReturnType<typeof pushWorkspaceHistory> = { history: [], historyIndex: -1 }
    for (let index = 0; index < MAX_WORKSPACE_HISTORY + 5; index += 1) {
      history = pushWorkspaceHistory(history.history, history.historyIndex, {
        id: `h${index}`,
        tabId: 'tab-a',
        label: 'A',
        snapshot: snapshot(),
        visitedAt: index,
      })
    }
    expect(history.history.length).toBe(MAX_WORKSPACE_HISTORY)
    expect(history.history[0].id).toBe('h5')
  })

  it('sanitizeWorkspaceSnapshot removes missing projects and terminals', () => {
    const dirty = snapshot('project-a', 'missing-terminal')
    dirty.containers.push({
      projectId: 'missing-project',
      paneIds: ['anything'],
      size: 1,
      internalLayout: 'auto',
      collapsed: false,
    })

    const clean = sanitizeWorkspaceSnapshot(dirty, projects)
    expect(clean.containers).toEqual([])
    expect(clean.activeProjectId).toBeNull()
    expect(clean.focusedTerminalId).toBeNull()
  })

  it('snapshots are deep-cloned', () => {
    const original = snapshot()
    const cloned = cloneWorkspaceSnapshot(original)
    cloned.containers[0].paneIds.push('terminal-b')

    expect(original.containers[0].paneIds).toEqual(['terminal-a'])
  })

  it('enforceTabScope drops every container of another project', () => {
    const mixed = snapshot()
    mixed.containers.push({
      projectId: 'project-b',
      paneIds: ['terminal-b'],
      size: 1,
      internalLayout: 'auto',
      collapsed: false,
    })
    mixed.focusedTerminalId = 'terminal-b'
    mixed.fullscreenContainerId = 'project-b'

    const scoped = enforceTabScope(mixed, 'project-a')

    expect(scoped.containers).toHaveLength(1)
    expect(scoped.containers[0].projectId).toBe('project-a')
    expect(scoped.activeProjectId).toBe('project-a')
    // Focus and fullscreen belonged to the dropped project, so both are cleared.
    expect(scoped.focusedTerminalId).toBeNull()
    expect(scoped.fullscreenContainerId).toBeNull()
  })

  it('enforceTabScope merges duplicate containers of the tab project', () => {
    const duplicated = snapshot()
    duplicated.containers.push({
      projectId: 'project-a',
      paneIds: ['terminal-c'],
      size: 1,
      internalLayout: 'auto',
      collapsed: false,
    })

    const scoped = enforceTabScope(duplicated, 'project-a')

    expect(scoped.containers).toHaveLength(1)
    expect(scoped.containers[0].paneIds).toEqual(['terminal-a', 'terminal-c'])
  })
})
