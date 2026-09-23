// Meeting transcription, as seen by the window.
//
// The capture belongs to `meetscribe`, a separate binary that records what comes
// OUT of this machine (Teams, Meet, whatever is playing) alongside the
// microphone and transcribes both. Arco does not record anything of its own: it
// presses the button and reads the state back, so the transcript keeps being
// written even while the app is closed, and two things never fight over the
// microphone.
//
// `meetscribe` is the owner of the truth. Mirroring its state here would mean
// two answers to "am I recording", and the wrong one would be the one on screen.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const BIN = process.env.MEETSCRIBE_BIN || path.join(os.homedir(), '.local', 'bin', 'meetscribe')

/** Transcribing a meeting is minutes of audio; stopping drains the model queue. */
const TIMEOUT_MS = 180_000

function run(args) {
  return new Promise((resolve) => {
    execFile(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, so, se) => {
      resolve({
        code: error?.code ?? 0,
        stdout: so ?? '',
        stderr: se ?? '',
        failed: Boolean(error),
      })
    })
  })
}

/**
 * What `meetscribe status` says, in the terms the button needs.
 *
 * The output is meant for a person, so it is matched rather than parsed. A line
 * that stops matching costs a wrong label on the button, never a lost recording:
 * the capture is `meetscribe`'s either way.
 */
function readStatus(text) {
  const recording = /^rodando ->/m.test(text)
  const file = /rodando -> (.+)$/m.exec(text)?.[1]?.trim() ?? null
  const pendingMatch =
    /blocos (?:na fila|não transcritos): (\d+)/.exec(text) ?? /parado com sobra: (\d+)/.exec(text)
  const pending = Number(pendingMatch?.[1] ?? 0)
  const warning =
    /atenção: ([^\n]+)/.exec(text)?.[1] ??
    (/parado com sobra/.test(text) ? 'sobrou áudio não transcrito da última captura' : null)
  return {
    recording,
    file,
    pending: Number.isFinite(pending) ? pending : 0,
    ...(warning ? { warning } : {}),
  }
}

/** The last line worth showing when the binary refuses; the rest is noise. */
function reason(res) {
  const text = (res.stderr || res.stdout).trim()
  return text.split('\n').filter(Boolean).pop()?.slice(0, 300) || 'meetscribe não explicou o motivo'
}

function buildMeetingCommands() {
  const available = () => {
    try {
      fs.accessSync(BIN, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  const status = async () => {
    if (!available()) return { available: false, recording: false, file: null, pending: 0 }
    const res = await run(['status'])
    return { available: true, ...readStatus(`${res.stdout}${res.stderr}`) }
  }

  return {
    meeting_status: status,

    /** Captures the system output and, unless asked otherwise, the microphone. */
    meeting_start: async (args) => {
      if (!available()) throw new Error('meetscribe não está instalado nesta máquina')
      const withMic = args?.mic !== false
      const res = await run(['start', ...(withMic ? ['--mic'] : [])])
      if (res.failed) throw new Error(`meetscribe start falhou: ${reason(res)}`)
      return status()
    },

    /** Stops the capture, waits for the model queue to drain, names the file. */
    meeting_stop: async () => {
      if (!available()) throw new Error('meetscribe não está instalado nesta máquina')
      const res = await run(['stop'])
      if (res.failed) throw new Error(`meetscribe stop falhou: ${reason(res)}`)
      const file = /transcript: (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null
      return { file }
    },
  }
}

module.exports = { buildMeetingCommands, readStatus }
