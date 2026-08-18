// Speech host: microphone capture and on-device recognition.
//
// Runs under the system Node because sherpa-onnx is a native binding built for
// Node's ABI, and because loading a 600 MB encoder has no business inside the
// window's process. Speaks newline-delimited JSON on stdio, same shape as the
// PTY host. The model is the one the Tauri build already downloaded — nothing
// is fetched, and no audio leaves the machine.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const SAMPLE_RATE = 16000

const MODEL_FILES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt',
}

/** Same search order as the Rust build: env override, Arco, then Orca. */
function modelSearchPaths(id) {
  const dirs = []
  if (process.env.ARCO_SPEECH_MODEL_DIR) dirs.push(process.env.ARCO_SPEECH_MODEL_DIR)
  const config =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config')
  dirs.push(path.join(config, 'arco', 'speech-models', id))
  dirs.push(path.join(config, 'orca', 'speech-models', id))
  return dirs
}

function locateModel(id) {
  for (const dir of modelSearchPaths(id)) {
    const files = Object.fromEntries(
      Object.entries(MODEL_FILES).map(([key, name]) => [key, path.join(dir, name)]),
    )
    if (Object.values(files).every((file) => fs.existsSync(file))) return { dir, files }
  }
  return null
}

let recognizer = null
let recognizerModelId = null

function loadRecognizer(id) {
  if (recognizer && recognizerModelId === id) return recognizer
  const model = locateModel(id)
  if (!model) throw new Error('speech_model_not_found')
  const sherpa = require('sherpa-onnx-node')
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: model.files.encoder,
        decoder: model.files.decoder,
        joiner: model.files.joiner,
      },
      tokens: model.files.tokens,
      numThreads: Math.max(1, Math.min(4, os.cpus().length - 2)),
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: false,
    },
    decodingMethod: 'greedy_search',
  })
  recognizerModelId = id
  return recognizer
}

// ── capture ───────────────────────────────────────────────────────────────

const CAPTURE_TOOLS = [
  ['arecord', ['-q', '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', '1', '-t', 'raw']],
  ['pw-record', ['--format=s16', `--rate=${SAMPLE_RATE}`, '--channels=1', '--target=0', '-']],
  ['parec', ['--format=s16le', `--rate=${SAMPLE_RATE}`, '--channels=1']],
]

function captureCommand() {
  for (const [command, args] of CAPTURE_TOOLS) {
    try {
      execFileSync('/bin/sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' })
      return [command, args]
    } catch {}
  }
  return null
}

let capture = null

function startCapture() {
  if (capture) return
  const resolved = captureCommand()
  if (!resolved) throw new Error('no_audio_capture_tool')
  const [command, args] = resolved
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.on('error', (error) => {
    process.stderr.write(`[speech] ${command} failed to start: ${error.message}\n`)
  })
  capture = { child, chunks }
}

function stopCapture() {
  if (!capture) return null
  const { child, chunks } = capture
  capture = null
  try {
    child.kill('SIGINT')
  } catch {}
  return Buffer.concat(chunks)
}

/** sherpa wants mono float samples in [-1, 1]; capture gives signed 16-bit. */
function toFloatSamples(buffer) {
  const samples = new Float32Array(Math.floor(buffer.length / 2))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32768
  }
  return samples
}

function transcribe(id, buffer) {
  // Under a third of a second is a mistap, not speech.
  if (!buffer || buffer.length < SAMPLE_RATE * 0.6) return ''
  const engine = loadRecognizer(id)
  const stream = engine.createStream()
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: toFloatSamples(buffer) })
  engine.decode(stream)
  return (engine.getResult(stream)?.text ?? '').trim()
}

const handlers = {
  status: ({ model }) => ({
    modelFound: Boolean(locateModel(model)),
    modelLoaded: Boolean(recognizer) && recognizerModelId === model,
    captureAvailable: Boolean(captureCommand()),
  }),
  preload: ({ model }) => {
    loadRecognizer(model)
    return true
  },
  start: () => {
    startCapture()
    return true
  },
  stop: ({ model }) => {
    const buffer = stopCapture()
    const seconds = buffer ? buffer.length / 2 / SAMPLE_RATE : 0
    return { text: transcribe(model, buffer), seconds: Number(seconds.toFixed(2)) }
  },
  cancel: () => {
    stopCapture()
    return true
  },
}

let stdinBuffer = ''
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString()
  let index = stdinBuffer.indexOf('\n')
  while (index !== -1) {
    const line = stdinBuffer.slice(0, index)
    stdinBuffer = stdinBuffer.slice(index + 1)
    index = stdinBuffer.indexOf('\n')
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    const handler = handlers[request.cmd]
    try {
      const result = handler ? handler(request.args ?? {}) : null
      process.stdout.write(`${JSON.stringify({ requestId: request.requestId, result })}\n`)
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ requestId: request.requestId, error: String(error.message ?? error) })}\n`,
      )
    }
  }
})
