import { describe, expect, it } from 'vitest'

import type { AdoPullRequestSnapshot, AdoWorkItemSnapshot } from './adoApi'
import { planTaskTransition, statusFromPullRequest, statusFromWorkItem } from './adoWatcher'
import type { TodoItem } from './types'

const todo = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: 'abc',
  title: 'x',
  completed: false,
  tags: [],
  status: 'todo',
  ...overrides,
})

describe('statusFromWorkItem', () => {
  it('maps Doing to in_progress and Completed to done', () => {
    expect(statusFromWorkItem({ id: 1, state: 'Doing' } as AdoWorkItemSnapshot)).toBe('in_progress')
    expect(statusFromWorkItem({ id: 1, state: 'Completed' } as AdoWorkItemSnapshot)).toBe('done')
  })

  it('returns null for an unknown state, so the current status stays intact', () => {
    expect(statusFromWorkItem({ id: 1, state: 'Some Custom Column' } as AdoWorkItemSnapshot)).toBeNull()
  })
})

describe('statusFromPullRequest', () => {
  it('draft PRs report in_progress; open PRs report review; merged report done', () => {
    const base: AdoPullRequestSnapshot = {
      id: 1,
      status: 'active',
      isDraft: false,
      reviewers: [],
      hasActiveThreads: false,
    }
    expect(statusFromPullRequest({ ...base, isDraft: true })).toBe('in_progress')
    expect(statusFromPullRequest(base)).toBe('review')
    expect(statusFromPullRequest({ ...base, status: 'completed' })).toBe('done')
  })
})

describe('planTaskTransition', () => {
  it('leaves the task alone when the target matches the current status', () => {
    const item = todo({ status: 'review' })
    const pr: AdoPullRequestSnapshot = {
      id: 10,
      status: 'active',
      isDraft: false,
      reviewers: [],
      hasActiveThreads: false,
    }
    expect(planTaskTransition(item, { pullRequest: pr })).toBeNull()
  })

  it('picks the PR-derived status over the work-item one when both are available', () => {
    const item = todo({ status: 'todo' })
    const workItem: AdoWorkItemSnapshot = { id: 22447, state: 'Doing' }
    const pr: AdoPullRequestSnapshot = {
      id: 10,
      status: 'completed',
      isDraft: false,
      reviewers: [],
      hasActiveThreads: false,
    }
    const event = planTaskTransition(item, { workItem, pullRequest: pr })
    expect(event?.status).toBe('done')
  })

  it('escalates the owner to in_progress when a reviewer asked for changes', () => {
    const item = todo({ status: 'review' })
    const pr: AdoPullRequestSnapshot = {
      id: 10,
      status: 'active',
      isDraft: false,
      createdByUniqueName: 'me@arco.io',
      reviewers: [{ uniqueName: 'other@arco.io', vote: -5, isRequired: true }],
      hasActiveThreads: false,
    }
    expect(planTaskTransition(item, { pullRequest: pr }, { uniqueName: 'me@arco.io' })?.status).toBe(
      'in_progress',
    )
  })

  it('does not escalate when the owner is not the PR author', () => {
    const item = todo({ status: 'review' })
    const pr: AdoPullRequestSnapshot = {
      id: 10,
      status: 'active',
      isDraft: false,
      createdByUniqueName: 'other@arco.io',
      reviewers: [{ uniqueName: 'me@arco.io', vote: -5, isRequired: true }],
      hasActiveThreads: false,
    }
    expect(planTaskTransition(item, { pullRequest: pr }, { uniqueName: 'me@arco.io' })).toBeNull()
  })
})
