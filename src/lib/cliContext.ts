import type { AgentType } from './types'

/**
 * What a session started here is told about the `arco` command.
 *
 * An agent has no way to discover the command: it is a shim on PATH that talks
 * to the running app over a local socket, and nothing in the repository hints at
 * it. Without this the task board stays a human-only surface — the agent works
 * on a task it can read but cannot move.
 *
 * It covers the panes as well as the board. Listing only `arco todo` left an
 * agent asked to open a session, or to reach another one, running `arco help`
 * first to find out how — every time, because nothing carried over. The command
 * surface here is the whole of it, minus what an agent has no business doing on
 * its own; anything rarer is one `--help` away.
 *
 * Kept short on purpose: it costs context on every session. Grows only when the
 * command line grows — `arcoCliContext.test.ts` fails when the two drift.
 */
export const CLI_CONTEXT_PROMPT = [
  'This session runs inside Arco, and the `arco` command talks to the app that started it.',
  'Arco holds the work in fronts; each front has panes (agent sessions). A pane answers to a',
  'short reference like pa-3576, and yours is in $ARCO_PANE_ID.',
  '',
  'Keep the task board honest — move a task to in-progress when you pick it up, and to',
  'review when you hand the work back.',
  '',
  '  arco todo list                      tasks with their short id, status and tags',
  '  arco todo show <ref>                one task in full: notes, tags, linked card',
  '  arco todo add "<title>" [--tag <tag>] [--status <status>] [--session current]',
  '  arco todo status <ref> <status>     todo | in-progress | review | done',
  '  arco todo edit <ref> [--title <text>] [--add-tag <tag>] [--remove-tag <tag>]',
  '                      [--priority high|normal|low] [--notes <text>]',
  '  arco todo delete <ref> --yes        removes a task, including one created by mistake',
  '  arco project list                   projects and their directories; --project takes the name',
  '  arco project add <name> --cwd <dir> a project for a repo that has none, before filing tasks',
  '',
  'You can also reach the other sessions. A pane you send text to answers in its own pane,',
  'so say what you need; the delivery already names you and the command to reply.',
  '',
  '  arco session list                   who is open now, with the reference of each pane',
  '  arco session send <ref> <text>      text for a pane already running (--file to send a file)',
  '  arco session [--agent claude|codex|opencode|shell] [--group <name>] [--todo <ref>]',
  '                                      opens a pane; a --group name that matches no front',
  '                                      opens that front, and --worktree isolates it',
  '  arco session close <ref>            closes one pane; the front stays open',
  '  arco group list                     the fronts open, and the panes in each',
  '',
  '<ref> is the short id from the matching `list`, or a unique piece of a task title.',
  '`--session current` records that this session owns the task, on `add` or `edit`;',
  'the board keeps that link after the session ends, which is where it earns its keep.',
  'Every command prints what it did and fails loudly; an unknown subcommand is',
  'refused instead of becoming a new task. Any command takes `--help`.',
  'Run `arco help` for the full surface. Do not edit the task board any other way.',
].join('\n')

/**
 * Arguments that carry the context, for agents whose CLI can take extra system
 * instructions without replacing their own. Codex and OpenCode have no additive
 * flag today, so their sessions are left untouched rather than overwritten.
 */
export function buildCliContextArgs(agent: AgentType, enabled: boolean): string[] {
  if (!enabled || agent !== 'claude') return []
  return ['--append-system-prompt', CLI_CONTEXT_PROMPT]
}

/**
 * Best-effort fallback for the two agents that reject an additive system flag.
 *
 * Codex and OpenCode need the context delivered as chat text — worse than a
 * real system prompt (an agent can forget it a few turns in), but honest:
 * without this the task board they can move is invisible to them. Only used
 * when a session already starts with a first message (the taskSession flow),
 * so a plain terminal open of Codex stays exactly as the CLI would launch it.
 */
export function buildCliContextInitialInput(agent: AgentType, enabled: boolean): string | null {
  if (!enabled) return null
  if (agent !== 'codex' && agent !== 'opencode') return null
  return CLI_CONTEXT_PROMPT
}
