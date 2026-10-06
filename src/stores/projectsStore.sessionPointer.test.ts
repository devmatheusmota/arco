import { describe, expect, it } from 'vitest'

import type { SubTab } from '../lib/types'
import type { SliceCtx } from './projectsStore.slices'
import { createSubTabsSlice } from './projectsStore.slices'

function moveSession(tab: SubTab, sessionId: string | undefined): SubTab {
  let result = tab
  const ctx = {
    updateTerminal: () => {},
    updateSubTab: (
      _projectId: string,
      _terminalId: string,
      _tabId: string,
      fn: (s: SubTab) => SubTab,
    ) => {
      result = fn(tab)
    },
  } as unknown as SliceCtx

  createSubTabsSlice(ctx).setSubTabSessionId('p1', 't1', tab.id, sessionId)
  return result
}

const fresh: SubTab = { id: 'tab1', type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }

describe('setSubTabSessionId', () => {
  it('remembers nothing for the session a new pane starts with', () => {
    expect(moveSession(fresh, 'empty').previousSessionIds).toBeUndefined()
  })

  it('remembers the conversation a pane moves away from', () => {
    const cleared = moveSession({ ...fresh, sessionId: 'conversation' }, 'after-clear')

    expect(cleared).toMatchObject({
      sessionId: 'after-clear',
      previousSessionIds: ['conversation'],
    })
  })
})
