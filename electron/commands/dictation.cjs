// Dictation, as seen by the window.
//
// The work happens in `speech-host.cjs` under system Node: the recognizer is a
// native binding built for Node's ABI, and the model is large enough that it
// has no business inside the UI process. The host starts on first use and stays
// warm so a hold-to-talk does not pay the load twice.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** Same reasoning as the PTY host: a desktop launch has a different PATH. */
function resolveNodeBinary() {
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'node')),
  ]
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node')
  try {
    candidates.push(
      ...fs
        .readdirSync(nvmRoot)
        .sort()
        .reverse()
        .map((version) => path.join(nvmRoot, version, 'bin', 'node')),
    )
  } catch {}
  candidates.push('/usr/local/bin/node', '/usr/bin/node')
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return 'node'
}

const DEFAULT_MODEL = 'parakeet-tdt-0.6b-v3-int8'

let host = null
let nextRequestId = 1
const pending = new Map()

function ensureHost() {
  if (host) return host
  const hostPath = path
    .join(__dirname, '..', 'speech-host.cjs')
    .replace('app.asar', 'app.asar.unpacked')
  const child = spawn(process.env.ARCO_NODE || resolveNodeBinary(), [hostPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const entry = pending.get(message.requestId)
      pending.delete(message.requestId)
      if (!entry) continue
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.result)
    }
  })
  child.on('exit', () => {
    host = null
    for (const entry of pending.values()) entry.reject(new Error('speech host exited'))
    pending.clear()
  })
  child.on('error', (error) => console.error('[dictation] speech host failed:', error.message))
  host = child
  return child
}

function request(cmd, args = {}) {
  const child = ensureHost()
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++
    pending.set(requestId, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ requestId, cmd, args })}\n`)
  })
}

const CATALOG = require('./speech-catalog.json')

/** Where models live — next to the app's own config, as the Rust side does. */
function modelsRoot() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'arco', 'speech-models')
}

function modelDir(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id ?? '')) throw new Error('invalid_model_id')
  return path.join(modelsRoot(), id)
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** A file counts as present only at its exact expected size. */
function modelState(spec) {
  const dir = modelDir(spec.id)
  let localBytes = 0
  let installed = true
  for (const file of spec.files) {
    const complete = sizeOf(path.join(dir, file.name))
    const partial = sizeOf(path.join(dir, `${file.name}.partial`))
    if (complete === file.sizeBytes) localBytes += complete
    else {
      installed = false
      localBytes += partial
    }
  }
  return { installed, localBytes }
}

async function verifyDigest(file, expected) {
  const hash = require('node:crypto').createHash('sha256')
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  const digest = hash.digest('hex')
  if (digest !== expected) throw new Error(`digest_mismatch:${path.basename(file)}`)
}

/**
 * Downloads one file, resuming a partial from where it stopped and checking the
 * digest before it is renamed into place — a poisoned partial is deleted so the
 * next attempt cannot resume from corrupt bytes.
 */
async function downloadFile(spec, file, send, alreadyDone) {
  const dir = modelDir(spec.id)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, file.name)
  if (sizeOf(target) === file.sizeBytes) return file.sizeBytes
  const partial = `${target}.partial`
  const from = sizeOf(partial)
  const total = spec.files.reduce((sum, entry) => sum + entry.sizeBytes, 0)

  const response = await fetch(file.url, {
    headers: from > 0 ? { Range: `bytes=${from}-` } : {},
  })
  if (!response.ok && response.status !== 206) {
    throw new Error(`download_failed:${response.status}`)
  }
  const resuming = response.status === 206
  const sink = fs.createWriteStream(partial, { flags: resuming ? 'a' : 'w' })
  let written = resuming ? from : 0
  let sinceEmit = 0
  for await (const chunk of response.body) {
    sink.write(chunk)
    written += chunk.length
    sinceEmit += chunk.length
    // Every chunk would flood the renderer; 4 MB still moves a progress bar.
    if (sinceEmit >= 4 * 1024 * 1024) {
      sinceEmit = 0
      send('dictation://download', {
        id: spec.id,
        received: alreadyDone + written,
        total,
        file: file.name,
        done: false,
        error: null,
      })
    }
  }
  await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())))
  try {
    await verifyDigest(partial, file.sha256)
  } catch (error) {
    fs.rmSync(partial, { force: true })
    throw error
  }
  fs.renameSync(partial, target)
  return written
}

function buildDictationCommands(send = () => {}) {
  const model = (args) => ({ model: args?.model || DEFAULT_MODEL })
  return {
    dictation_status: (args) =>
      request('status', model(args)).catch(() => ({
        modelFound: false,
        modelLoaded: false,
        captureAvailable: false,
      })),
    dictation_preload: (args) => request('preload', model(args)).then(() => null),
    dictation_start: () => request('start').then(() => null),
    dictation_stop: async (args) => {
      const result = await request('stop', model(args))
      return result?.text ?? ''
    },
    dictation_cancel: () => request('cancel').then(() => null),

    dictation_models: () =>
      CATALOG.map((spec) => {
        const { installed, localBytes } = modelState(spec)
        return {
          id: spec.id,
          label: spec.label,
          description: spec.description,
          language: spec.language,
          streaming: spec.streaming,
          recommended: spec.recommended,
          sizeBytes: spec.files.reduce((sum, file) => sum + file.sizeBytes, 0),
          installed,
          localBytes,
        }
      }),
    dictation_download: async ({ id }) => {
      const spec = CATALOG.find((entry) => entry.id === id)
      if (!spec) throw new Error('unknown_model')
      const total = spec.files.reduce((sum, file) => sum + file.sizeBytes, 0)
      let done = 0
      try {
        for (const file of spec.files) {
          done += await downloadFile(spec, file, send, done)
        }
      } catch (error) {
        send('dictation://download', {
          id,
          received: done,
          total,
          file: '',
          done: true,
          error: String(error.message ?? error),
        })
        throw error
      }
      send('dictation://download', { id, received: total, total, file: '', done: true, error: null })
      return null
    },
    dictation_delete: ({ id }) => {
      fs.rmSync(modelDir(id), { recursive: true, force: true })
      return null
    },
  }
}

module.exports = { buildDictationCommands }
