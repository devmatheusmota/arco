import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { migrate, normalizePreferences } from './projectsStore.migrations'

describe('preference normalization', () => {
  it('preserves persisted sidebar visibility and widths', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })

    expect(preferences).toMatchObject({
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })
  })

  it('disables legacy automatic parking preferences', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      resourcePolicy: {
        ...DEFAULT_PREFERENCES.resourcePolicy,
        mode: 'smart-lru',
        automaticParkingOptIn: true,
      },
    })

    expect(preferences.resourcePolicy).toMatchObject({
      mode: 'manual',
      automaticParkingOptIn: false,
    })
  })
})

describe('projects file migration', () => {
  it('drops the grid state a project no longer has', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [
        {
          id: 'project',
          layoutMode: 'grid',
          gridLayout: { cols: 2, rows: 1, cells: {} },
          gridLayoutHistory: [],
          paneGroups: [{ id: 'block', paneIds: ['a', 'b'] }],
        },
      ],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES, isolatedPaneId: 'a' },
    })

    expect(migrated.version).toBe(10)
    expect(migrated.projects[0]).not.toHaveProperty('layoutMode')
    expect(migrated.projects[0]).not.toHaveProperty('gridLayout')
    expect(migrated.projects[0]).not.toHaveProperty('gridLayoutHistory')
    expect(migrated.projects[0]).not.toHaveProperty('paneGroups')
    expect(migrated.preferences).not.toHaveProperty('isolatedPaneId')
  })

  it('names the pane that takes the screen in a container written before v9', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 8,
      projects: [
        {
          id: 'project',
          terminals: ['a', 'b', 'c'].map((id) => ({
            id,
            name: id,
            cwd: '/tmp',
            tabs: [{ id: `${id}-tab`, type: 'shell', name: id, cwd: '/tmp' }],
            activeTabId: `${id}-tab`,
            disabled: false,
          })),
        },
      ],
      workspace: {
        containers: [
          { projectId: 'project', paneIds: ['a', 'b', 'c'], internalLayout: 'grid', size: 0 },
        ],
      },
      preferences: { ...DEFAULT_PREFERENCES },
    })

    const container = migrated.workspace.containers[0]
    expect(container.activePaneId).toBe('a')
    expect(container.sidePaneId).toBeNull()
    expect(container).not.toHaveProperty('internalLayout')
  })

  it('drops the layout state that only arranged several projects on one screen', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      preferences: {
        ...DEFAULT_PREFERENCES,
        workspaceFlat: true,
        workspaceGridLayout: { cols: 2, rows: 1, cells: {} },
        workspaceGridLayoutHistory: [],
      },
    })

    expect(migrated).not.toHaveProperty('groups')
    expect(migrated.preferences).not.toHaveProperty('workspaceFlat')
    expect(migrated.preferences).not.toHaveProperty('workspaceGridLayout')
  })

  it('keeps a grouped project reachable, in the order the sidebar showed it', () => {
    const project = (id: string, groupId: string | null) => ({
      id,
      name: id,
      groupId,
      collapsed: false,
      createdAt: 1,
      terminals: [],
    })
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 8,
      projects: [project('in-group', 'group'), project('loose', null), project('other', 'group')],
      groups: [{ id: 'group', name: 'Group', projectIds: ['other', 'in-group'] }],
      ungroupedOrder: ['loose'],
      preferences: { ...DEFAULT_PREFERENCES },
    })

    expect(migrated.projectOrder).toEqual(['loose', 'other', 'in-group'])
    expect(migrated.projects.every((item) => !('groupId' in item))).toBe(true)
  })

  it('splits a tab that held two projects into one tab per project', () => {
    const projects = [
      {
        id: 'project-a',
        name: 'Project A',
        groupId: 'group',
        layoutMode: 'auto',
        collapsed: false,
        createdAt: 1,
        terminals: [
          { id: 'pane-a', name: 'A', cwd: '/a', tabs: [], activeTabId: '', disabled: false },
        ],
      },
      {
        id: 'project-b',
        name: 'Project B',
        groupId: null,
        layoutMode: 'auto',
        collapsed: false,
        createdAt: 2,
        terminals: [
          { id: 'pane-b', name: 'B', cwd: '/b', tabs: [], activeTabId: '', disabled: false },
        ],
      },
    ]
    const containers = [
      {
        projectId: 'project-a',
        paneIds: ['pane-a'],
        size: 1,
        internalLayout: 'auto',
        collapsed: false,
      },
      {
        projectId: 'project-b',
        paneIds: ['pane-b'],
        size: 1,
        internalLayout: 'auto',
        collapsed: false,
      },
    ]

    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects,
      activeProjectId: 'project-a',
      workspace: {
        ...EMPTY_PROJECTS_FILE.workspace,
        containers,
        tabs: [
          {
            id: 'tab-mixed',
            kind: 'composition',
            label: 'Project A + 1',
            pinned: true,
            snapshot: {
              containers,
              activeProjectId: 'project-a',
              activeGroupId: null,
              focusedTerminalId: 'pane-b',
              workspaceFlat: true,
              fullscreenContainerId: null,
            },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        activeTabId: 'tab-mixed',
      },
    })

    expect(migrated.workspace.tabs).toHaveLength(2)
    expect(migrated.workspace.tabs.map((tab) => tab.projectId)).toEqual(['project-a', 'project-b'])
    expect(migrated.workspace.tabs.map((tab) => tab.label)).toEqual(['Project A', 'Project B'])
    // The first split tab keeps the original id, so pins and history survive.
    expect(migrated.workspace.tabs[0].id).toBe('tab-mixed')
    expect(migrated.workspace.tabs[0].pinned).toBe(true)
    expect(migrated.workspace.tabs[0]).not.toHaveProperty('groupId')
    for (const tab of migrated.workspace.tabs) {
      expect(tab.snapshot.containers).toHaveLength(1)
      expect(tab.snapshot.containers[0].projectId).toBe(tab.projectId)
    }
    // The live workspace follows the active tab, so nothing foreign stays on screen.
    expect(migrated.workspace.containers.map((container) => container.projectId)).toEqual([
      'project-a',
    ])
  })
})

