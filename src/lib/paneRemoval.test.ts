import { describe, expect, it } from 'vitest'

import { removePanesFromWorkspace } from './paneRemoval'
import type { ProjectsFile } from './types'

const container = (paneIds: string[], activePaneId = paneIds[0] ?? null) => ({
  projectId: 'p1',
  paneIds,
  activePaneId,
  sidePaneId: null,
  size: 0,
  collapsed: false,
})

const pane = (id: string, groupId?: string) =>
  ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [{ id: `${id}-t`, type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }],
    ...(groupId ? { groupId } : {}),
  }) as never

const snapshot = (paneIds: string[]) => ({
  containers: [container(paneIds)],
  activeProjectId: 'p1',
  focusedTerminalId: null,
  fullscreenContainerId: null,
})

function baseline() {
  const projects = [
    {
      id: 'p1',
      name: 'SOA',
      collapsed: false,
      createdAt: 1,
      groups: [
        { id: 'g1', name: 'cpf opcional', createdAt: 1 },
        { id: 'g2', name: 'SOA', createdAt: 1 },
      ],
      terminals: [pane('a', 'g1'), pane('b', 'g1'), pane('c', 'g2')],
    },
  ] as ProjectsFile['projects']

  const workspace: ProjectsFile['workspace'] = {
    containers: [container(['a', 'b', 'c'], 'a')],
    recentProjectIds: ['p1'],
    recentTabs: [],
    tabs: [
      {
        id: 'tab-1',
        kind: 'project',
        projectId: 'p1',
        label: 'SOA',
        snapshot: snapshot(['a', 'b', 'c']),
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    closedTabs: [],
    activeTabId: 'tab-1',
    focusedTerminalId: 'a',
    history: [{ tabId: 'tab-1', snapshot: snapshot(['a', 'b', 'c']) }],
    historyIndex: 0,
  }

  return { projects, workspace, todos: [] }
}

/** Every pane id still mentioned anywhere the workspace remembers panes. */
function idsLeft(workspace: ProjectsFile['workspace']): string[] {
  const from = (cs: ProjectsFile['workspace']['containers']) => cs.flatMap((c) => c.paneIds)
  return [
    ...from(workspace.containers),
    ...workspace.tabs.flatMap((tab) => from(tab.snapshot.containers)),
    ...workspace.history.flatMap((entry) => from(entry.snapshot.containers)),
  ]
}

describe('removePanesFromWorkspace', () => {
  // The four places are the whole point of the module: an id left in any of
  // the last three is a container pointing at a pane that does not exist.
  it('leaves no trace of the pane in any of the four places it lived', () => {
    const before = baseline()

    const after = removePanesFromWorkspace({
      ...before,
      projectId: 'p1',
      paneIds: new Set(['b']),
    })

    expect(after.projects[0].terminals.map((t) => t.id)).toEqual(['a', 'c'])
    expect(idsLeft(after.workspace)).not.toContain('b')
    expect(idsLeft(after.workspace).filter((id) => id === 'a')).toHaveLength(3)
  })

  // Closing a pane must not move the user to another piece of work. The first
  // pane of the container belonged to a different front, and taking it put the
  // whole screen on work nobody asked to see.
  it('hands the screen to another pane of the same front', () => {
    const before = baseline()
    before.workspace.containers = [container(['c', 'a', 'b'], 'a')]

    const after = removePanesFromWorkspace({
      ...before,
      projectId: 'p1',
      paneIds: new Set(['a']),
    })

    expect(after.workspace.containers[0].activePaneId).toBe('b')
  })

  // Nothing of that front is left to hand it to, so the fallback is the only
  // answer — better than a container pointing at a pane that does not exist.
  it('falls back to what is left when the front closed with the pane', () => {
    const before = baseline()
    before.workspace.containers = [container(['c', 'a', 'b'], 'a')]

    const after = removePanesFromWorkspace({
      ...before,
      projectId: 'p1',
      paneIds: new Set(['a', 'b']),
      groupIds: new Set(['g1']),
    })

    expect(after.workspace.containers[0].activePaneId).toBe('c')
  })

  it('removes the group along with its panes when asked', () => {
    const after = removePanesFromWorkspace({
      ...baseline(),
      projectId: 'p1',
      paneIds: new Set(['a', 'b']),
      groupIds: new Set(['g1']),
    })

    expect(after.projects[0].terminals.map((t) => t.id)).toEqual(['c'])
    expect((after.projects[0].groups ?? []).map((g) => g.id)).toEqual(['g2'])
    expect(idsLeft(after.workspace)).toEqual(['c', 'c', 'c'])
  })

  it('leaves the groups alone when only a pane is closing', () => {
    const after = removePanesFromWorkspace({
      ...baseline(),
      projectId: 'p1',
      paneIds: new Set(['a']),
    })

    expect((after.projects[0].groups ?? []).map((g) => g.id)).toEqual(['g1', 'g2'])
  })

  it('drops a container that has nothing left in it', () => {
    const after = removePanesFromWorkspace({
      ...baseline(),
      projectId: 'p1',
      paneIds: new Set(['a', 'b', 'c']),
      groupIds: new Set(['g1', 'g2']),
    })

    expect(after.workspace.containers).toEqual([])
    expect(idsLeft(after.workspace)).toEqual([])
  })

  it('moves the focus off a pane that is going away', () => {
    const after = removePanesFromWorkspace({
      ...baseline(),
      projectId: 'p1',
      paneIds: new Set(['a']),
    })

    expect(after.workspace.focusedTerminalId).toBeNull()
    // The container keeps a session on screen rather than pointing at nothing.
    expect(after.workspace.containers[0].activePaneId).toBe('b')
  })

  it('does not touch another project', () => {
    const before = baseline()
    before.projects.push({
      id: 'p2',
      name: 'EGA',
      collapsed: false,
      createdAt: 1,
      terminals: [pane('z')],
    } as never)

    const after = removePanesFromWorkspace({
      ...before,
      projectId: 'p1',
      paneIds: new Set(['a', 'b', 'c']),
    })

    expect(after.projects[1].terminals.map((t) => t.id)).toEqual(['z'])
  })

  it('releases a task that was tied to a pane that is closing', () => {
    const after = removePanesFromWorkspace({
      ...baseline(),
      todos: [
        {
          id: 't1',
          title: 'revisar PR',
          completed: false,
          tags: [],
          status: 'todo',
          createdAt: 1,
          sessions: [{ terminalId: 'a', projectId: 'p1', openedAt: 1 }],
        },
      ] as never,
      projectId: 'p1',
      paneIds: new Set(['a']),
    })

    expect(after.todos[0].sessions ?? []).toEqual([])
  })
})
