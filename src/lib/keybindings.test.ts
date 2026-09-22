import { afterEach, describe, expect, it } from 'vitest'

import {
  isAppChordInTerminal,
  type KeyChord,
  keyFocusOf,
  registerTaskComposer,
  resolveAppShortcut,
} from './keybindings'

const chord = (key: string, init: Partial<KeyChord> = {}): KeyChord => ({
  key,
  code: init.code ?? defaultCode(key),
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
})

function defaultCode(key: string): string {
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  return key
}

const ctrl = (key: string, init: Partial<KeyChord> = {}) => chord(key, { ctrlKey: true, ...init })

const inTerminal = { focus: 'terminal', taskComposer: false } as const
const outside = { focus: 'none', taskComposer: false } as const
const inField = { focus: 'field', taskComposer: false } as const

describe('resolveAppShortcut — fronts', () => {
  it('maps Ctrl+1…Ctrl+9 to the front in that position and Ctrl+0 to the last', () => {
    for (let digit = 1; digit <= 9; digit += 1) {
      expect(resolveAppShortcut(ctrl(String(digit)), inTerminal)).toEqual({
        type: 'openFront',
        slot: digit,
      })
    }
    expect(resolveAppShortcut(ctrl('0'), inTerminal)).toEqual({ type: 'openFront', slot: 0 })
  })

  it('reads the physical digit key, so layouts that type symbols on it still switch', () => {
    // AZERTY: the unshifted top-row 1 types "&".
    expect(resolveAppShortcut(ctrl('&', { code: 'Digit1' }), outside)).toEqual({
      type: 'openFront',
      slot: 1,
    })
  })

  it('takes numpad digits only with Num Lock on, and leaves numpad 0 to the zoom', () => {
    expect(resolveAppShortcut(ctrl('3', { code: 'Numpad3' }), outside)).toEqual({
      type: 'openFront',
      slot: 3,
    })
    // Num Lock off: numpad 1 is End, so the chord is Ctrl+End.
    expect(resolveAppShortcut(ctrl('End', { code: 'Numpad1' }), inTerminal)).toBeNull()
    expect(resolveAppShortcut(ctrl('0', { code: 'Numpad0' }), outside)).toEqual({
      type: 'zoomReset',
    })
  })

  it('leaves Ctrl+Shift+digit and Ctrl+Alt+digit alone', () => {
    expect(resolveAppShortcut(ctrl('!', { code: 'Digit1', shiftKey: true }), outside)).toBeNull()
    expect(resolveAppShortcut(ctrl('2', { altKey: true }), inTerminal)).toBeNull()
  })
})

describe('resolveAppShortcut — panes', () => {
  it('moves by direction with Alt+Shift+arrows, from a terminal or from the app', () => {
    const cases = [
      ['ArrowLeft', 'left'],
      ['ArrowRight', 'right'],
      ['ArrowUp', 'up'],
      ['ArrowDown', 'down'],
    ] as const
    for (const [key, direction] of cases) {
      const event = chord(key, { altKey: true, shiftKey: true })
      expect(resolveAppShortcut(event, inTerminal)).toEqual({ type: 'focusPane', direction })
      expect(resolveAppShortcut(event, outside)).toEqual({ type: 'focusPane', direction })
    }
  })

  it('leaves Alt+Shift+arrows to a text field, where they select by word on macOS', () => {
    expect(
      resolveAppShortcut(chord('ArrowLeft', { altKey: true, shiftKey: true }), inField),
    ).toBeNull()
  })

  it('cycles the panes on screen with Ctrl+PageUp/PageDown, and Shift+Tab outside a terminal', () => {
    expect(resolveAppShortcut(ctrl('PageDown'), inTerminal)).toEqual({ type: 'cyclePane', step: 1 })
    expect(resolveAppShortcut(ctrl('PageUp'), inTerminal)).toEqual({ type: 'cyclePane', step: -1 })
    expect(resolveAppShortcut(chord('Tab', { shiftKey: true }), outside)).toEqual({
      type: 'cyclePane',
      step: 1,
    })
    expect(resolveAppShortcut(chord('Tab', { shiftKey: true }), inTerminal)).toBeNull()
  })
})

