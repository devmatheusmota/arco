import { describe, expect, it } from 'vitest'

import { liveSessionOf, resolveBoardDrop } from './boardDrop'
import type { Project, TodoItem } from './types'

function task(over: Partial<TodoItem> = {}): TodoItem {
  return { id: 'todo1', title: 'apoiar Erika no teste', completed: false, tags: [], ...over }
}

function projectWithPane(paneId: string): Project {
  return {
    id: 'p1',
    name: 'SOA',
    terminals: [
      { id: paneId, name: 'pane', cwd: '/repo', tabs: [], activeTabId: '', disabled: false },
    ],
  } as unknown as Project
}

describe('resolveBoardDrop', () => {
  it('only moves the card for any column but in progress', () => {
    expect(resolveBoardDrop(task(), [], 'review')).toEqual({ move: 'review', then: 'nothing' })
    expect(resolveBoardDrop(task(), [], 'done')).toEqual({ move: 'done', then: 'nothing' })
  })

  // A drag is cheap to make by accident and starting an agent is expensive and
  // visible, so the board offers rather than spawns.
  it('offers a session when an unstarted task reaches in progress', () => {
    expect(resolveBoardDrop(task({ status: 'todo' }), [], 'in_progress')).toEqual({
      move: 'in_progress',
      then: 'offer',
    })
  })

  // The task already has a pane, so there is nothing to offer — and the drop
  // does not jump to it either: the board keeps the screen.
  it('only moves a task that already has a session', () => {
    const todo = task({
      status: 'todo',
      sessions: [{ projectId: 'p1', terminalId: 'pane1', agent: 'claude', startedAt: 1 }],
    })

    expect(resolveBoardDrop(todo, [projectWithPane('pane1')], 'in_progress')).toEqual({
      move: 'in_progress',
      then: 'nothing',
    })
  })

  // The work already started once; proposing a new session on the way back
  // would be noise.
  it('stays quiet when a task comes back from review', () => {
    expect(resolveBoardDrop(task({ status: 'review' }), [], 'in_progress')).toEqual({
      move: 'in_progress',
      then: 'nothing',
    })
  })

  it('does nothing extra when the card was already in progress', () => {
    expect(resolveBoardDrop(task({ status: 'in_progress' }), [], 'in_progress')).toEqual({
      move: 'in_progress',
      then: 'nothing',
    })
  })
})

describe('liveSessionOf', () => {
  it('finds the pane even when the link names no project', () => {
    const todo = task({
      session: { id: 'pane1', linkedAt: 1 },
    })

    expect(liveSessionOf(todo, [projectWithPane('pane1')])).toEqual({
      projectId: 'p1',
      terminalId: 'pane1',
    })
  })

  it('ignores a link whose pane is gone', () => {
    const todo = task({
      sessions: [{ projectId: 'p1', terminalId: 'ghost', agent: 'claude', startedAt: 1 }],
    })

    expect(liveSessionOf(todo, [projectWithPane('pane1')])).toBeNull()
  })
})
