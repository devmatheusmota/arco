import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'electron', 'session-hook.cjs')

type Received = { url?: string; headers: IncomingHttpHeaders; body: string }

/**
 * Runs the hook the way Claude Code does — payload on stdin, the pane's
 * environment — against a listener standing in for the app.
 */
async function runHook(payload: object, env: Record<string, string>) {
  const received: Received[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      received.push({ url: request.url, headers: request.headers, body })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'arco-session-hook-'))
  const settings = join(dir, 'arco-agent-hooks.json')
  const hook = { url: `http://127.0.0.1:${port}/hook`, headers: { 'X-Arco-Token': 'segredo' } }
  writeFileSync(settings, JSON.stringify({ hooks: { SubagentStart: [{ hooks: [hook] }] } }))

  const child = spawn(process.execPath, [script, settings], {
    env: { PATH: process.env.PATH ?? '', ...env },
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stdin.end(JSON.stringify(payload))
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
  server.close()
  return { received, stdout, code }
}

describe('session-hook.cjs', () => {
  it('tells the app which conversation the pane moved to, and says nothing to the agent', async () => {
    const { received, stdout, code } = await runHook(
      { hook_event_name: 'SessionStart', source: 'resume', session_id: '1105a343', cwd: '/repo' },
      { ARCO_PTY_ID: 'U3ChsRB' },
    )

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(received).toHaveLength(1)
    expect(received[0]?.url).toBe('/session')
    expect(received[0]?.headers['x-arco-token']).toBe('segredo')
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      pty: 'U3ChsRB',
      sessionId: '1105a343',
      source: 'resume',
      cwd: '/repo',
    })
  })

  it('stays quiet in a Claude that Arco did not start', async () => {
    const { received, code } = await runHook(
      { hook_event_name: 'SessionStart', source: 'startup', session_id: 'x' },
      {},
    )

    expect(code).toBe(0)
    expect(received).toHaveLength(0)
  })
})
