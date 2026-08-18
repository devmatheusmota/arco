/**
 * Picks a monospace family the machine actually has.
 *
 * The stack used to name Windows fonts only ("Cascadia Mono, Consolas"). On a
 * Linux box none of them exist, so every cell fell through to the generic
 * `monospace`, and every glyph the fallback could not cover — the braille
 * spinner, box drawing, Nerd Font icons an agent TUI is full of — went through
 * font fallback, glyph measurement and a fresh texture upload into xterm's
 * atlas. That path (`measureText`, `fillText`, `_drawToCache`, `texImage2D`)
 * dominates a CPU profile of a busy pane.
 *
 * Checking availability up front keeps the terminal on one family that covers
 * what agents draw.
 */

const CANDIDATES = [
  // Windows-first, matching the app's primary platform.
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  // Common developer fonts, and the ones shipped with Nerd Font icon coverage.
  'JetBrainsMono Nerd Font',
  'JetBrains Mono',
  'FiraCode Nerd Font',
  'Fira Code',
  'Hack Nerd Font',
  'SF Mono',
  'Menlo',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Noto Sans Mono',
]

const FALLBACK = 'monospace'

let resolved: string | null = null

function isAvailable(family: string): boolean {
  try {
    return document.fonts?.check(`12px "${family}"`) ?? false
  } catch {
    return false
  }
}

/** The font stack to hand xterm: the first installed candidate, then generics. */
export function resolveTerminalFontFamily(): string {
  if (resolved) return resolved
  const available = CANDIDATES.filter(isAvailable)
  resolved = [...available.slice(0, 2).map((family) => `"${family}"`), FALLBACK].join(', ')
  return resolved
}
