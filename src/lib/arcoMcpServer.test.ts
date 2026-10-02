import { readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The server answers agents through the hook listener, so it is driven here the
// way an agent reaches it: HTTP, the token header, and the pane naming itself.
process.env.ARCO_CLI_REPLY_TIMEOUT_MS = '150'
// Never point the installed `arco` command, or a running app's panes, at this listener.
process.env.ARCO_HOOKS_SETTINGS_FILE = join(tmpdir(), `arco-mcp-test-${process.pid}.json`)

const require = createRequire(import.meta.url)
const { startHookListener, buildHookCommands } = require('../../electron/commands/hooks.cjs') as {
  startHookListener: (
    send: (event: string, payload: Record<string, unknown>) => void,
    readTodos: () => unknown[],
  ) => { close: () => void }
  buildHookCommands: () => {
    arco_mcp_launch: () => { url: string; token: string; claudeConfig: string } | null
    cli_reply: (args: { requestId?: string; result?: unknown }) => boolean
  }
}

type Reply = { ok?: boolean; message?: string; data?: unknown; stale?: boolean }

const commands = buildHookCommands()
const sent: Array<{ event: string; payload: Record<string, unknown> }> = []
let reply: ((payload: Record<string, unknown>) => Reply | null) | null = null
let server: { close: () => void }
let launch: { url: string; token: string; claudeConfig: string }

beforeAll(async () => {
  server = startHookListener(
    (event, payload) => {
      sent.push({ event, payload })
      const result = reply?.(payload)
      if (result) commands.cli_reply({ requestId: String(payload.requestId), result })
    },
    () => [{ id: 'do-disco', title: 'lida do arquivo', status: 'todo' }],
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  launch = commands.arco_mcp_launch()!
})

beforeEach(() => {
  reply = null
  sent.length = 0
})

afterAll(() => {
  server.close()
  rmSync(process.env.ARCO_HOOKS_SETTINGS_FILE!, { force: true })
  rmSync(launch.claudeConfig, { force: true })
})

let sequence = 0

async function rpc(
  method: string,
  params?: unknown,
  { session = 'pane-1', token = launch.token }: { session?: string; token?: string } = {},
) {
  sequence += 1
  const response = await fetch(launch.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Arco-Token': token,
      'X-Arco-Session': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: sequence, method, params }),
  })
  const json = response.headers.get('content-type')?.includes('application/json')
  return { status: response.status, body: json ? await response.json() : null }
}

async function call(name: string, args: Record<string, unknown> = {}, session?: string) {
  const { body } = await rpc('tools/call', { name, arguments: args }, { session })
  const result = body.result as {
    isError?: boolean
    content: Array<{ text: string }>
    structuredContent?: Record<string, unknown>
  }
  return {
    error: result.isError === true,
    text: result.content[0].text,
    data: result.structuredContent,
  }
}

describe('the MCP handshake', () => {
  it('negotiates a protocol the client asked for and says what the server is for', async () => {
    const { status, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'teste', version: '0' },
    })
    expect(status).toBe(200)
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.capabilities.tools).toBeTruthy()
    expect(body.result.serverInfo.name).toBe('arco')
    expect(body.result.instructions).toContain('current')
  })

  it('answers a protocol it does not know with the newest one it has', async () => {
    const { body } = await rpc('initialize', { protocolVersion: '1999-01-01' })
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('refuses a method it does not have, so a client probing for one falls back', async () => {
    const { body } = await rpc('server/discover', {})
    expect(body.error.code).toBe(-32601)
  })

  it('takes a notification without answering it', async () => {
    const response = await fetch(launch.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Arco-Token': launch.token },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(response.status).toBe(202)
  })

  it('refuses a caller without the token, and a stream it does not offer', async () => {
    expect((await rpc('ping', {}, { token: 'errado' })).status).toBe(403)
    const stream = await fetch(launch.url, {
      headers: { Accept: 'text/event-stream', 'X-Arco-Token': launch.token },
    })
    expect(stream.status).toBe(405)
  })

  it('lists the tools the command line covers, each with a closed schema', async () => {
    const { body } = await rpc('tools/list', {})
    const tools = body.result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'group_close',
      'group_list',
      'project_list',
      'session_close',
      'session_list',
      'session_open',
      'session_send',
      'todo_add',
      'todo_edit',
      'todo_list',
      'todo_show',
      'todo_status',
    ])
    for (const tool of tools) expect(tool.inputSchema.additionalProperties).toBe(false)
  })
})

