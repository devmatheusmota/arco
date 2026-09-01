import { describe, expect, it } from 'vitest'

import { cleanChatTitle, isGenericSessionName, sessionDisplayLabel } from './sessionLabel'
import type { SubTab, Terminal } from './types'

function pane(over: Partial<Terminal> = {}): Terminal {
  const tabs: SubTab[] = [{ id: 'tab1', type: 'claude', name: 'claude', cwd: '/repo', ptyId: null }]
  return {
    id: 't1',
    name: 'Claude Code',
    cwd: '/repo',
    tabs,
    activeTabId: 'tab1',
    disabled: false,
    ...over,
  }
}

describe('sessionDisplayLabel', () => {
  // The rename writes `terminal.name`, which the old chain reached last — behind
  // a title the agent had almost always generated. So renaming appeared to do
  // nothing at all.
  it('puts a name someone typed above the generated title', () => {
    const label = sessionDisplayLabel(
      pane({ name: 'Investigar aluno', nameSource: 'user' }),
      'Debugging the enrollment query',
    )

    expect(label).toBe('Investigar aluno')
  })

  it('prefers the task a session was started for over the conversation title', () => {
    const label = sessionDisplayLabel(
      pane({ name: 'apoiar Erika no teste do 19763', nameSource: 'task' }),
      'Investigating a failing assertion',
    )

    expect(label).toBe('apoiar Erika no teste do 19763')
  })

  it('falls back to the conversation title when the name is only a placeholder', () => {
    const label = sessionDisplayLabel(
      pane({ name: 'Claude Code', nameSource: 'auto' }),
      'Retorno correto de dados para o front',
    )

    expect(label).toBe('Retorno correto de dados para o front')
  })

  // Without this the row reads "Claude Code" for every unnamed pane, which is
  // exactly as useless as reading "claude".
  it('never returns the agent label when a real name exists', () => {
    const label = sessionDisplayLabel(pane({ name: 'deploy stuff', nameSource: 'auto' }), null)

    expect(label).toBe('deploy stuff')
  })

  it('lands on the agent label only when there is nothing else', () => {
    expect(sessionDisplayLabel(pane({ nameSource: 'auto' }), null)).toBe('Claude Code')
  })
})

describe('cleanChatTitle', () => {
  // Every session started from a skill was named after the context the app
  // injected, so a dozen rows read "Base directory for this skill: /home/mota…".
  it('rejects a title that is echoed context rather than a subject', () => {
    expect(cleanChatTitle('Base directory for this skill: /home/mota/.claude/skills')).toBeNull()
    expect(cleanChatTitle('You are an AI assistant helping with')).toBeNull()
  })

  it('drops a structural opener that repeats across tasks', () => {
    expect(cleanChatTitle('Task: revisar o PR 11106')).toBe('revisar o PR 11106')
    expect(cleanChatTitle('[REVIEW] PR 11106 manager prova')).toBe('PR 11106 manager prova')
  })

  // A path identifies by its end, so cutting the tail throws away the only part
  // that distinguishes it from its siblings.
  it('keeps the end of a path instead of the start', () => {
    expect(cleanChatTitle('/home/mota/.claude/skills/pr-review', 24)).toBe('/…/pr-review')
  })

  it('truncates prose at the end, where the opening still identifies it', () => {
    expect(cleanChatTitle('Corrigir o retorno de dados do front no endpoint novo', 20)).toBe(
      'Corrigir o retorno…',
    )
  })

  it('has nothing to say about an empty title', () => {
    expect(cleanChatTitle('')).toBeNull()
    expect(cleanChatTitle(null)).toBeNull()
    expect(cleanChatTitle(undefined)).toBeNull()
  })

  it('leaves a short subject exactly as it is', () => {
    expect(cleanChatTitle('Bug mesa trancada sem ocupante')).toBe('Bug mesa trancada sem ocupante')
  })
})

describe('isGenericSessionName', () => {
  it('recognizes both the label and the raw agent type', () => {
    expect(isGenericSessionName('Claude Code')).toBe(true)
    expect(isGenericSessionName('claude')).toBe(true)
    expect(isGenericSessionName('  Codex ')).toBe(true)
  })

  it('leaves a real name alone', () => {
    expect(isGenericSessionName('Investigar aluno')).toBe(false)
  })
})
