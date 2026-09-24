import { describe, expect, it } from 'vitest'

import { planSessionFollow } from './sessionFollow'
import type { Project } from './types'

const project = (tabs: object[]) =>
  [
    {
      id: 'legends',
      terminals: [{ id: 'pane-6443', cwd: '/home/mota/projetos/emr/Legends', tabs }],
    },
  ] as unknown as Project[]

const claudeTab = {
  id: 'U3ChsRB',
  ptyId: 'U3ChsRB',
  type: 'claude',
  cwd: '/home/mota/projetos/emr/Legends',
  sessionId: '20952054',
}

describe('planSessionFollow', () => {
  it('moves the pane to the conversation /resume went back to', () => {
    const target = planSessionFollow(project([claudeTab]), 'U3ChsRB', '1105a343', null)

    expect(target).toMatchObject({
      projectId: 'legends',
      terminalId: 'pane-6443',
      cwd: '/home/mota/projetos/emr/Legends',
    })
    expect(target?.tab.id).toBe('U3ChsRB')
  })

  it('ignores the start of the conversation the pane already points at', () => {
    expect(planSessionFollow(project([claudeTab]), 'U3ChsRB', '20952054', null)).toBeNull()
  })

  it('ignores a PTY it does not know and a pane that is not Claude', () => {
    expect(planSessionFollow(project([claudeTab]), 'other', '1105a343', null)).toBeNull()
    const shell = { ...claudeTab, type: 'shell' }
    expect(planSessionFollow(project([shell]), 'U3ChsRB', '1105a343', null)).toBeNull()
  })

  it('finds a tab that never got a PTY id of its own', () => {
    const tab = { ...claudeTab, ptyId: null }
    expect(planSessionFollow(project([tab]), 'U3ChsRB', '1105a343', null)?.tab.id).toBe('U3ChsRB')
  })
})
