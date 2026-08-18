/**
 * Keyboard shortcuts stored as a normalized string, e.g. `ctrl+shift+e`.
 *
 * Modifiers always come in the same order so two spellings of the same chord
 * compare equal, and the key is lowercased. `meta` and `ctrl` are folded into one
 * token: the app treats Cmd and Ctrl as the same modifier everywhere else.
 */

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift'] as const

/** Keys that only make sense as the chord's modifier, never as its main key. */
const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'os', 'hyper', 'super'])

export type ShortcutParts = {
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export function parseShortcut(raw: string | undefined, fallback = 'ctrl+e'): ShortcutParts {
  const source = (raw?.trim() || fallback).toLowerCase()
  const tokens = source
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
  const parts: ShortcutParts = { ctrl: false, alt: false, shift: false, key: '' }
  for (const token of tokens) {
    if (token === 'ctrl' || token === 'meta' || token === 'cmd') parts.ctrl = true
    else if (token === 'alt' || token === 'option') parts.alt = true
    else if (token === 'shift') parts.shift = true
    else parts.key = token
  }
  if (!parts.key) return parseShortcut(fallback, 'ctrl+e')
  return parts
}

export function formatShortcut(parts: ShortcutParts): string {
  const tokens = MODIFIER_ORDER.filter((name) => parts[name])
  return [...tokens, parts.key].join('+')
}

/** Human-facing label: `Ctrl+Shift+E`. */
export function shortcutLabel(raw: string | undefined): string {
  const parts = parseShortcut(raw)
  const tokens = MODIFIER_ORDER.filter((name) => parts[name]).map(
    (name) => name.charAt(0).toUpperCase() + name.slice(1),
  )
  const key = parts.key.length === 1 ? parts.key.toUpperCase() : parts.key
  return [...tokens, key].join('+')
}

/**
 * Reads a chord from a keydown. Returns null while only modifiers are held, so a
 * capture field can wait for the actual key instead of recording `ctrl+control`.
 */
export function shortcutFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase()
  if (MODIFIER_KEYS.has(key)) return null
  return formatShortcut({
    ctrl: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    key: key === ' ' ? 'space' : key,
  })
}

/** Whether a keydown matches the configured chord. */
export function matchesShortcut(event: KeyboardEvent, raw: string | undefined): boolean {
  const wanted = parseShortcut(raw)
  const key = event.key.toLowerCase()
  const normalized = key === ' ' ? 'space' : key
  return (
    normalized === wanted.key &&
    (event.ctrlKey || event.metaKey) === wanted.ctrl &&
    event.altKey === wanted.alt &&
    event.shiftKey === wanted.shift
  )
}

/**
 * Whether a keyup ends the chord. Releasing the modifier first reports the main
 * key with the modifier flag already false, so hold-to-talk has to accept either
 * half — matching only the full chord would strand the microphone open.
 */
export function releasesShortcut(event: KeyboardEvent, raw: string | undefined): boolean {
  const wanted = parseShortcut(raw)
  const key = event.key.toLowerCase()
  const normalized = key === ' ' ? 'space' : key
  if (normalized === wanted.key) return true
  if (wanted.ctrl && (key === 'control' || key === 'meta')) return true
  if (wanted.alt && key === 'alt') return true
  if (wanted.shift && key === 'shift') return true
  return false
}
