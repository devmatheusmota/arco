import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  arcoMcpLaunch: vi.fn(async () => ({
    url: 'http://127.0.0.1:4000/mcp',
    token: 'secret',
    claudeConfig: '/data/arco-mcp.json',
  })),
  agentSessionHooksPath: vi.fn(async () => '/data/hooks.json'),
  graphifyEnsureGraph: vi.fn(async () => undefined),
  graphifyMcpConfigPath: vi.fn(async () => '/repo/.graphify/mcp.json'),
  graphifyCodexConfigWrite: vi.fn(async () => undefined),
  graphifyOpenCodeConfigWrite: vi.fn(async () => undefined),
  aiMemoryDetect: vi.fn(async () => ({ installed: true })),
  aiMemoryMcpConfigPath: vi.fn(async () => '/repo/.ai-memory/mcp.json'),
  aiMemoryCodexConfigWrite: vi.fn(async () => undefined),
  aiMemoryOpenCodeConfigWrite: vi.fn(async () => undefined),
  gsdOpenCodePluginWrite: vi.fn(async () => undefined),
}))

import { useProjectsStore } from '../stores/projectsStore'
import {
  DEFAULT_RUNTIME_PROFILE,
  graphifyRepoFor,
  paneAgentRequest,
  prepareAgentProcess,
  tabLaunchArgs,
} from './agentProcessLaunch'
import { paneSessionEnv } from './agentRuntimeAdapter'
import type { Project, SubTab, Terminal } from './types'

const tab = {
  id: 't1',
  type: 'claude',
  name: 'claude',
  cwd: '/repo',
  ptyId: 'pty-1',
  extraArgs: ['--model', 'opus'],
} as SubTab

const terminal = {
  id: 'pane-1',
  shortId: 'pa-1234',
  name: 'pane',
  cwd: '/repo',
  activeTabId: 't1',
  disabled: false,
  tabs: [tab],
} as Terminal

const project = {
  id: 'p1',
  name: 'repo',
  graphifyEnabled: true,
  gsdWatcherEnabled: false,
  terminals: [terminal],
} as unknown as Project

/** The request the pane's first launch builds, from the props TerminalPane hands XTermView. */
function bootRequest(resumeId: string) {
  return {
    agent: tab.type,
    cwd: tab.cwd || null,
    extraArgs: tabLaunchArgs(tab),
    env: paneSessionEnv(terminal),
    runtimeProfile: tab.runtimeProfile ?? DEFAULT_RUNTIME_PROFILE,
    resumeId,
    graphifyRepo: graphifyRepoFor(project, terminal),
    gsdWatcherEnabled: Boolean(project.gsdWatcherEnabled),
  }
}

beforeEach(() => {
  const preferences = useProjectsStore.getState().preferences
  useProjectsStore.setState({
    preferences: {
      ...preferences,
      cliContextInjection: true,
      enabledFeatures: { ...preferences.enabledFeatures, aiMemory: true },
    },
  })
})

describe('the args an agent process starts with', () => {
  // A restart used to build its own args: a fake claude saw 8 on first launch
  // and 6 after Restart, and the environment of the full profile instead of lean.
  it('are the same on a pane restart as on its first launch', async () => {
    const boot = await prepareAgentProcess(bootRequest('conv-1'))
    const restart = await prepareAgentProcess({
      ...paneAgentRequest(project, terminal, tab),
      resumeId: 'conv-1',
    })

    expect(restart.args).toEqual(boot.args)
    expect(restart.env).toEqual(boot.env)
  })

  it('keep the arco context, the MCP servers and the session hook on a restart', async () => {
    const { args, env, sessionId } = await prepareAgentProcess({
      ...paneAgentRequest(project, terminal, tab),
      resumeId: 'conv-1',
    })

    expect(sessionId).toBe('conv-1')
    expect(args.slice(0, 2)).toEqual(['--resume', 'conv-1'])
    const configs = args.flatMap((arg, index) => (arg === '--mcp-config' ? [args[index + 1]] : []))
    expect(configs).toEqual([
      '/repo/.graphify/mcp.json',
      '/repo/.ai-memory/mcp.json',
      '/data/arco-mcp.json',
    ])
    expect(args[args.indexOf('--settings') + 1]).toBe('/data/hooks.json')
    expect(args).toContain('--append-system-prompt')
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus']))
    expect(env).toEqual(expect.objectContaining({ ARCO_PANE_ID: 'pa-1234' }))
  })

  it('carry the folder a handoff hands over', () => {
    const handedOff = { ...tab, handoff: { id: 'h1', contextDir: '/tmp/handoff-1' } } as SubTab

    expect(paneAgentRequest(project, terminal, handedOff).extraArgs).toEqual([
      '--model',
      'opus',
      '--add-dir',
      '/tmp/handoff-1',
    ])
  })

  it('leave out the arco context when the preference says so', async () => {
    useProjectsStore.setState({
      preferences: { ...useProjectsStore.getState().preferences, cliContextInjection: false },
    })

    const { args } = await prepareAgentProcess(paneAgentRequest(project, terminal, tab))

    expect(args).not.toContain('--append-system-prompt')
  })
})
