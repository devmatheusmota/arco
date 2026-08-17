import { describe, expect, it } from 'vitest'

import {
  buildTaskSessionPrompt,
  collectTodoTags,
  normalizeTodoNotes,
  normalizeTodoPriority,
  normalizeTodoSessions,
  normalizeTodoTitle,
  pruneTodoSessions,
  reorderTodoItems,
  sortTodosByPriority,
  TODO_SESSIONS_MAX,
} from './todos'
import type { TodoItem } from './types'

const items: TodoItem[] = [
  { id: 'a', title: 'A', completed: false, tags: [] },
  { id: 'b', title: 'B', completed: false, tags: [] },
  { id: 'c', title: 'C', completed: true, tags: [] },
]

describe('todos', () => {
  it('normalizes titles', () => {
    expect(normalizeTodoTitle('  ship it  ')).toBe('ship it')
    expect(normalizeTodoTitle(null)).toBe('')
  })

  it('reorders tasks inside the same section', () => {
    expect(reorderTodoItems(items, 'b', 'a').map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not move tasks across completion sections', () => {
    expect(reorderTodoItems(items, 'a', 'c')).toBe(items)
  })

  it('normalizes notes and priority', () => {
    expect(normalizeTodoNotes('  line\r\nother  ')).toBe('line\nother')
    expect(normalizeTodoNotes(42)).toBe('')
    expect(normalizeTodoPriority('high')).toBe('high')
    expect(normalizeTodoPriority('urgent')).toBe('normal')
  })

  it('drops malformed session links and keeps the newest per terminal', () => {
    const sessions = normalizeTodoSessions([
      { terminalId: 't1', projectId: 'p1', agent: 'claude', startedAt: 10 },
      { terminalId: 't1', projectId: 'p1', agent: 'claude', startedAt: 50 },
      { terminalId: '', projectId: 'p1', agent: 'claude', startedAt: 60 },
      { terminalId: 't2', projectId: 'p1', agent: 'codex', startedAt: 90 },
    ])
    expect(sessions.map((session) => [session.terminalId, session.startedAt])).toEqual([
      ['t2', 90],
      ['t1', 10],
    ])
  })

  it('caps stored sessions', () => {
    const raw = Array.from({ length: TODO_SESSIONS_MAX + 4 }, (_, index) => ({
      terminalId: `t${index}`,
      projectId: 'p1',
      agent: 'claude',
      startedAt: index,
    }))
    expect(normalizeTodoSessions(raw)).toHaveLength(TODO_SESSIONS_MAX)
  })

  it('prunes session links and keeps the array identity when nothing matched', () => {
    const withSessions: TodoItem[] = [
      {
        id: 'a',
        title: 'A',
        completed: false,
        tags: [],
        sessions: [
          { terminalId: 't1', projectId: 'p1', agent: 'claude', startedAt: 1 },
          { terminalId: 't2', projectId: 'p2', agent: 'codex', startedAt: 2 },
        ],
      },
      { id: 'b', title: 'B', completed: false, tags: [] },
    ]
    const pruned = pruneTodoSessions(withSessions, (link) => link.terminalId !== 't1')
    expect(pruned[0].sessions?.map((session) => session.terminalId)).toEqual(['t2'])
    expect(pruned[1]).toBe(withSessions[1])
    expect(pruneTodoSessions(withSessions, () => true)).toBe(withSessions)
  })

  it('drops the sessions field once the last link goes', () => {
    const list: TodoItem[] = [
      {
        id: 'a',
        title: 'A',
        completed: false,
        tags: [],
        sessions: [{ terminalId: 't1', projectId: 'p1', agent: 'claude', startedAt: 1 }],
      },
    ]
    expect(pruneTodoSessions(list, () => false)[0]).not.toHaveProperty('sessions')
  })

  it('builds a session prompt from title, tags and notes', () => {
    expect(
      buildTaskSessionPrompt({
        title: 'Fix the parser',
        tags: ['bug', 'parser'],
        notes: 'Repro: …',
      }),
    ).toBe('Task: Fix the parser\nTags: #bug #parser\n\nRepro: …')
    expect(buildTaskSessionPrompt({ title: 'Plain', tags: [] })).toBe('Task: Plain')
  })

  it('floats high priority up without shuffling a tier', () => {
    const list: TodoItem[] = [
      { id: 'a', title: 'A', completed: false, tags: [], priority: 'low' },
      { id: 'b', title: 'B', completed: false, tags: [] },
      { id: 'c', title: 'C', completed: false, tags: [], priority: 'high' },
      { id: 'd', title: 'D', completed: false, tags: [], priority: 'normal' },
    ]
    expect(sortTodosByPriority(list).map((item) => item.id)).toEqual(['c', 'b', 'd', 'a'])
  })

  it('collects tags ordered by usage', () => {
    const list: TodoItem[] = [
      { id: 'a', title: 'A', completed: false, tags: ['docs'] },
      { id: 'b', title: 'B', completed: false, tags: ['fix', 'docs'] },
      { id: 'c', title: 'C', completed: true, tags: ['fix'] },
    ]
    expect(collectTodoTags(list)).toEqual(['docs', 'fix'])
  })
})
