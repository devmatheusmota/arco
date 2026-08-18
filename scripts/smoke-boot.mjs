#!/usr/bin/env node
/**
 * Boot smoke test — starts the real app and waits for it to prove it is alive.
 *
 * Nothing else in CI runs the Electron main process: lint, vitest and
 * `tsc && vite build` all pass with it fatally broken, because none of them
 * load it. v2.0.1 shipped that way — a missing `require` threw while the hook
 * listener module loaded, the app died before creating a window, and the whole
 * suite was green.
 *
 * Three signals, in order of what they prove:
 *   1. `arco-agent-hooks.json`  — the main process reached the listener bind
 *   2. `projects.hydrate`       — the window loaded and the frontend invoked back
 *   3. `POST /cli/todo/list`    — the surface the `arco` command talks to answers
 *
 * Run under a display: `xvfb-run -a node scripts/smoke-boot.mjs`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000)
const POLL_MS = 500

// Chromium's singleton socket lives under TMPDIR and its path has a hard length
// limit, so the sandbox root stays short on purpose.
const root = mkdtempSync(path.join(tmpdir(), 'arco-smoke-'))
const dirs = {
  tmp: path.join(root, 't'),
  data: path.join(root, 'd'),
  config: path.join(root, 'c'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

const hooksFile = path.join(dirs.tmp, 'arco-agent-hooks.json')
const eventsLog = path.join(dirs.data, 'com.mota.arco', 'logs', 'app-events.log')

let output = ''
const child = spawn(
  process.env.ELECTRON_BIN ?? path.join('node_modules', '.bin', 'electron'),
  ['electron/main.cjs', '--no-sandbox', '--disable-gpu-sandbox'],
  {
    env: {
      ...process.env,
      TMPDIR: dirs.tmp,
      XDG_DATA_HOME: dirs.data,
      XDG_CONFIG_HOME: dirs.config,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
child.stdout.on('data', (chunk) => (output += chunk))
child.stderr.on('data', (chunk) => (output += chunk))

let exited = null
child.on('exit', (code, signal) => (exited = signal ? `signal ${signal}` : `code ${code}`))

const FATAL = ['A JavaScript error occurred in the main process', 'Uncaught Exception']

function fail(reason) {
  console.error(`\n✗ boot smoke: ${reason}\n`)
  const noise = /vulkan|ozone|libva|GPU stall|dbus|Failed to connect to the bus/i
  const lines = output
    .split('\n')
    .filter((line) => line.trim() && !noise.test(line))
    .slice(-25)
  if (lines.length) console.error(lines.join('\n'))
  cleanup()
  process.exit(1)
}

function cleanup() {
  try {
    child.kill('SIGKILL')
  } catch {}
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}

function fileHas(file, needle) {
  try {
    return readFileSync(file, 'utf8').includes(needle)
  } catch {
    return false
  }
}

/** Asks the listener the same way the `arco` shim does, reusing its own settings file. */
async function cliAnswers() {
  const settings = JSON.parse(readFileSync(hooksFile, 'utf8'))
  const entry = settings.hooks?.SubagentStart?.[0]?.hooks?.[0]
  if (!entry?.url) throw new Error('settings file carries no endpoint')
  const base = entry.url.replace(/\/hook$/, '')
  const response = await fetch(`${base}/cli/todo/list`, {
    method: 'POST',
    headers: { 'X-Arco-Token': entry.headers['X-Arco-Token'] },
    body: '{}',
  })
  if (!response.ok) throw new Error(`/cli/todo/list answered ${response.status}`)
  if (!Array.isArray(await response.json())) throw new Error('/cli/todo/list did not return a list')
}

const started = Date.now()
const step = (label) => console.log(`  ✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`)

console.log('boot smoke: starting the app…')
while (Date.now() - started < TIMEOUT_MS) {
  const fatal = FATAL.find((needle) => output.includes(needle))
  if (fatal) fail(`the main process threw while loading (${fatal})`)
  if (exited) fail(`the app exited before it was ready (${exited})`)

  if (existsSync(hooksFile) && fileHas(eventsLog, 'projects.hydrate')) {
    step('main process is up (hook listener bound)')
    step('window loaded and the frontend called back (projects.hydrate)')
    try {
      await cliAnswers()
    } catch (error) {
      fail(`the CLI surface is broken: ${error.message}`)
    }
    step('the `arco` command surface answers (/cli/todo/list)')
    console.log('\n✓ boot smoke passed\n')
    cleanup()
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
}

fail(
  `timed out after ${TIMEOUT_MS / 1000}s waiting for the app to boot ` +
    `(hooks file: ${existsSync(hooksFile)}, hydrate: ${fileHas(eventsLog, 'projects.hydrate')})`,
)
