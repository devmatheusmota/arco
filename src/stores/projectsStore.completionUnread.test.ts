import { describe, expect, it } from 'vitest'

import type { SubTab, Terminal } from '../lib/types'
import type { SliceCtx } from './projectsStore.slices'
import { createSubTabsSlice } from './projectsStore.slices'

function tab(id: string, completionUnread?: boolean): SubTab {
  return { id, type: 'claude', name: 'claude', cwd: '/repo', ptyId: null, completionUnread }
}

function paneWith(tabs: SubTab[]): Terminal {
  return {
    id: 't1',
    name: 'Claude Code',
    cwd: '/repo',
    tabs,
    activeTabId: tabs[0].id,
    disabled: false,
  }
}

/**
 * Runs the slice against one pane and hands back what the mutator produced,
 * plus whether it asked for a change at all — returning the same object is how
 * an action opts out of the debounced save.
 */
function runClear(pane: Terminal) {
  let result = pane
  const ctx = {
    updateTerminal: (_projectId: string, _terminalId: string, fn: (t: Terminal) => Terminal) => {
      result = fn(pane)
    },
    updateSubTab: () => {},
  } as unknown as SliceCtx

  createSubTabsSlice(ctx).clearTerminalCompletionUnread('p1', 't1')
  return { result, changed: result !== pane }
}

describe('clearTerminalCompletionUnread', () => {
  // The sidebar row lights up for *any* tab of the pane, so visiting it has to
  // clear all of them. Clearing only the active tab left the row lit with
  // nothing left for the user to visit.
  it('clears every tab of the pane, not just the active one', () => {
    const { result, changed } = runClear(
      paneWith([tab('tab1', true), tab('tab2', true), tab('tab3')]),
    )

    expect(result.tabs.map((entry) => entry.completionUnread)).toEqual([false, false, undefined])
    expect(changed).toBe(true)
  })

  it('leaves the pane untouched when nothing is unread, so no save is scheduled', () => {
    const { changed } = runClear(paneWith([tab('tab1'), tab('tab2', false)]))

    expect(changed).toBe(false)
  })

  it('keeps the rest of each tab intact', () => {
    const { result } = runClear(paneWith([tab('tab1', true)]))

    expect(result.tabs[0]).toMatchObject({ id: 'tab1', type: 'claude', cwd: '/repo' })
    expect(result.activeTabId).toBe('tab1')
  })
})