describe('tool calls', () => {
  it('refuses a priority the board does not have instead of storing it as normal', async () => {
    const result = await call('todo_add', { title: 'x', priority: 'urgent' })
    expect(result.error).toBe(true)
    expect(result.text).toContain('high, normal, low')
    expect(sent).toHaveLength(0)
  })

  it('refuses an argument the tool does not take', async () => {
    const result = await call('todo_list', { projeto: 'Arco' })
    expect(result.error).toBe(true)
    expect(result.text).toContain('unknown argument "projeto"')
  })

  it('refuses an edit that changes nothing', async () => {
    const result = await call('todo_edit', { ref: 'abc' })
    expect(result.error).toBe(true)
    expect(result.text).toContain('nothing to change')
  })

  it('hands the frontend the same request the command line sends, naming the calling pane', async () => {
    reply = () => ({
      ok: true,
      message: 'criada',
      data: { todo: { id: 'abcdefghij', title: 'x' } },
    })
    const result = await call('todo_add', { title: 'x', priority: 'high', session: 'current' })
    expect(result.error).toBe(false)
    expect(sent[0].event).toBe('cli://todo-add')
    expect(sent[0].payload).toMatchObject({
      title: 'x',
      tags: [],
      priority: 'high',
      session: 'current',
      sessionId: 'pane-1',
    })
    expect(result.data).toEqual({
      todo: {
        ref: 'abcdefgh',
        id: 'abcdefghij',
        title: 'x',
        status: 'todo',
        priority: 'normal',
        tags: [],
        notes: '',
      },
    })
  })

  it('reports a refusal as a tool error, with the fix spelled as an argument', async () => {
    reply = () => ({
      ok: false,
      message: 'pa-1 tem worktree própria. Repita com --yes se for isso mesmo.',
    })
    const result = await call('session_close', { target: 'pa-1' })
    expect(result.error).toBe(true)
    expect(result.text).toContain('`confirm: true`')
    expect(result.text).not.toContain('--yes')
  })

  it('maps confirm onto what the frontend reads', async () => {
    reply = () => ({ ok: true, message: 'Fechando pa-1.' })
    const result = await call('session_close', { target: 'pa-1', confirm: true })
    expect(sent[0].payload).toMatchObject({ target: 'pa-1', confirmed: true })
    expect(result.data).toEqual({ message: 'Fechando pa-1.' })
  })

  it('closes a front with the request the command line sends, naming the calling pane', async () => {
    reply = () => ({
      ok: true,
      message: 'Frente "PR 1" fechada: 1 sessão(ões), e a worktree cl-1 saiu do disco.',
      data: { groupId: 'g1', panes: 1, worktree: { id: 'cl-1', state: 'removed' } },
    })
    const result = await call('group_close', { target: 'current', confirm: true }, 'pane-7')
    expect(sent[0].event).toBe('cli://group-close')
    expect(sent[0].payload).toMatchObject({
      target: 'current',
      confirmed: true,
      sessionId: 'pane-7',
    })
    expect(result.error).toBe(false)
    expect(result.data).toMatchObject({
      groupId: 'g1',
      worktree: { state: 'removed' },
      message: expect.stringContaining('saiu do disco'),
    })
  })

  it('leaves confirm out of the request unless the caller passed it', async () => {
    reply = () => ({
      ok: false,
      message: 'tem worktree própria. Repita com --yes se for isso mesmo.',
    })
    const result = await call('group_close', { target: 'g1' })
    expect(sent[0].payload).not.toHaveProperty('confirmed')
    expect(result.error).toBe(true)
    expect(result.text).toContain('`confirm: true`')
  })

  it('spells a suggested command as the tool that runs it', async () => {
    reply = () => ({
      ok: true,
      message:
        'Fechando pa-1. A frente "PR 1" ficou sem panes e segue aberta. Para fechá-la: arco group close "PR 1"',
    })
    const closed = await call('session_close', { target: 'pa-1' })
    expect(closed.data?.message).toContain('group_close with `target: "PR 1"`')

    reply = () => ({ ok: false, message: 'pa-9 é o orquestrador: arco group close pa-9.' })
    const refused = await call('session_close', { target: 'pa-9' })
    expect(refused.text).toContain('group_close with `target: "pa-9"`.')

    reply = () => ({ ok: false, message: 'Veja as frentes abertas com arco group list.' })
    const missing = await call('group_close', { target: 'nada' })
    expect(missing.text).toContain('com group_list.')
  })

  it('filters a listing by status the way it prints it', async () => {
    reply = () => ({
      ok: true,
      data: {
        todos: [
          { id: 'a1234567x', title: 'andando', status: 'in_progress' },
          { id: 'b1234567x', title: 'feita', status: 'review', completed: true },
        ],
      },
    })
    const result = await call('todo_list', { status: 'in-progress' })
    expect(result.data?.todos).toEqual([
      {
        ref: 'a1234567',
        id: 'a1234567x',
        title: 'andando',
        status: 'in-progress',
        priority: 'normal',
        tags: [],
      },
    ])
  })

  it('serves a listing from disk when the window does not answer, and says so', async () => {
    const result = await call('todo_list')
    expect(result.error).toBe(false)
    expect(result.data?.warning).toContain('disk')
  })

  it('fails loudly when the window does not answer an action', async () => {
    const result = await call('session_send', { target: 'pa-1', text: 'oi' })
    expect(result.error).toBe(true)
    expect(result.text).toContain('did not answer')
  })

  it('refuses an unknown tool as a protocol error', async () => {
    const { body } = await rpc('tools/call', { name: 'todo_delete', arguments: {} })
    expect(body.error.code).toBe(-32602)
  })
})

describe('the config file Claude loads', () => {
  it('points at the server, lets Claude name the pane, and is readable by the owner only', () => {
    const config = JSON.parse(readFileSync(launch.claudeConfig, 'utf8'))
    expect(config.mcpServers.arco).toEqual({
      type: 'http',
      url: launch.url,
      headers: { 'X-Arco-Token': launch.token, 'X-Arco-Session': '${ARCO_SESSION_ID:-}' },
    })
    if (process.platform !== 'win32') expect(statSync(launch.claudeConfig).mode & 0o777).toBe(0o600)
  })
})
