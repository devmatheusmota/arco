// The recorded output of one terminal, kept to about `cap` characters.
//
// Output arrives in small chunks, many per second while an agent redraws its
// screen. Trimming on every chunk meant concatenating the whole record (half a
// megabyte once full) and slicing it again, so each chunk paid for the entire
// scrollback on the same event loop that writes keystrokes to the terminals.
// Chunks are appended as they come and the record is cut only once it runs a
// quarter past the cap, which spreads the cost of one cut over that quarter.
//
// The cut itself is `trimScrollback`, unchanged: on a line boundary, carrying the
// terminal modes of what was dropped.

const { trimScrollback } = require('./terminal-modes.cjs')

class ScrollbackBuffer {
  constructor(cap, initial = '') {
    this.cap = cap
    this.slack = Math.floor(cap / 4)
    this.chunks = initial ? [initial] : []
    this.length = initial.length
  }

  append(data) {
    if (!data) return
    this.chunks.push(data)
    this.length += data.length
    if (this.length > this.cap + this.slack) this.compact()
  }

  /** The record as one string of at most `cap` characters; also what is kept from now on. */
  text() {
    if (this.chunks.length === 1 && this.length <= this.cap) return this.chunks[0]
    return this.compact()
  }

  /** Replaces the record. */
  reset(text = '') {
    this.chunks = text ? [text] : []
    this.length = text.length
  }

  compact() {
    const text = trimScrollback(this.chunks.join(''), this.cap)
    this.reset(text)
    return text
  }
}

module.exports = { ScrollbackBuffer }
