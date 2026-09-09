import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The CLI answers `arco todo` from the binary itself, printing straight to the
 * file descriptor. A single write stops at the pipe buffer, so `2>&1` used to
 * cut a large listing at 64 KB and still exit 0. The test drives the real
 * entry point — the one the app re-executes — against a stand-in for the app.
 */

// Vitest runs from the repository root, where `electron/` lives.
const CLI_ENTRY = resolve(process.cwd(), 'electron/cli-entry.cjs')

// Comfortably past the 64 KB a pipe holds, so a truncated write is unambiguous.
const todos = Array.from({ length: 400 }, (_, index) => ({
  id: `id-${index}`,
  title: `tarefa ${index} ${'x'.repeat(300)}`,
  status: 'todo',
  tags: ['arco'],
  priority: 'normal',
}))
const expected = `${JSON.stringify(todos)}\n`

let server: Server
let dir: string
let settingsFile: string

/** Runs the CLI with both descriptors on one pipe, the way `$(... 2>&1)` does. */
function runCli(): Promise<{ output: string; code: number | null }> {
  return new Promise((done, fail) => {
    const child = spawn(
      'sh',
      ['-c', `exec "$0" "$1" todo list --json 2>&1`, process.execPath, CLI_ENTRY],
      { env: { ...process.env, ARCO_HOOKS_SETTINGS_FILE: settingsFile }, stdio: 'pipe' },
    )
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', fail)
    child.on('close', (code) => done({ output: Buffer.concat(chunks).toString('utf8'), code }))
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arco-cli-output-'))
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ok: true, data: { todos } }))
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as { port: number }
  settingsFile = join(dir, 'hooks.json')
  writeFileSync(
    settingsFile,
    JSON.stringify({
      hooks: {
        SubagentStart: [
          {
            hooks: [{ url: `http://127.0.0.1:${port}/hook`, headers: { 'X-Arco-Token': 'test' } }],
          },
        ],
      },
    }),
  )
})

afterEach(async () => {
  await new Promise<void>((closed) => server.close(() => closed()))
  rmSync(dir, { recursive: true, force: true })
})

describe('arco todo list --json', () => {
  it('prints the whole listing when stdout and stderr share one pipe', async () => {
    const { output, code } = await runCli()

    expect(code).toBe(0)
    expect(output.length).toBeGreaterThan(64 * 1024)
    expect(output).toBe(expected)
    expect(JSON.parse(output)).toHaveLength(todos.length)
  }, 20000)
})
