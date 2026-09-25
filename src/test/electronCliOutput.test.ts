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

// Same shape as the todo listing, and just as large: a session list is served
// from the store in one write, so it shares the pipe the fix was about.
const sessions = Array.from({ length: 400 }, (_, index) => ({
  ref: `pa-${1000 + index}`,
  id: `pane-${index}`,
  project: 'Arco',
  projectId: 'p1',
  name: `sessao ${index} ${'x'.repeat(300)}`,
  agent: 'claude',
  cwd: '/home/user/projects/arco',
  status: 'waiting',
  parked: false,
}))
const expectedSessions = `${JSON.stringify(sessions)}\n`

let server: Server
let dir: string
let settingsFile: string

/**
 * What the stand-in answers `todo/list` with when the command names a project.
 * Null plays an app from before `--project`: it ignores the field and sends the
 * whole board.
 */
let filteredReply: Record<string, unknown> | null = null

/** Runs the CLI with both descriptors on one pipe, the way `$(... 2>&1)` does. */
function runCli(args: string[]): Promise<{ output: string; code: number | null }> {
  return new Promise((done, fail) => {
    const child = spawn(
      'sh',
      ['-c', `exec "$0" "$1" ${args.join(' ')} 2>&1`, process.execPath, CLI_ENTRY],
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
  filteredReply = null
  server = createServer((request, response) => {
    const route = (request.url ?? '').split('?')[0]
    const body: Buffer[] = []
    request.on('data', (chunk: Buffer) => body.push(chunk))
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json')
      const payload = JSON.parse(Buffer.concat(body).toString('utf8') || '{}')
      if (route === '/cli/todo/list' && payload.project && filteredReply) {
        response.end(JSON.stringify(filteredReply))
        return
      }
      const data = route === '/cli/session/list' ? { sessions } : { todos }
      response.end(JSON.stringify({ ok: true, data }))
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
    const { output, code } = await runCli(['todo', 'list', '--json'])

    expect(code).toBe(0)
    expect(output.length).toBeGreaterThan(64 * 1024)
    expect(output).toBe(expected)
    expect(JSON.parse(output)).toHaveLength(todos.length)
  }, 20000)
})

describe('arco session list --json', () => {
  it('prints the whole listing when stdout and stderr share one pipe', async () => {
    const { output, code } = await runCli(['session', 'list', '--json'])

    expect(code).toBe(0)
    expect(output.length).toBeGreaterThan(64 * 1024)
    expect(output).toBe(expectedSessions)
    expect(JSON.parse(output)).toHaveLength(sessions.length)
  }, 20000)
})

describe('arco todo list --project', () => {
  it('prints only what the app filtered', async () => {
    filteredReply = { ok: true, data: { todos: [todos[0]], project: { id: 'p1', name: 'Arco' } } }

    const { output, code } = await runCli(['todo', 'list', '--project', 'Arco', '--json'])

    expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual([todos[0]])
  }, 20000)

  it('fails with the reason the app gives for a project that does not exist', async () => {
    filteredReply = { ok: false, message: 'Nenhum projeto atende por "Medtest".' }

    const { output, code } = await runCli(['todo', 'list', '--project', 'Medtest'])

    expect(code).toBe(1)
    expect(output).toBe('Nenhum projeto atende por "Medtest".\n')
  }, 20000)

  // An app from before the filter answers with every task. Printing that would
  // be the silent whole-board listing the option exists to end.
  it('fails when the app sends the whole board instead of filtering it', async () => {
    const { output, code } = await runCli(['todo', 'list', '--project', 'Arco'])

    expect(code).toBe(1)
    expect(output).toMatch(/versao que nao filtra por projeto/)
    expect(output).not.toContain('tarefa 0')
  }, 20000)
})
