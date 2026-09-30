import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { CLI_CONTEXT_PROMPT } from './cliContext'

const require = createRequire(import.meta.url)
const { USAGE } = require('../../electron/cli.cjs') as { USAGE: string }
const { TOOLS } = require('../../electron/mcp-server.cjs') as { TOOLS: { name: string }[] }

/**
 * Keeps what agents are told in step with what the command line offers.
 *
 * The preamble is the only way a session learns `arco` exists, and it went a
 * long time listing `arco todo` alone — so an agent asked to open a pane, or to
 * reach another one, had to run `arco help` to find out how, every session.
 * Nobody noticed because nothing failed: the preamble is not wrong when it is
 * merely out of date, it is just useless for the part it leaves out.
 *
 * A release checklist would be the other way to catch this, and it is the one
 * that depends on somebody remembering. This does not.
 */

/**
 * Commands the context covers through the MCP tool that does the same job. The
 * context names the tool, not the command: naming both is what kept agents on
 * the shell once the tools were there.
 */
const COVERED_BY_TOOL: Record<string, string> = {
  'arco todo list': 'todo_list',
  'arco todo show': 'todo_show',
  'arco todo add': 'todo_add',
  'arco todo edit': 'todo_edit',
  'arco todo status': 'todo_status',
  'arco project list': 'project_list',
  'arco session': 'session_open',
  'arco session list': 'session_list',
  'arco session send': 'session_send',
  'arco session close': 'session_close',
  'arco group list': 'group_list',
}

/** Commands deliberately left out, with the reason they stay out. */
const OUT_OF_SCOPE: Record<string, string> = {
  'arco session rename': 'renaming its own pane is noise, not work an agent is asked for',
  'arco group close': 'closes the front and deletes its worktree — not an agent decision',
  'arco todo': 'the bare form is the shortcut for `arco todo add`, already listed',
}

function documentedCommands(): string[] {
  const detail = USAGE.split('Detalhe de cada um abaixo.').pop() ?? ''
  const heads = [...detail.matchAll(/^ {2}(arco(?: [a-z]+)*)/gm)].map((match) => match[1].trim())
  // `arco` on its own opens a directory; it is not something a session runs.
  return [...new Set(heads)].filter((name) => name !== 'arco')
}

describe('the context handed to agents', () => {
  it('mentions every command the CLI documents, or says why it does not', () => {
    const missing = documentedCommands().filter((name) => {
      if (name in OUT_OF_SCOPE) return false
      const tool = COVERED_BY_TOOL[name]
      return !(tool ? CLI_CONTEXT_PROMPT.includes(tool) : CLI_CONTEXT_PROMPT.includes(name))
    })

    expect(
      missing,
      `These commands exist in the CLI but agents are never told about them: ${missing.join(', ')}. ` +
        'Name them (or the MCP tool that covers them, in COVERED_BY_TOOL) in CLI_CONTEXT_PROMPT, ' +
        'or add them to OUT_OF_SCOPE with the reason.',
    ).toEqual([])
  })

  it('covers commands only through tools the MCP server has', () => {
    const tools = new Set(TOOLS.map((tool) => tool.name))
    const ghosts = Object.values(COVERED_BY_TOOL).filter((name) => !tools.has(name))
    expect(
      ghosts,
      `COVERED_BY_TOOL names tools the server does not offer: ${ghosts.join(', ')}`,
    ).toEqual([])
  })

  it('names every tool the MCP server offers', () => {
    const unnamed = TOOLS.map((tool) => tool.name).filter(
      (name) => !CLI_CONTEXT_PROMPT.includes(name),
    )
    expect(unnamed, `Tools agents are never told about: ${unnamed.join(', ')}`).toEqual([])
  })

  it('does not promise commands the CLI no longer has', () => {
    const documented = documentedCommands()
    const promised = [...CLI_CONTEXT_PROMPT.matchAll(/^ {2}(arco(?: [a-z]+)*)/gm)].map((match) =>
      match[1].trim(),
    )
    const ghosts = promised.filter(
      (name) => !documented.some((real) => real === name || real.startsWith(`${name} `)),
    )

    expect(
      ghosts,
      `The context names commands the CLI does not have: ${ghosts.join(', ')}.`,
    ).toEqual([])
  })

  // It rides on every session, so its size is a cost paid over and over.
  it('stays small enough to carry on every session', () => {
    expect(CLI_CONTEXT_PROMPT.split('\n').length).toBeLessThanOrEqual(40)
  })
})
