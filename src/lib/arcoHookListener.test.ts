import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The listener answers the `arco` command line, so what matters here is the
// contract that side depends on: a request is only answered once the frontend
// says what it did, and a request nobody answers fails instead of reporting
// success.
process.env.ARCO_CLI_REPLY_TIMEOUT_MS = '150'
// Never point the installed `arco` command at this listener: the app may be
// running, and its settings file is the only thing the command line reads.
process.env.ARCO_HOOKS_SETTINGS_FILE = join(tmpdir(), `arco-hooks-test-${process.pid}.json`)

const require = createRequire(import.meta.url)
const nodeFs = require('node:fs') as { writeSync: (fd: number, text: string) => void }
const { handleCli } = require('../../electron/cli.cjs') as {
  handleCli: (argv: string[], exit: (code: number) => void) => boolean
}
const { startHookListener, buildHookCommands } = require('../../electron/commands/hooks.cjs') as {
  startHookListener: (
    send: (event: string, payload: Record<string, unknown>) => void,
    readTodos: () => unknown[],
  ) => { address: () => { port: number }; close: () => void }
  buildHookCommands: () => {
    agent_hooks_token: () => string
    cli_reply: (args: { requestId?: string; result?: unknown }) => boolean
  }
}

const commands = buildHookCommands()
const sent: Array<{ event: string; payload: Record<string, unknown> }> = []
let answer: ((payload: Record<string, unknown>) => void) | null = null
let server: { address: () => { port: number }; close: () => void }
let base = ''

beforeAll(async () => {
  server = startHookListener((event, payload) => {
    sent.push({ event, payload })
    answer?.(payload)
  }, () => [{ id: 'do-disco', title: 'lida do arquivo' }])
  await new Promise((resolve) => setTimeout(resolve, 50))
  base = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  answer = null
})

afterAll(() => {
  server.close()
  rmSync(process.env.ARCO_HOOKS_SETTINGS_FILE!, { force: true })
})

async function post(route: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/cli/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Arco-Token': commands.agent_hooks_token() },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

describe('/cli/* request and reply', () => {
  it('answers with what the frontend reported', async () => {
    answer = (payload) =>
      commands.cli_reply({
        requestId: String(payload.requestId),
        result: { ok: true, message: 'criada', data: { todo: { id: 'abc' } } },
      })
    const { status, body } = await post('todo', { title: 'nova' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, message: 'criada' })
    expect(sent.at(-1)?.event).toBe('cli://todo-add')
    expect(sent.at(-1)?.payload.requestId).toBeTruthy()
  })

  it('fails the request when the frontend rejects it', async () => {
    answer = (payload) =>
      commands.cli_reply({
        requestId: String(payload.requestId),
        result: { ok: false, message: 'Nenhuma tarefa encontrada para "abc".' },
      })
    const { status, body } = await post('todo/edit', { ref: 'abc', status: 'done' })
    expect(status).toBe(422)
    expect(body).toMatchObject({ ok: false })
  })

  it('fails an action nobody answers, instead of reporting it queued', async () => {
    answer = null
    const { status, body } = await post('todo/delete', { ref: 'abc' })
    expect(status).toBe(504)
    expect(body).toMatchObject({ ok: false })
  })

  it('falls back to the file on disk when a listing goes unanswered', async () => {
    answer = null
    const { status, body } = await post('todo/list')
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, stale: true })
    expect(body.data.todos).toHaveLength(1)
  })

  it('refuses an unknown route with a reason', async () => {
    const { status, body } = await post('todo/nonsense')
    expect(status).toBe(404)
    expect(body).toMatchObject({ ok: false })
  })
})

/** Runs the command line against the listener above and captures what it printed. */
async function arco(...args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const original = nodeFs.writeSync
  nodeFs.writeSync = (fd: number, text: string) => {
    ;(fd === 1 ? out : err).push(String(text))
  }
  try {
    const code = await new Promise<number>((resolve) => {
      handleCli(['/usr/bin/arco', ...args], resolve)
    })
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    nodeFs.writeSync = original
  }
}

describe('the arco command against the listener', () => {
  it('prints the task it created', async () => {
    answer = (payload) =>
      commands.cli_reply({
        requestId: String(payload.requestId),
        result: {
          ok: true,
          data: { todo: { id: 'abcdefgh1234', title: 'revisar PR', tags: ['review'] } },
        },
      })
    const { code, out } = await arco('todo', 'revisar', 'PR', '--tag', 'review')
    expect(code).toBe(0)
    expect(out).toBe('criada  abcdefgh  todo  revisar PR  #review\n')
  })

  it('exits non-zero with the reason when the app refuses the write', async () => {
    answer = (payload) =>
      commands.cli_reply({
        requestId: String(payload.requestId),
        result: { ok: false, message: 'Referência ADO não reconhecida: 22657' },
      })
    const { code, out, err } = await arco('todo', 'edit', 'abc', '--ado', '22657')
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('Referência ADO não reconhecida')
  })

  it('refuses a subcommand that does not exist without reaching the app', async () => {
    const before = sent.length
    const { code, err } = await arco('todo', 'done', 'abcdefgh')
    expect(code).toBe(1)
    expect(err).toMatch(/subcomando desconhecido: done/)
    expect(sent).toHaveLength(before)
  })

  it('refuses a mistyped subcommand carrying a task id, which used to become a task', async () => {
    const before = sent.length
    const { code, err } = await arco('todo', 'shwo', 'abcdefG1')
    expect(code).toBe(1)
    expect(err).toMatch(/parece o id de uma tarefa/)
    expect(sent).toHaveLength(before)
  })

  it('refuses `todo show` becoming a task, and asks for a real subcommand', async () => {
    const before = sent.length
    const { code, err } = await arco('todo', 'show')
    expect(code).toBe(1)
    expect(err).toMatch(/informe a tarefa/)
    expect(sent).toHaveLength(before)
  })

  it('prints a task in full', async () => {
    answer = (payload) =>
      commands.cli_reply({
        requestId: String(payload.requestId),
        result: {
          ok: true,
          data: {
            todo: {
              id: 'abcdefgh1234',
              title: 'ligar card',
              tags: [],
              notes: 'contexto',
              adoRef: { org: 'EuMedicoResidente', project: 'Plataforma EMR', workItemId: 22657 },
            },
            projectName: 'Arco',
          },
        },
      })
    const { code, out } = await arco('todo', 'show', 'abcdefgh')
    expect(code).toBe(0)
    expect(out).toContain('EuMedicoResidente/Plataforma EMR#22657')
    expect(out).toContain('  contexto')
  })

  it('requires --yes to delete without a terminal to confirm on', async () => {
    answer = (payload) =>
      commands.cli_reply({
        requestId: String(payload.requestId),
        result: { ok: true, data: { todo: { id: 'abcdefgh1234', title: 'lixo', tags: [] } } },
      })
    const denied = await arco('todo', 'delete', 'abcdefgh')
    expect(denied.code).toBe(1)
    expect(denied.err).toMatch(/use --yes/)

    const { code, out } = await arco('todo', 'delete', 'abcdefgh', '--yes')
    expect(code).toBe(0)
    expect(out).toContain('apagada  abcdefgh')
  })
})
