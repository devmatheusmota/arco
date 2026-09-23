import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { readStatus } = require('../../electron/commands/meeting.cjs') as {
  readStatus: (text: string) => {
    recording: boolean
    file: string | null
    pending: number
    warning?: string
  }
}

// `meetscribe status` prints for a person, so it is matched rather than parsed.
// These are the shapes it actually prints; a line that stops matching costs a
// wrong label on the button, never a lost recording.
describe('readStatus', () => {
  it('reads a capture in progress, with the file being written', () => {
    const state = readStatus('rodando -> /home/mota/transcricoes/2026-09-23-1030.md\n')

    expect(state.recording).toBe(true)
    expect(state.file).toBe('/home/mota/transcricoes/2026-09-23-1030.md')
    expect(state.warning).toBeUndefined()
  })

  it('reads a stopped capture', () => {
    const state = readStatus('parado\n')

    expect(state).toMatchObject({ recording: false, file: null, pending: 0 })
  })

  it('counts the blocks still queued in the model', () => {
    expect(readStatus('rodando -> /tmp/a.md\nblocos na fila: 4\n').pending).toBe(4)
    expect(readStatus('blocos não transcritos: 7\n').pending).toBe(7)
  })

  // Audio left behind means part of the meeting was never written down, which is
  // exactly the thing someone would otherwise find out days later.
  it('turns leftover audio into a warning, and counts it', () => {
    const state = readStatus('parado com sobra: 12\n')

    expect(state.recording).toBe(false)
    expect(state.pending).toBe(12)
    expect(state.warning).toMatch(/sobrou áudio/)
  })

  it('carries a warning meetscribe raised on its own', () => {
    const state = readStatus('rodando -> /tmp/a.md\natenção: a captura caiu por 3s\n')

    expect(state.warning).toBe('a captura caiu por 3s')
  })

  it('answers something usable for output it does not recognise', () => {
    expect(readStatus('')).toMatchObject({ recording: false, file: null, pending: 0 })
    expect(readStatus('mensagem nova qualquer')).toMatchObject({ recording: false, pending: 0 })
  })
})
