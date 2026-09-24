/**
 * Which keys belong to the app and which to whatever has focus.
 *
 * The window listener in `useKeybindings` acts on this table, and xterm's custom
 * key handler refuses to forward anything in it. xterm never looks at
 * `defaultPrevented`, so a chord the app acted on and the terminal handler let
 * through reached the PTY as well: Ctrl+3 switched projects and sent ESC to the
 * agent, which interrupts Claude, and Ctrl+Tab switched tabs and sent a TAB. With
 * one table a key is either the app's or the terminal's, never both.
 *
 * It runs on every keydown, so the plain keys typing is made of leave on the
 * first comparison.
 */

export type KeyChord = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

export type AppShortcut =
  | { type: 'zoom'; step: 1 | -1 }
  | { type: 'zoomReset' }
  | { type: 'restartTerminal' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'newTerminal' }
  | { type: 'repeatTerminal' }
  | { type: 'reopenClosedTab' }
  | { type: 'addContent' }
  | { type: 'closePane' }
  | { type: 'findJump' }
  | { type: 'newProject' }
  | { type: 'toggleHome' }
  | { type: 'focusTaskComposer' }
  /** 1–9 open the front in that position; 0 opens the last one. */
  | { type: 'openFront'; slot: number }
  | { type: 'history'; step: 1 | -1 }
  | { type: 'cyclePane'; step: 1 | -1 }
  | { type: 'focusPane'; direction: PaneDirection }
  | { type: 'cycleProjectTab'; step: 1 | -1 }

/**
 * Where the key lands. In a terminal or a text field the plain keys are typing,
 * so only modified chords can be the app's. A text field also keeps
 * Alt+Shift+arrows, which select by word on macOS.
 */
export type KeyFocus = 'terminal' | 'field' | 'none'

export type KeyContext = {
  focus: KeyFocus
  /** A task composer is mounted to take Ctrl+N; without one the key is the terminal's. */
  taskComposer: boolean
}

const PANE_DIRECTIONS: Record<string, PaneDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

export function resolveAppShortcut(event: KeyChord, context: KeyContext): AppShortcut | null {
  const ctrl = event.ctrlKey || event.metaKey
  if (!ctrl) {
    if (!event.altKey && context.focus !== 'none') return null
    return resolvePlain(event, context)
  }
  // Ctrl+Alt is AltGr on Windows, which types characters (`?` and `/` on ABNT2),
  // so a Ctrl+letter shortcut must not fire with Alt held.
  if (event.altKey) {
    if (!event.shiftKey && event.key.toLowerCase() === 't') return { type: 'repeatTerminal' }
    return null
  }
  return resolveCtrl(event, context)
}

function resolvePlain(event: KeyChord, context: KeyContext): AppShortcut | null {
  if (event.altKey && event.shiftKey && context.focus !== 'field') {
    const direction = PANE_DIRECTIONS[event.key]
    if (direction) return { type: 'focusPane', direction }
  }
  if (context.focus !== 'none') return null
  if (event.altKey) {
    if (!event.shiftKey && event.key === 'ArrowLeft') return { type: 'history', step: -1 }
    if (!event.shiftKey && event.key === 'ArrowRight') return { type: 'history', step: 1 }
    return null
  }
  if (event.key === 'Tab' && event.shiftKey) return { type: 'cyclePane', step: 1 }
  if (!event.shiftKey && (event.key === 'r' || event.key === 'R')) {
    return { type: 'restartTerminal' }
  }
  return null
}

function resolveCtrl(event: KeyChord, context: KeyContext): AppShortcut | null {
  if (event.code === 'Numpad0' && event.key === '0') return { type: 'zoomReset' }
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
    return { type: 'zoom', step: 1 }
  }
  if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
    return { type: 'zoom', step: -1 }
  }

  const slot = event.shiftKey ? null : digitSlot(event)
  if (slot !== null) return { type: 'openFront', slot }

  if (event.key === 'Tab') return { type: 'cycleProjectTab', step: event.shiftKey ? -1 : 1 }
  if (event.key === 'PageUp') return { type: 'cyclePane', step: -1 }
  if (event.key === 'PageDown') return { type: 'cyclePane', step: 1 }

  const shift = event.shiftKey
  switch (event.key.toLowerCase()) {
    case 'b':
      return shift ? null : { type: 'toggleLeftSidebar' }
    case 't':
      return shift ? { type: 'reopenClosedTab' } : { type: 'newTerminal' }
    case 'a':
      return shift ? { type: 'addContent' } : null
    case 'w':
      return shift ? null : { type: 'closePane' }
    case 'p':
      return shift ? { type: 'newProject' } : { type: 'findJump' }
    case 'h':
      return shift ? { type: 'toggleHome' } : null
    case 'n':
      return !shift && context.taskComposer ? { type: 'focusTaskComposer' } : null
    default:
      return null
  }
}

/**
 * The digit of a Ctrl+digit chord, read from the physical key so it holds on
 * layouts where the top row types symbols unshifted. The numpad counts only
 * with Num Lock on — off, those keys are Ctrl+End, Ctrl+Home and the rest — and
 * its 0 resets the zoom instead.
 */
function digitSlot(event: KeyChord): number | null {
  const match = /^(Digit|Numpad)([0-9])$/.exec(event.code)
  if (match) {
    if (match[1] === 'Digit') return Number(match[2])
    return /^[1-9]$/.test(event.key) ? Number(match[2]) : null
  }
  // Synthetic events and some remote keyboards carry no code.
  if (!event.code && /^[0-9]$/.test(event.key)) return Number(event.key)
  return null
}

/** Where a keydown landed, in the terms `resolveAppShortcut` needs. */
export function keyFocusOf(target: EventTarget | null): KeyFocus {
  if (!(target instanceof HTMLElement)) return 'none'
  if (target.classList.contains('xterm-helper-textarea')) return 'terminal'
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return 'field'
  }
  return 'none'
}

let mountedTaskComposers = 0

/** Declares a task composer on screen, so Ctrl+N is the app's while it lasts. */
export function registerTaskComposer(): () => void {
  mountedTaskComposers += 1
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    mountedTaskComposers -= 1
  }
}

export function taskComposerAvailable(): boolean {
  return mountedTaskComposers > 0
}

/** Asks the mounted task composer to take focus. */
export const FOCUS_TASK_COMPOSER_EVENT = 'arco:focus-task-composer'

/** Whether a keydown inside a terminal is the app's rather than the process's. */
export function isAppChordInTerminal(event: KeyChord): boolean {
  return (
    resolveAppShortcut(event, { focus: 'terminal', taskComposer: taskComposerAvailable() }) !== null
  )
}

const SUSPENDING_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode'])

/**
 * Whether Ctrl+Z has to stay out of the agent running in a pane.
 *
 * Claude Code, Codex and OpenCode answer Ctrl+Z by stopping themselves with
 * SIGTSTP and printing "run `fg`". A pane runs the agent directly, as the leader
 * of a session of its own, so no shell is there to bring it back — and the
 * kernel drops a stop signal sent to a process group like that. The agent is
 * left running with the terminal handed back, waiting for a SIGCONT that never
 * comes. A shell pane keeps the key: the shell does job control there. Windows
 * has no SIGTSTP, and the agents do not suspend on it.
 */
export function isAgentSuspendChord(
  event: KeyChord,
  agent: string | null | undefined,
  windows: boolean,
): boolean {
  if (windows || !agent || !SUSPENDING_AGENTS.has(agent)) return false
  return event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'z'
}