describe('v10 — stale completion badges', () => {
  const fileWithUnread = (completionUnread: boolean | undefined) => ({
    ...EMPTY_PROJECTS_FILE,
    version: 9,
    projects: [
      {
        id: 'p1',
        name: 'SOA',
        defaultCwd: '/repo',
        terminals: [
          {
            id: 't1',
            name: 'Claude Code',
            cwd: '/repo',
            activeTabId: 'tab1',
            disabled: false,
            tabs: [
              { id: 'tab1', type: 'claude', name: 'claude', cwd: '/repo', ptyId: null },
              {
                id: 'tab2',
                type: 'codex',
                name: 'codex',
                cwd: '/repo',
                ptyId: null,
                completionUnread,
              },
            ],
          },
        ],
      },
    ],
  })

  // The mark is persisted, the PTY runtime that raised it is not — so every
  // restart used to restore a wall of "response ready" badges for agents that
  // had died with the previous session.
  it('drops the unread mark left over from a previous run', () => {
    const migrated = migrate(fileWithUnread(true))
    const tabs = migrated.projects[0].terminals[0].tabs

    expect(tabs.map((tab) => tab.completionUnread)).toEqual([undefined, undefined])
    expect(tabs.map((tab) => tab.id)).toEqual(['tab1', 'tab2'])
    expect(migrated.version).toBe(10)
  })

  it('keeps everything else about the tab it clears', () => {
    const migrated = migrate(fileWithUnread(true))

    expect(migrated.projects[0].terminals[0].tabs[1]).toMatchObject({
      id: 'tab2',
      type: 'codex',
      name: 'codex',
      cwd: '/repo',
    })
  })

  it('leaves a file that never carried the mark alone', () => {
    const migrated = migrate(fileWithUnread(undefined))

    expect(migrated.projects[0].terminals[0].tabs).toHaveLength(2)
    expect(migrated.version).toBe(10)
  })
})
