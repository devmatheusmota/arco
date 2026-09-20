import { describe, expect, it } from 'vitest'

import { activeGroupId, homeGroupId } from './paneHoming'
import type { Project, ProjectsFile } from './types'

const pane = (id: string, groupId?: string) =>
  ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [],
    ...(groupId ? { groupId } : {}),
  }) as never

const project = (terminals: unknown[], groups: unknown[]): Project =>
  ({ id: 'p1', name: 'SOA', collapsed: false, createdAt: 1, terminals, groups }) as never

const workspace = (activePaneId: string | null): ProjectsFile['workspace'] =>
  ({
    containers: [
      {
        projectId: 'p1',
        paneIds: ['a', 'b'],
        activePaneId,
        sidePaneId: null,
        size: 0,
        collapsed: false,
      },
    ],
    recentProjectIds: [],
    recentTabs: [],
    tabs: [],
    closedTabs: [],
    activeTabId: null,
    focusedTerminalId: null,
    history: [],
    historyIndex: -1,
  }) as never

const base = () => ({
  project: project(
    [pane('a', 'g1'), pane('b', 'g2')],
    [
      { id: 'g1', name: 'um', createdAt: 1 },
      { id: 'g2', name: 'dois', createdAt: 1 },
    ],
  ),
  workspace: workspace('a'),
  projectId: 'p1',
})

describe('activeGroupId', () => {
  it('is the front of the pane on screen', () => {
    const { project: p, workspace: w } = base()
    expect(activeGroupId(p, w, 'p1')).toBe('g1')
  })

  it('is nothing when the project has no container, or the active pane has no front', () => {
    const { project: p } = base()
    expect(activeGroupId(p, workspace(null), 'p1')).toBeNull()
    expect(activeGroupId(project([pane('a')], []), workspace('a'), 'p1')).toBeNull()
  })

  // A pointer left behind by a front that closed is not somewhere to put a pane.
  it('is nothing when the front it names is gone', () => {
    const p = project([pane('a', 'g9')], [{ id: 'g1', name: 'um', createdAt: 1 }])
    expect(activeGroupId(p, workspace('a'), 'p1')).toBeNull()
  })
})

describe('homeGroupId', () => {
  it('takes the front it was given', () => {
    expect(homeGroupId({ ...base(), requested: 'g2' })).toBe('g2')
  })

  // The caller may be carrying a front from a project that no longer has it.
  it('ignores a front that does not exist and falls back to the screen', () => {
    expect(homeGroupId({ ...base(), requested: 'g-sumiu' })).toBe('g1')
  })

  it('falls back to the front on screen when nothing was asked', () => {
    expect(homeGroupId(base())).toBe('g1')
  })

  // One front, one tree: a pane carrying its own checkout cannot join a front
  // that is working in another.
  it('refuses the front on screen for a pane that owns a worktree', () => {
    expect(homeGroupId({ ...base(), ownsWorktree: true })).toBeNull()
    expect(homeGroupId({ ...base(), ownsWorktree: true, requested: 'g2' })).toBe('g2')
  })

  it('is nothing when there is no front anywhere', () => {
    const empty = { project: project([], []), workspace: workspace(null), projectId: 'p1' }
    expect(homeGroupId(empty)).toBeNull()
  })
})
