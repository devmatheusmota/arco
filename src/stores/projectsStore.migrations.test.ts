import { describe, expect, it } from 'vitest'

import { isPaneShortId } from '../lib/paneShortId'
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

    expect(migrated.version).toBe(12)
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
    expect(migrated.version).toBe(12)
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
    expect(migrated.version).toBe(12)
  })
})

describe('v11 — short pane references', () => {
  const paneAt = (id: string, shortId?: string) => ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-tab`,
    disabled: false,
    ...(shortId ? { shortId } : {}),
    tabs: [{ id: `${id}-tab`, type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
  })

  const fileWith = (terminals: ReturnType<typeof paneAt>[], version = 10) => ({
    ...EMPTY_PROJECTS_FILE,
    version,
    projects: [{ id: 'p1', name: 'Arco', defaultCwd: '/repo', terminals }],
  })

  it('gives every pane a unique reference', () => {
    const migrated = migrate(fileWith([paneAt('a'), paneAt('b'), paneAt('c')]))
    const refs = migrated.projects[0].terminals.map((terminal) => terminal.shortId)

    expect(migrated.version).toBe(12)
    expect(refs.every((ref) => isPaneShortId(ref))).toBe(true)
    expect(new Set(refs).size).toBe(3)
  })

  // `migrate()` runs on every load, not once, so a second pass over its own
  // output has to be a no-op — otherwise a reference someone wrote down and
  // dictated to an agent would point somewhere else after a restart.
  it('keeps the references it already handed out when it runs again', () => {
    const once = migrate(fileWith([paneAt('a'), paneAt('b')]))
    const twice = migrate(once)

    expect(twice.projects[0].terminals.map((terminal) => terminal.shortId)).toEqual(
      once.projects[0].terminals.map((terminal) => terminal.shortId),
    )
  })

  it('breaks a tie instead of letting two panes answer to the same reference', () => {
    const migrated = migrate(fileWith([paneAt('a', 'pa-3576'), paneAt('b', 'pa-3576')]))
    const [first, second] = migrated.projects[0].terminals

    // The pane that comes first in the file keeps the reference; the duplicate
    // is the one that gets redrawn.
    expect(first.shortId).toBe('pa-3576')
    expect(second.shortId).not.toBe('pa-3576')
    expect(isPaneShortId(second.shortId)).toBe(true)
  })

  it('replaces a malformed reference and leaves a well-formed one alone', () => {
    const migrated = migrate(fileWith([paneAt('a', 'nonsense'), paneAt('b', 'pa-4242')]))
    const [first, second] = migrated.projects[0].terminals

    expect(isPaneShortId(first.shortId)).toBe(true)
    expect(first.shortId).not.toBe('nonsense')
    expect(second.shortId).toBe('pa-4242')
  })

  it('keeps references unique across projects, not just inside one', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 10,
      projects: [
        { id: 'p1', name: 'A', terminals: [paneAt('a', 'pa-3576')] },
        { id: 'p2', name: 'B', terminals: [paneAt('b', 'pa-3576')] },
      ],
    })

    expect(migrated.projects[0].terminals[0].shortId).toBe('pa-3576')
    expect(migrated.projects[1].terminals[0].shortId).not.toBe('pa-3576')
  })

  it('reaches panes coming up from a file written well before v10', () => {
    const migrated = migrate(fileWith([paneAt('a')], 6))

    expect(migrated.version).toBe(12)
    expect(isPaneShortId(migrated.projects[0].terminals[0].shortId)).toBe(true)
  })
})

describe('v12 — a project is a list of fronts of work', () => {
  const pane = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: 'Claude Code',
    cwd: '/repo',
    activeTabId: `${id}-tab`,
    disabled: false,
    tabs: [{ id: `${id}-tab`, type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
    ...extra,
  })

  const fileWith = (projects: unknown[], version = 11) => ({
    ...EMPTY_PROJECTS_FILE,
    version,
    projects,
  })

  const project = (terminals: unknown[], extra: Record<string, unknown> = {}) => ({
    id: 'p1',
    name: 'SOA',
    defaultCwd: '/repo',
    createdAt: 1,
    terminals,
    ...extra,
  })

  const groupsOf = (migrated: ReturnType<typeof migrate>) => migrated.projects[0].groups ?? []
  const panesOf = (migrated: ReturnType<typeof migrate>) => migrated.projects[0].terminals

  it('puts everything on the project tree into one group named after the project', () => {
    const migrated = migrate(fileWith([project([pane('a'), pane('b')])]))

    expect(migrated.version).toBe(12)
    expect(groupsOf(migrated)).toHaveLength(1)
    expect(groupsOf(migrated)[0]).toMatchObject({ name: 'SOA' })
    expect(groupsOf(migrated)[0].worktreeAgentId).toBeUndefined()
    const [first, second] = panesOf(migrated)
    expect(first.groupId).toBe(groupsOf(migrated)[0].id)
    expect(second.groupId).toBe(first.groupId)
  })

  // Panes that shared a worktree were one piece of work; that is the only
  // record the old flat file kept of which panes belonged together.
  it('makes one group per worktree, owning it', () => {
    const migrated = migrate(
      fileWith([
        project([
          pane('a', { worktreeAgentId: 'cl-58gb4a', cwd: '/repo/.arco/worktrees/cl-58gb4a' }),
          pane('b', { worktreeAgentId: 'cl-58gb4a', cwd: '/repo/.arco/worktrees/cl-58gb4a' }),
          pane('c', { worktreeAgentId: 'cl-FU6u6a', cwd: '/repo/.arco/worktrees/cl-FU6u6a' }),
        ]),
      ]),
    )
    const groups = groupsOf(migrated)

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.worktreeAgentId).sort()).toEqual(['cl-58gb4a', 'cl-FU6u6a'])
    expect(groups.find((g) => g.worktreeAgentId === 'cl-58gb4a')?.cwd).toBe(
      '/repo/.arco/worktrees/cl-58gb4a',
    )
    const [a, b, c] = panesOf(migrated)
    expect(a.groupId).toBe(b.groupId)
    expect(c.groupId).not.toBe(a.groupId)
  })

  it('does not add an empty loose group to a project where everything is isolated', () => {
    const migrated = migrate(
      fileWith([project([pane('a', { worktreeAgentId: 'cl-1', cwd: '/wt/1' })])]),
    )

    expect(groupsOf(migrated)).toHaveLength(1)
    expect(groupsOf(migrated)[0].worktreeAgentId).toBe('cl-1')
  })

  it('gives a project with no panes at all no group to show', () => {
    const migrated = migrate(fileWith([project([])]))

    expect(groupsOf(migrated)).toEqual([])
  })
})

describe('v12 — what a group is called', () => {
  const pane = (id: string, name: string, lastUsedAt: number, worktree?: string) => ({
    id,
    name,
    lastUsedAt,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [{ id: `${id}-t`, type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
    ...(worktree ? { worktreeAgentId: worktree } : {}),
  })

  const nameOf = (terminals: unknown[]) => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 11,
      projects: [{ id: 'p1', name: 'SOA', createdAt: 1, terminals }],
    })
    return (migrated.projects[0].groups ?? [])[0]?.name
  }

  it('takes the name of the most recent pane that says what the work is', () => {
    expect(
      nameOf([
        pane('a', 'Claude Code', 300, 'cl-1'),
        pane('b', '[RE-REVIEW] PR 11286 cpf opcional', 200, 'cl-1'),
        pane('c', 'Claude Code', 100, 'cl-1'),
      ]),
    ).toBe('[RE-REVIEW] PR 11286 cpf opcional')
  })

  // Fourteen of the twenty-six panes in a real workspace are called after their
  // agent, so this is the common case, not the edge one.
  it('falls back to the worktree id when every pane is called after its agent', () => {
    expect(nameOf([pane('a', 'Claude Code', 100, 'cl-58gb4a')])).toBe('cl-58gb4a')
  })

  it('prefers a real name over a more recent placeholder', () => {
    expect(
      nameOf([pane('a', 'Claude Code', 999, 'cl-1'), pane('b', 'régua da folha', 1, 'cl-1')]),
    ).toBe('régua da folha')
  })
})

describe('v12 — running again over its own output', () => {
  const file = {
    ...EMPTY_PROJECTS_FILE,
    version: 11,
    projects: [
      {
        id: 'p1',
        name: 'SOA',
        createdAt: 1,
        terminals: [
          {
            id: 'a',
            name: 'Claude Code',
            cwd: '/repo',
            activeTabId: 'ta',
            disabled: false,
            worktreeAgentId: 'cl-1',
            tabs: [{ id: 'ta', type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
          },
          {
            id: 'b',
            name: 'Claude Code',
            cwd: '/repo',
            activeTabId: 'tb',
            disabled: false,
            tabs: [{ id: 'tb', type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
          },
        ],
      },
    ],
  }

  it('changes nothing the second time, which is every load after the first', () => {
    const once = migrate(file)
    const twice = migrate(JSON.parse(JSON.stringify(once)))

    expect(twice.projects[0].groups).toEqual(once.projects[0].groups)
    expect(twice.projects[0].terminals.map((t) => t.groupId)).toEqual(
      once.projects[0].terminals.map((t) => t.groupId),
    )
  })

  it('keeps a group the user renamed', () => {
    const once = migrate(file)
    const renamed = JSON.parse(JSON.stringify(once))
    renamed.projects[0].groups[0].name = 'cpf opcional no cadastro'

    const twice = migrate(renamed)

    expect(twice.projects[0].groups[0].name).toBe('cpf opcional no cadastro')
  })

  // A build that does not know about groups can still create a pane. The next
  // load has to take it in rather than leave it in no group at all.
  it('adopts a pane that arrived without a group', () => {
    const once = migrate(file)
    const withNewPane = JSON.parse(JSON.stringify(once))
    withNewPane.projects[0].terminals.push({
      id: 'novo',
      name: 'Claude Code',
      cwd: '/repo',
      activeTabId: 'tn',
      disabled: false,
      shortId: 'pa-4242',
      tabs: [{ id: 'tn', type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
    })

    const twice = migrate(withNewPane)
    const loose = (twice.projects[0].groups ?? []).find((g) => !g.worktreeAgentId)
    const adopted = twice.projects[0].terminals.find((t) => t.id === 'novo')

    expect(adopted?.groupId).toBe(loose?.id)
    expect(twice.projects[0].groups).toHaveLength(once.projects[0].groups!.length)
  })

  it('rehomes a pane pointing at a group that is no longer in the file', () => {
    const once = migrate(file)
    const broken = JSON.parse(JSON.stringify(once))
    broken.projects[0].terminals[1].groupId = 'grupo-que-sumiu'

    const twice = migrate(broken)
    const rehomed = twice.projects[0].terminals[1]

    expect(rehomed.groupId).not.toBe('grupo-que-sumiu')
    expect((twice.projects[0].groups ?? []).some((g) => g.id === rehomed.groupId)).toBe(true)
  })
})
