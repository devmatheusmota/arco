import { describe, expect, it } from 'vitest'

import { frontEntryPane, frontForSlot, frontShortcuts, orderedFronts } from './frontOrder'
import type { Project, Terminal } from './types'

const pane = (id: string, groupId: string, extra: Partial<Terminal> = {}) =>
  ({
    id,
    name: id,
    cwd: '/repo',
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [],
    groupId,
    ...extra,
  }) as Terminal

const project = (id: string, groupIds: string[], terminals: Terminal[], extra = {}) =>
  ({
    id,
    name: id,
    terminals,
    groups: groupIds.map((groupId) => ({ id: groupId, name: groupId, createdAt: 0 })),
    createdAt: 0,
    ...extra,
  }) as Project

describe('orderedFronts', () => {
  it('lists fronts in sidebar order: projects as ordered, fronts as each project keeps them', () => {
    const projects = [
      project('beta', ['b1'], [pane('x', 'b1')]),
      project('alpha', ['a1', 'a2'], [pane('y', 'a2'), pane('z', 'a1')]),
    ]
    const fronts = orderedFronts(['alpha', 'beta'], projects)
    expect(fronts.map((front) => front.group.id)).toEqual(['a1', 'a2', 'b1'])
    expect(fronts[0].panes.map((p) => p.id)).toEqual(['z'])
  })

  it('skips archived projects, projects missing from the order and fronts with no session', () => {
    const projects = [
      project('alpha', ['a1', 'empty'], [pane('x', 'a1')]),
      project('old', ['o1'], [pane('y', 'o1')], { archived: true }),
      project('stray', ['s1'], [pane('z', 's1')]),
    ]
    expect(orderedFronts(['alpha', 'old'], projects).map((front) => front.group.id)).toEqual(['a1'])
  })

  it('keeps counting a collapsed project, so folding it away renumbers nothing', () => {
    const projects = [
      project('alpha', ['a1'], [pane('x', 'a1')], { collapsed: true }),
      project('beta', ['b1'], [pane('y', 'b1')]),
    ]
    expect(orderedFronts(['alpha', 'beta'], projects).map((front) => front.group.id)).toEqual([
      'a1',
      'b1',
    ])
  })

  it('leaves out the GSD sync viewers, which the sidebar does not list', () => {
    const projects = [project('alpha', ['a1'], [pane('v', 'a1', { gsdSyncViewer: true })])]
    expect(orderedFronts(['alpha'], projects)).toEqual([])
  })
})

describe('frontForSlot', () => {
  const projects = [
    project(
      'alpha',
      ['a1', 'a2', 'a3'],
      ['a1', 'a2', 'a3'].map((g) => pane(g, g)),
    ),
  ]
  const fronts = orderedFronts(['alpha'], projects)

  it('opens by position with 1–9 and the last one with 0', () => {
    expect(frontForSlot(fronts, 1)?.group.id).toBe('a1')
    expect(frontForSlot(fronts, 3)?.group.id).toBe('a3')
    expect(frontForSlot(fronts, 0)?.group.id).toBe('a3')
    expect(frontForSlot(fronts, 4)).toBeNull()
    expect(frontForSlot([], 0)).toBeNull()
  })
})

describe('frontEntryPane', () => {
  it('returns to the session used last, else the orchestrator, else the first', () => {
    const [front] = orderedFronts(
      ['alpha'],
      [
        project(
          'alpha',
          ['a1'],
          [
            pane('first', 'a1'),
            pane('orchestrator', 'a1', { pinned: true }),
            pane('recent', 'a1', { lastUsedAt: 20 }),
            pane('older', 'a1', { lastUsedAt: 10 }),
          ],
        ),
      ],
    )
    expect(frontEntryPane(front).id).toBe('recent')
    const unused = { ...front, panes: front.panes.slice(0, 2) }
    expect(frontEntryPane(unused).id).toBe('orchestrator')
    expect(frontEntryPane({ ...front, panes: front.panes.slice(0, 1) }).id).toBe('first')
  })
})

describe('frontShortcuts', () => {
  it('labels the first nine fronts and the last one', () => {
    const groups = Array.from({ length: 11 }, (_, index) => `g${index + 1}`)
    const fronts = orderedFronts(
      ['alpha'],
      [
        project(
          'alpha',
          groups,
          groups.map((g) => pane(g, g)),
        ),
      ],
    )
    const labels = frontShortcuts(fronts, false)
    expect(labels.get('g1')).toBe('Ctrl+1')
    expect(labels.get('g9')).toBe('Ctrl+9')
    expect(labels.has('g10')).toBe(false)
    expect(labels.get('g11')).toBe('Ctrl+0')
    expect(frontShortcuts(fronts, true).get('g1')).toBe('⌘1')
  })
})
