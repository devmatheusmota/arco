import { createRequire } from 'node:module'
import { join } from 'node:path'

import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { modePreamble, trimScrollback } = require(
  join(process.cwd(), 'electron', 'terminal-modes.cjs'),
) as {
  modePreamble: (text: string) => string
  trimScrollback: (scrollback: string, cap: number) => string
}

const ESC = '\x1b'

/** What an agent like Claude Code prints once, when it starts. */
const AGENT_STARTUP = `${ESC}[?1049h${ESC}[?2004h${ESC}[?1000h${ESC}[?1006h${ESC}[?25l`

describe('modePreamble', () => {
  it('keeps the last state of every DEC private mode, in the order it last changed', () => {
    const text = `${ESC}[?2004h${ESC}[?25lhello${ESC}[?25h\n${ESC}[?1000;1006h${ESC}[?2004l${ESC}[?2004h`
    expect(modePreamble(text)).toBe(`${ESC}[?25h${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h`)
  })

  it('drops synchronized output, which only brackets one frame', () => {
    expect(modePreamble(`${ESC}[?2026h frame ${ESC}[?2026l`)).toBe('')
  })

  it('is empty for text that switches no mode', () => {
    expect(modePreamble('plain output\n')).toBe('')
    expect(modePreamble('')).toBe('')
  })
})

describe('trimScrollback', () => {
  it('leaves a record under the cap untouched', () => {
    expect(trimScrollback('short\n', 100)).toBe('short\n')
  })

  it('cuts on a line boundary and carries the modes of the cut part to the front', () => {
    const scrollback = `${AGENT_STARTUP}banner\n${'x'.repeat(40)}\nlast line\n`
    const trimmed = trimScrollback(scrollback, 20)
    expect(trimmed.endsWith('last line\n')).toBe(true)
    expect(trimmed).not.toContain('banner')
    expect(trimmed.startsWith(modePreamble(AGENT_STARTUP))).toBe(true)
  })

  it('carries the preamble through cut after cut, as a long session keeps trimming', () => {
    let scrollback = `${AGENT_STARTUP}\n`
    for (let index = 0; index < 200; index += 1) {
      scrollback = trimScrollback(`${scrollback}line ${index} ${'y'.repeat(30)}\n`, 256)
    }
    expect(scrollback.length).toBeLessThan(400)
    expect(scrollback).toContain(`${ESC}[?2004h`)
    expect(scrollback).toContain(`${ESC}[?1049h`)
  })

  it('lets a later switch in the kept part win over the preamble', () => {
    const scrollback = `${ESC}[?2004h${'z'.repeat(50)}\nkept ${ESC}[?2004l\n`
    const trimmed = trimScrollback(scrollback, 20)
    expect(trimmed.indexOf(`${ESC}[?2004h`)).toBeLessThan(trimmed.indexOf(`${ESC}[?2004l`))
  })
})

describe('a pane rebuilt from a trimmed record', () => {
  const replay = async (data: string) => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    await new Promise<void>((resolve) => terminal.write(data, resolve))
    return terminal
  }

  it('comes back with bracketed paste and the alternate screen the agent switched on', async () => {
    let scrollback = AGENT_STARTUP
    for (let index = 0; index < 2_000; index += 1) {
      scrollback = trimScrollback(`${scrollback}frame ${index}\n`, 4 * 1024)
    }
    const terminal = await replay(scrollback)
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.modes.mouseTrackingMode).not.toBe('none')
    terminal.dispose()
  })

  it('used to lose them when the head was simply dropped', async () => {
    let scrollback = AGENT_STARTUP
    for (let index = 0; index < 2_000; index += 1) {
      scrollback = `${scrollback}frame ${index}\n`
    }
    const terminal = await replay(scrollback.slice(-4 * 1024))
    expect(terminal.modes.bracketedPasteMode).toBe(false)
    terminal.dispose()
  })
})
