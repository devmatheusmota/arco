import type { AgentType } from './types'

/**
 * What a session started here is told about Arco's board and panes.
 *
 * An agent has no way to discover either on its own: nothing in the repository
 * hints at them. Without this the task board stays a human-only surface — the
 * agent works on a task it can read but cannot move.
 *
 * The MCP server comes first because it is the better door: typed arguments, a
 * refusal instead of a silent fallback, output that is never cut. Leading with
 * the shell command kept agents composing `arco` lines even once the tools were
 * loaded, since a footnote at the end reads as an afterthought. The command is
 * still named for what the tools leave out, and for when they are missing.
 *
 * Kept short on purpose: it costs context on every session. Grows only when the
 * surface grows — `arcoCliContext.test.ts` fails when the two drift.
 */
export const CLI_CONTEXT_PROMPT = [
  'This session runs inside Arco, the app that started it. Arco holds the work in fronts;',
  'each front has panes (agent sessions). A pane answers to a short reference like pa-3576,',
  'and yours is in $ARCO_PANE_ID.',
  '',
  'Keep the task board honest. Every task has a kind (review, pr, task, refinement, release,',
  'investigation, general) with stages of its own, listed by todo_show: move it to the stage',
  "the work is in as it moves. in-progress and review mean that kind's start and hand-back.",
  '',
  'The `arco` MCP server is how you reach the board and the other panes. Its tools check',
  'their arguments, never truncate, and already know which pane you are (`current`):',
  '',
  '  todo_list, todo_show, todo_add    the tasks, one in full, a new one',
  '  todo_status, todo_edit            move a task; change its kind, title, tags, notes or priority',
  '  project_list                      projects and their directories',
  '  session_list, group_list          the panes open now, and the fronts they sit in',
  '  session_send                      text for a pane already running',
  '  session_open, session_close       open a pane, a front or a worktree; close a pane',
  '  group_close                       close a front, its panes and its worktree, when asked to',
  '  open_url                          a web page in the browser, brought in front of Arco',
  '',
  'A pane you send text to answers in its own pane, so say what you need. Text another',
  'pane sends you starts with a line naming it; answer it with session_send.',
  '',
  'The `arco` shell command covers the same ground, plus what the tools leave out. Use it',
  'for these, or when the tools are missing:',
  '',
  '  arco todo delete <ref> --yes        removes a task, including one created by mistake',
  '  arco project add <name> --cwd <dir> a project for a repo that has none, before filing tasks',
  '',
  '`arco help` lists the rest. Do not edit the task board any other way.',
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
