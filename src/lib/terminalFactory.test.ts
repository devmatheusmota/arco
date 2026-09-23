import { describe, expect, it } from 'vitest'

import { getProjectRepoRoot, isInsideArcoWorktree } from './terminalFactory'
import type { Project, Terminal } from './types'

const REPO = '/home/mota/projetos/emr/SOA'

function pane(id: string, cwd: string, extra: Partial<Terminal> = {}): Terminal {
  return {
    id,
    name: id,
    cwd,
    activeTabId: `${id}-t`,
    disabled: false,
    tabs: [{ id: `${id}-t`, type: 'claude', name: 'claude', cwd, ptyId: id }],
    ...extra,
  } as Terminal
}

function project(terminals: Terminal[], defaultCwd = REPO): Project {
  return {
    id: 'p1',
    name: 'SOA',
    defaultCwd,
    collapsed: false,
    createdAt: 1,
    groups: [],
    terminals,
  } as Project
}

describe('getProjectRepoRoot', () => {
  it('takes the cwd of a pane that stands outside every worktree', () => {
    const repo = getProjectRepoRoot(project([pane('a', REPO, { lastUsedAt: 2 })]))
    expect(repo).toBe(REPO)
  })

  it('derives the root from the pane that provisioned the worktree', () => {
    const isolated = pane('a', `${REPO}/.arco/worktrees/cl-74FbUZ`, {
      worktreeAgentId: 'cl-74FbUZ',
      lastUsedAt: 2,
    })
    expect(getProjectRepoRoot(project([isolated]))).toBe(REPO)
  })

  // The regression: a second pane opened in a front inherits the front's
  // directory without provisioning anything, so it carries no `worktreeAgentId`.
  // Read as the root, it nested every later worktree inside the first one.
  it('does not take a pane inside someone else\u2019s worktree as the root', () => {
    const owner = pane('pa-0387', `${REPO}/.arco/worktrees/cl-74FbUZ`, {
      worktreeAgentId: 'cl-74FbUZ',
      lastUsedAt: 3,
    })
    const guest = pane('pa-9582', `${REPO}/.arco/worktrees/cl-74FbUZ`, { lastUsedAt: 9 })

    expect(getProjectRepoRoot(project([owner, guest]))).toBe(REPO)
  })

  it('unwinds a worktree that was already nested to the outermost root', () => {
    const nested = pane('pa-2574', `${REPO}/.arco/worktrees/cl-74FbUZ/.arco/worktrees/cl-ellH-L`, {
      worktreeAgentId: 'cl-ellH-L',
      lastUsedAt: 4,
    })
    expect(getProjectRepoRoot(project([nested]))).toBe(REPO)
  })

  it('prefers the most recent pane among the ones outside a worktree', () => {
    const old = pane('a', '/repo/old', { lastUsedAt: 1 })
    const recent = pane('b', '/repo/recent', { lastUsedAt: 9 })
    expect(getProjectRepoRoot(project([old, recent]))).toBe('/repo/recent')
  })

  it('ignores the sync viewer, which never answers for a tree', () => {
    const viewer = pane('v', '/repo/viewer', { gsdSyncViewer: true, lastUsedAt: 9 })
    const real = pane('r', REPO, { lastUsedAt: 1 })
    expect(getProjectRepoRoot(project([viewer, real]))).toBe(REPO)
  })

  it('answers empty for a project with no pane to read', () => {
    expect(getProjectRepoRoot(project([]))).toBe('')
    expect(getProjectRepoRoot(null)).toBe('')
  })
})

describe('isInsideArcoWorktree', () => {
  it('matches the segment on both separators and misses a lookalike path', () => {
    expect(isInsideArcoWorktree(`${REPO}/.arco/worktrees/cl-1`)).toBe(true)
    expect(isInsideArcoWorktree('C:\\repo\\.arco\\worktrees\\cl-1')).toBe(true)
    expect(isInsideArcoWorktree(`${REPO}/arco/worktrees/cl-1`)).toBe(false)
    expect(isInsideArcoWorktree(REPO)).toBe(false)
  })
})
