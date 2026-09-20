/**
 * Short, speakable reference for a pane — `pa-3576`.
 *
 * The `nanoid` in `Terminal.id` stays the internal key: it is 21 characters of
 * mixed case, and nobody types or dictates one. This reference exists so a pane
 * can be named in a sentence ("send this to pa-3576") and typed into the CLI
 * without looking anything up.
 */

import { customAlphabet } from 'nanoid'

import type { Project } from './types'

const PANE_REF_PREFIX = 'pa-'

/** Digits are the only alphabet that survives being read out loud. */
const randomDigits = customAlphabet('0123456789')

const BASE_DIGITS = 4

/** How many taken draws it takes before the reference gets one digit wider. */
const COLLISIONS_BEFORE_WIDENING = 20

const PANE_SHORT_ID_PATTERN = /^pa-\d{4,}$/
const DIGITS_ONLY_PATTERN = /^\d{4,}$/

export function isPaneShortId(value: unknown): value is string {
  return typeof value === 'string' && PANE_SHORT_ID_PATTERN.test(value)
}

/**
 * Draws a reference that is not in `taken`.
 *
 * Four digits hold 10k panes, far past what one machine carries, but a
 * saturated set still has to terminate: after enough collisions the draw widens
 * by a digit instead of spinning over a space with no room left.
 */
export function generatePaneShortId(taken: ReadonlySet<string>): string {
  let width = BASE_DIGITS
  let collisions = 0
  for (;;) {
    const candidate = `${PANE_REF_PREFIX}${randomDigits(width)}`
    if (!taken.has(candidate)) return candidate
    collisions += 1
    if (collisions >= COLLISIONS_BEFORE_WIDENING) {
      collisions = 0
      width += 1
    }
  }
}

/** Every well-formed reference already in use, across every project. */
export function collectPaneShortIds(projects: readonly Project[] | undefined): Set<string> {
  const taken = new Set<string>()
  for (const project of projects ?? []) {
    for (const terminal of project?.terminals ?? []) {
      if (isPaneShortId(terminal?.shortId)) taken.add(terminal.shortId)
    }
  }
  return taken
}

/**
 * Canonicalizes what someone typed or dictated into a reference.
 *
 * Accepts `pa-3576`, `PA-3576`, surrounding or internal spaces, and the bare
 * digits — an agent told "pane 3576" should not have to guess the prefix.
 * Returns `null` for anything that is not a reference.
 */
export function normalizePaneRef(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const compact = input.replace(/\s+/g, '').toLowerCase()
  const digits = compact.startsWith(PANE_REF_PREFIX)
    ? compact.slice(PANE_REF_PREFIX.length)
    : compact
  if (!DIGITS_ONLY_PATTERN.test(digits)) return null
  return `${PANE_REF_PREFIX}${digits}`
}
