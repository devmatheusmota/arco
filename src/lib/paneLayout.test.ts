import { describe, expect, it } from 'vitest'

import { paneGridCells, paneInCycle, paneInDirection, paneRects, panesOnScreen } from './paneLayout'
import type { Terminal, WorkspaceContainer } from './types'

const pane = (id: string, groupId?: string) =>
  ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [],
    ...(groupId ? { groupId } : {}),
  }) as Terminal

const container = (paneIds: string[], extra: Partial<WorkspaceContainer> = {}) =>
  ({
    projectId: 'p',
    paneIds,
    activePaneId: paneIds[0] ?? null,
    sidePaneId: null,
    lastUsedAt: 0,
    size: 0,
    collapsed: false,
    ...extra,
  }) as WorkspaceContainer

describe('panesOnScreen', () => {
  it('shows the front the active session belongs to, and only that front', () => {
    const panes = [pane('a1', 'A'), pane('b1', 'B'), pane('a2', 'A')]
    const screen = panesOnScreen(panes, container(['a1', 'b1', 'a2'], { activePaneId: 'a2' }))
    expect(screen.activePane?.id).toBe('a2')
    expect(screen.visibleIds).toEqual(['a1', 'a2'])
    expect(screen.sidePane).toBeNull()
  })

  it('puts the side terminal beside the front, never the active session itself', () => {
    const panes = [pane('a1', 'A'), pane('s', 'B')]
    expect(
      panesOnScreen(panes, container(['a1', 's'], { activePaneId: 'a1', sidePaneId: 's' })).sidePane
        ?.id,
    ).toBe('s')
    expect(
      panesOnScreen(panes, container(['a1', 's'], { activePaneId: 's', sidePaneId: 's' })).sidePane,
    ).toBeNull()
  })
})

describe('paneGridCells', () => {
  it('squares the grid off and spreads the last row', () => {
    expect(paneGridCells(1)).toEqual([{ left: 0, top: 0, width: 100, height: 100 }])
    expect(paneGridCells(2)).toEqual([
      { left: 0, top: 0, width: 50, height: 100 },
      { left: 50, top: 0, width: 50, height: 100 },
    ])
    expect(paneGridCells(3)).toEqual([
      { left: 0, top: 0, width: 50, height: 50 },
      { left: 50, top: 0, width: 50, height: 50 },
      { left: 0, top: 50, width: 100, height: 50 },
    ])
  })
})

describe('paneInDirection', () => {
  // Four panes: a b / c d.
  const grid = paneRects(['a', 'b', 'c', 'd'], null)

  it('moves to the neighbour on each side of a 2×2 grid', () => {
    expect(paneInDirection(grid, 'a', 'right')).toBe('b')
    expect(paneInDirection(grid, 'a', 'down')).toBe('c')
    expect(paneInDirection(grid, 'd', 'left')).toBe('c')
    expect(paneInDirection(grid, 'd', 'up')).toBe('b')
  })

  it('stops at the edge instead of wrapping around', () => {
    expect(paneInDirection(grid, 'a', 'left')).toBeNull()
    expect(paneInDirection(grid, 'a', 'up')).toBeNull()
    expect(paneInDirection(grid, 'd', 'right')).toBeNull()
  })

  it('reaches the wide bottom pane from either cell above it, and goes back to the first', () => {
    const three = paneRects(['a', 'b', 'c'], null)
    expect(paneInDirection(three, 'a', 'down')).toBe('c')
    expect(paneInDirection(three, 'b', 'down')).toBe('c')
    expect(paneInDirection(three, 'c', 'up')).toBe('a')
  })

  it('treats the side terminal as the column right of the whole front', () => {
    const withSide = paneRects(['a', 'b'], 's')
    expect(paneInDirection(withSide, 'b', 'right')).toBe('s')
    expect(paneInDirection(withSide, 'a', 'right')).toBe('b')
    expect(paneInDirection(withSide, 's', 'left')).toBe('b')
    expect(paneInDirection(withSide, 's', 'right')).toBeNull()
  })

  it('starts from the first pane when the current one is not on screen', () => {
    expect(paneInDirection(grid, 'gone', 'right')).toBe('a')
  })
})

describe('paneInCycle', () => {
  it('steps through the panes on screen and wraps at both ends', () => {
    expect(paneInCycle(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(paneInCycle(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(paneInCycle(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(paneInCycle(['a', 'b', 'c'], null, 1)).toBe('a')
    expect(paneInCycle([], 'a', 1)).toBeNull()
  })
})
