// Terminal modes a recorded scrollback must not lose when its head is cut.
//
// An agent switches its terminal modes once, when it starts: bracketed paste
// (?2004), the alternate screen (?1049), mouse reporting (?1000, ?1002, ?1006),
// focus events (?1004). The host keeps only the tail of a session's output, so
// in a long session those switches fall off the front, and `/clear` empties the
// record outright. A pane rebuilt from that record (a reload, a resync after
// it was hidden, a tab coming back) then starts in the default modes while the
// agent still runs in its own. Without bracketed paste, a pasted screenshot
// path reaches Claude as typing and never turns into an image.
//
// So whatever is cut leaves its modes behind: the final state of every DEC
// private mode the cut part set becomes a preamble at the head of what is left,
// and the next cut carries that preamble forward the same way.

// Synchronized output brackets a single frame. Replaying the start of one would
// hold the screen until an end that already went by.
const TRANSIENT_MODES = new Set(['2026'])

// eslint-disable-next-line no-control-regex
const DEC_MODE = /\x1b\[\?([0-9;]+)([hl])/g

/** The DEC private modes `text` leaves set or reset, as `\x1b[?Nh` / `\x1b[?Nl`, in the order they last changed. */
function modePreamble(text) {
  if (!text || !text.includes('\x1b[?')) return ''
  const state = new Map()
  DEC_MODE.lastIndex = 0
  let match
  while ((match = DEC_MODE.exec(text))) {
    for (const mode of match[1].split(';')) {
      if (!mode || TRANSIENT_MODES.has(mode)) continue
      // Re-inserting moves the mode to the end, so the preamble replays the
      // switches in the order they last happened.
      state.delete(mode)
      state.set(mode, match[2])
    }
  }
  let preamble = ''
  for (const [mode, action] of state) preamble += `\x1b[?${mode}${action}`
  return preamble
}

/**
 * `scrollback` cut to about `cap` characters, keeping the modes of what was cut.
 *
 * The cut lands on a line boundary: escape sequences never span a newline, so
 * this is the only trim that cannot leave a half-written CSI at the front of a
 * replay, where it would swallow the bytes that follow it.
 */
function trimScrollback(scrollback, cap) {
  if (scrollback.length <= cap) return scrollback
  const excess = scrollback.length - cap
  const boundary = scrollback.indexOf('\n', excess)
  const cut = boundary >= 0 ? boundary + 1 : excess
  return modePreamble(scrollback.slice(0, cut)) + scrollback.slice(cut)
}

module.exports = { modePreamble, trimScrollback }
