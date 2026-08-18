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
  it('adds isolated layout histories when migrating v6 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [{ id: 'project', gridLayoutHistory: undefined }],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES },
    })

    expect(migrated.version).toBe(8)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
  })

  it('drops the layout state that only arranged several projects on one screen', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      groups: [
        {
          id: 'group',
          layoutMode: 'grid',
          gridLayout: { cols: 2, rows: 1, cells: {} },
          gridLayoutHistory: [],
        },
      ],
      preferences: {
        ...DEFAULT_PREFERENCES,
        workspaceFlat: true,
        workspaceGridLayout: { cols: 2, rows: 1, cells: {} },
        workspaceGridLayoutHistory: [],
      },
    })

    expect(migrated.groups[0]).not.toHaveProperty('gridLayout')
    expect(migrated.groups[0]).not.toHaveProperty('layoutMode')
    expect(migrated.preferences).not.toHaveProperty('workspaceFlat')
    expect(migrated.preferences).not.toHaveProperty('workspaceGridLayout')
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
    expect(migrated.workspace.tabs[0].groupId).toBe('group')
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