describe('resolveAppShortcut — the rest of the table', () => {
  it('keeps every existing chord', () => {
    expect(resolveAppShortcut(ctrl('b'), inTerminal)).toEqual({ type: 'toggleLeftSidebar' })
    expect(resolveAppShortcut(ctrl('t'), inTerminal)).toEqual({ type: 'newTerminal' })
    expect(resolveAppShortcut(ctrl('t', { altKey: true }), inTerminal)).toEqual({
      type: 'repeatTerminal',
    })
    expect(resolveAppShortcut(ctrl('T', { shiftKey: true }), inTerminal)).toEqual({
      type: 'reopenClosedTab',
    })
    expect(resolveAppShortcut(ctrl('A', { shiftKey: true }), inTerminal)).toEqual({
      type: 'addContent',
    })
    expect(resolveAppShortcut(ctrl('w'), inTerminal)).toEqual({ type: 'closePane' })
    expect(resolveAppShortcut(ctrl('p'), inTerminal)).toEqual({ type: 'findJump' })
    expect(resolveAppShortcut(ctrl('P', { shiftKey: true }), inTerminal)).toEqual({
      type: 'newProject',
    })
    expect(resolveAppShortcut(ctrl('H', { shiftKey: true }), inTerminal)).toEqual({
      type: 'toggleHome',
    })
    expect(resolveAppShortcut(ctrl('Tab'), inTerminal)).toEqual({
      type: 'cycleProjectTab',
      step: 1,
    })
    expect(resolveAppShortcut(ctrl('Tab', { shiftKey: true }), inTerminal)).toEqual({
      type: 'cycleProjectTab',
      step: -1,
    })
    expect(resolveAppShortcut(ctrl('='), inTerminal)).toEqual({ type: 'zoom', step: 1 })
    expect(resolveAppShortcut(ctrl('-'), inTerminal)).toEqual({ type: 'zoom', step: -1 })
    expect(resolveAppShortcut(chord('ArrowLeft', { altKey: true }), outside)).toEqual({
      type: 'history',
      step: -1,
    })
    expect(resolveAppShortcut(chord('r'), outside)).toEqual({ type: 'restartTerminal' })
  })

  it('reads Cmd as Ctrl', () => {
    expect(resolveAppShortcut(chord('3', { metaKey: true }), outside)).toEqual({
      type: 'openFront',
      slot: 3,
    })
  })

  it('never fires a Ctrl+letter shortcut under AltGr, which Windows reports as Ctrl+Alt', () => {
    // ABNT2 types "?" with AltGr+W.
    expect(resolveAppShortcut(ctrl('?', { code: 'KeyW', altKey: true }), inTerminal)).toBeNull()
    expect(resolveAppShortcut(ctrl('w', { altKey: true }), inTerminal)).toBeNull()
    expect(resolveAppShortcut(ctrl('p', { altKey: true }), inTerminal)).toBeNull()
  })

  it('claims Ctrl+N only while a task composer is mounted to take it', () => {
    expect(resolveAppShortcut(ctrl('n'), inTerminal)).toBeNull()
    expect(resolveAppShortcut(ctrl('n'), { focus: 'terminal', taskComposer: true })).toEqual({
      type: 'focusTaskComposer',
    })
  })
})

describe('isAppChordInTerminal — what the process under the cursor receives', () => {
  let unregister: (() => void) | null = null
  afterEach(() => {
    unregister?.()
    unregister = null
  })

  it('hands the process every key a shell, an editor or an agent needs', () => {
    const forTheProcess = [
      ctrl('l'), // clear screen
      ctrl('c'),
      ctrl('d'),
      ctrl('r'),
      ctrl('u'),
      ctrl('a'),
      ctrl('e'),
      ctrl('k'),
      ctrl('o'),
      ctrl('z'),
      ctrl('n'),
      ctrl('ArrowLeft'),
      ctrl('ArrowRight'),
      chord('ArrowLeft', { altKey: true }),
      chord('ArrowRight', { altKey: true }),
      chord('ArrowUp', { altKey: true }),
      chord('b', { altKey: true }),
      chord('f', { altKey: true }),
      chord('Tab', { shiftKey: true }),
      chord('Escape'),
      chord('r'),
      chord('R', { shiftKey: true }),
      chord('ArrowLeft', { shiftKey: true }),
      ctrl('ArrowLeft', { shiftKey: true }),
      ctrl('!', { code: 'Digit1', shiftKey: true }),
    ]
    for (const event of forTheProcess) {
      expect(isAppChordInTerminal(event), `${JSON.stringify(event)}`).toBe(false)
    }
  })

  it('keeps from the process the chords the app acts on, so none arrives twice', () => {
    const forTheApp = [
      ctrl('3'), // xterm would send ESC, interrupting Claude
      ctrl('8'), // xterm would send DEL
      ctrl('0'),
      ctrl('Tab'), // xterm would send TAB
      ctrl('PageDown'),
      ctrl('t'),
      ctrl('w'),
      ctrl('p'),
      ctrl('b'),
      ctrl('='),
      chord('ArrowRight', { altKey: true, shiftKey: true }),
    ]
    for (const event of forTheApp) {
      expect(isAppChordInTerminal(event), `${JSON.stringify(event)}`).toBe(true)
    }
  })

  it('gives Ctrl+N to the task composer only while one is mounted', () => {
    expect(isAppChordInTerminal(ctrl('n'))).toBe(false)
    unregister = registerTaskComposer()
    expect(isAppChordInTerminal(ctrl('n'))).toBe(true)
    unregister()
    unregister = null
    expect(isAppChordInTerminal(ctrl('n'))).toBe(false)
  })
})

describe('keyFocusOf', () => {
  it('tells a terminal from a text field from the rest of the app', () => {
    const terminal = document.createElement('textarea')
    terminal.className = 'xterm-helper-textarea'
    expect(keyFocusOf(terminal)).toBe('terminal')
    expect(keyFocusOf(document.createElement('input'))).toBe('field')
    expect(keyFocusOf(document.createElement('textarea'))).toBe('field')
    expect(keyFocusOf(document.createElement('div'))).toBe('none')
    expect(keyFocusOf(null)).toBe('none')
  })
})
