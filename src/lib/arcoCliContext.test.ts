import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { CLI_CONTEXT_PROMPT } from './cliContext'

const require = createRequire(import.meta.url)
const { USAGE } = require('../../electron/cli.cjs') as { USAGE: string }

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
    const missing = documentedCommands().filter(
      (name) => !CLI_CONTEXT_PROMPT.includes(name) && !(name in OUT_OF_SCOPE),
    )

    expect(
      missing,
      `These commands exist in the CLI but agents are never told about them: ${missing.join(', ')}. ` +
        'Add them to CLI_CONTEXT_PROMPT, or to OUT_OF_SCOPE with the reason.',
    ).toEqual([])
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
