import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { paneSessionEnv, preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { ensureArcoMcp } from './arcoMcpLaunch'
import { ensureClaudeSessionHooks } from './claudeSessionHooks'
import { buildCliContextArgs } from './cliContext'
import { getLocale, translate } from './i18n'
import { buildAgentLaunch } from './sessionLaunch'
import {
  aiMemoryCodexConfigWrite,
  aiMemoryDetect,
  aiMemoryMcpConfigPath,
  aiMemoryOpenCodeConfigWrite,
  graphifyCodexConfigWrite,
  graphifyEnsureGraph,
  graphifyMcpConfigPath,
  graphifyOpenCodeConfigWrite,
  gsdOpenCodePluginWrite,
} from './tauri'
import type { AgentRuntimeProfile, AgentType, Project, SubTab, Terminal } from './types'

/** The profile a pane's agent runs under when its tab names none. */
export const DEFAULT_RUNTIME_PROFILE: AgentRuntimeProfile = 'lean'

/** No step of a launch may hold the spawn behind a call that never answers. */
const STEP_TIMEOUT_MS = 5_000

function withTimeout<T>(work: Promise<T>, fallback: T, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs)
    work
      .then((value) => {
        window.clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        window.clearTimeout(timer)
        resolve(fallback)
      })
  })
}

let aiMemoryMissingWarned = false

export type AgentProcessRequest = {
  agent: AgentType
  /** The directory the agent works in; the project-level configs written below key on it. */
  cwd?: string | null
  extraArgs?: readonly string[]
  env?: Record<string, string>
  runtimeProfile?: AgentRuntimeProfile
  /** The conversation to resume; without one, Claude gets a new id up front. */
  resumeId?: string
  graphifyRepo?: string | null
  gsdWatcherEnabled?: boolean
}

export type AgentProcess = {
  args: string[]
  env?: Record<string, string>
  sessionId?: string
  createdSession: boolean
}

/** The repository whose Graphify MCP a pane's agent loads, or null when the project has it off. */
export function graphifyRepoFor(
  project: Pick<Project, 'graphifyEnabled' | 'terminals'> | null | undefined,
  terminal: Pick<Terminal, 'cwd'>,
): string | null {
  if (!project?.graphifyEnabled) return null
  return terminal.cwd || project.terminals[0]?.cwd || null
}

/** The tab's own args, plus the folder a handoff hands over. */
export function tabLaunchArgs(tab: Pick<SubTab, 'extraArgs' | 'handoff'>): string[] {
  const args = [...(tab.extraArgs ?? [])]
  if (tab.handoff) args.push('--add-dir', tab.handoff.contextDir)
  return args
}

/**
 * What a pane's active tab starts its agent with, derived the way the pane
 * hands it to its terminal on first launch — so a restart asks for the same.
 */
export function paneAgentRequest(
  project: Pick<Project, 'graphifyEnabled' | 'gsdWatcherEnabled' | 'terminals'> | null | undefined,
  terminal: Pick<Terminal, 'id' | 'shortId' | 'cwd'>,
  tab: Pick<SubTab, 'type' | 'cwd' | 'extraArgs' | 'handoff' | 'runtimeProfile'>,
): AgentProcessRequest {
  return {
    agent: tab.type,
    cwd: tab.cwd || null,
    extraArgs: tabLaunchArgs(tab),
    env: paneSessionEnv(terminal),
    runtimeProfile: tab.runtimeProfile,
    graphifyRepo: graphifyRepoFor(project, terminal),
    gsdWatcherEnabled: Boolean(project?.gsdWatcherEnabled),
  }
}

/** `paneAgentRequest` for a pane looked up by id; null when it no longer exists. */
export function paneAgentRequestById(
  projectId: string,
  terminalId: string,
  tabId?: string,
): AgentProcessRequest | null {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const terminal = project?.terminals.find((item) => item.id === terminalId)
  const tab =
    terminal?.tabs.find((item) => item.id === (tabId ?? terminal.activeTabId)) ?? terminal?.tabs[0]
  if (!project || !terminal || !tab) return null
  return paneAgentRequest(project, terminal, tab)
}

/**
 * The args and environment an agent process starts with.
 *
 * Every way a pane starts an agent goes through here — its first launch and
 * every restart. The restart used to assemble its own args and started the
 * agent without the `arco` context, without its MCP servers and under another
 * runtime profile, so a restarted agent no longer knew the tools it had a
 * minute before.
 */
export async function prepareAgentProcess(request: AgentProcessRequest): Promise<AgentProcess> {
  const { agent, graphifyRepo, gsdWatcherEnabled, resumeId } = request
  const cwd = request.cwd || null
  const runsMcp = agent === 'claude' || agent === 'codex' || agent === 'opencode'

  // The launch rules below read the app's MCP endpoint synchronously; the first
  // agent of a run is the one that waits for it.
  if (runsMcp) await withTimeout(ensureArcoMcp(), null)

  const runtime = preparePtyRuntimeLaunch(
    agent,
    request.runtimeProfile ?? DEFAULT_RUNTIME_PROFILE,
    request.extraArgs ?? [],
    request.env,
  )

  const mcpConfigPaths: string[] = []
  if (graphifyRepo && runsMcp) {
    void withTimeout(graphifyEnsureGraph(graphifyRepo), undefined)
    if (agent === 'claude') {
      const configPath = await withTimeout(graphifyMcpConfigPath(graphifyRepo), undefined)
      if (configPath) mcpConfigPaths.push(configPath)
    } else if (agent === 'opencode') {
      await graphifyOpenCodeConfigWrite(graphifyRepo).catch(() => {})
    } else {
      await graphifyCodexConfigWrite(graphifyRepo).catch(() => {})
    }
  }

  const preferences = useProjectsStore.getState().preferences
  if (preferences.enabledFeatures.aiMemory && cwd && runsMcp) {
    const status = await withTimeout(aiMemoryDetect(), undefined)
    if (status?.installed) {
      if (agent === 'claude') {
        const configPath = await withTimeout(aiMemoryMcpConfigPath(cwd), undefined)
        if (configPath) mcpConfigPaths.push(configPath)
      } else if (agent === 'opencode') {
        await aiMemoryOpenCodeConfigWrite(cwd).catch(() => {})
      } else {
        await aiMemoryCodexConfigWrite(cwd).catch(() => {})
      }
    } else if (!aiMemoryMissingWarned) {
      aiMemoryMissingWarned = true
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'aiMemory.notInstalledTitle'),
        body: translate(getLocale(), 'aiMemory.notInstalledBody'),
      })
    }
  }

  if (agent === 'opencode' && cwd && gsdWatcherEnabled) {
    const modelChain = preferences.gsdSyncModelChain ?? []
    await gsdOpenCodePluginWrite(cwd, modelChain).catch((error) => {
      console.error(`[pty-launch] gsdOpenCodePluginWrite failed for ${cwd}:`, error)
    })
  }

  // Asked once per run; every later launch already has the answer.
  if (agent === 'claude') await withTimeout(ensureClaudeSessionHooks(), null)

  const launch = buildAgentLaunch(agent, runtime.args, resumeId, undefined, mcpConfigPaths)
  // Every agent is told the `arco` command exists, unless the preference says
  // to leave it exactly as it starts elsewhere.
  const cliContextArgs = buildCliContextArgs(
    agent,
    useProjectsStore.getState().preferences.cliContextInjection !== false,
  )
  return {
    args: [...launch.args, ...cliContextArgs],
    env: runtime.env,
    sessionId: launch.sessionId,
    createdSession: launch.createdSession,
  }
}
