import { create } from 'zustand'

import { mcpCapabilities, mcpScan } from '../lib/tauri'
import type { McpAgent, McpAgentSnapshot, McpCapability, McpScope } from '../lib/types'

type RefreshOptions = {
  scope?: McpScope
  view?: McpView
  repo?: string | null
}

/**
 * What the panel lists. `scope` is what the backend scans; this is the narrower
 * question of which of those results to show, and the two do not map one to one:
 * plugin servers arrive with the global scan but deserve their own bucket, since
 * they are read-only and come from somewhere the user did not edit by hand.
 */
export type McpView = 'all' | 'project' | 'global' | 'plugins'

/** Scope each view needs scanned. `all` needs both, so it is handled separately. */
const VIEW_SCOPE: Record<Exclude<McpView, 'all'>, McpScope> = {
  project: 'project',
  global: 'global',
  plugins: 'global',
}

/** Source kinds a view keeps once the scan is back. */
const VIEW_KINDS: Record<McpView, readonly string[] | null> = {
  all: null,
  project: ['local', 'project'],
  global: ['user'],
  plugins: ['plugin'],
}

type McpState = {
  scope: McpScope
  view: McpView
  repo: string | null
  snapshots: McpAgentSnapshot[]
  capabilities: Partial<Record<McpAgent, McpCapability>>
  loading: boolean
  error: string | null
  loadedAt: number
  setScope: (scope: McpScope) => void
  setView: (view: McpView) => void
  refresh: (options?: RefreshOptions) => Promise<void>
}

let scanSequence = 0

/** Keeps only the servers a view cares about, dropping snapshots left empty. */
function filterByView(snapshots: McpAgentSnapshot[], view: McpView): McpAgentSnapshot[] {
  const kinds = VIEW_KINDS[view]
  if (!kinds) return snapshots
  return snapshots
    .map((snapshot) => ({
      ...snapshot,
      sources: snapshot.sources.filter((source) => kinds.includes(source.kind)),
      servers: snapshot.servers.filter((server) => kinds.includes(server.sourceKind)),
    }))
    .filter((snapshot) => snapshot.sources.length > 0 || snapshot.servers.length > 0)
}

/** Merges the global and project scans per agent for the `all` view. */
function mergeSnapshots(first: McpAgentSnapshot[], second: McpAgentSnapshot[]): McpAgentSnapshot[] {
  const byAgent = new Map<McpAgent, McpAgentSnapshot>()
  for (const snapshot of [...first, ...second]) {
    const existing = byAgent.get(snapshot.agent)
    if (!existing) {
      byAgent.set(snapshot.agent, { ...snapshot })
      continue
    }
    // The same file can surface in both scans; the source path plus the server
    // name is what makes an entry unique.
    const seenSources = new Set(existing.sources.map((source) => `${source.kind}:${source.path}`))
    const seenServers = new Set(
      existing.servers.map((record) => `${record.sourcePath}:${record.server.name}`),
    )
    existing.sources = [
      ...existing.sources,
      ...snapshot.sources.filter((source) => !seenSources.has(`${source.kind}:${source.path}`)),
    ]
    existing.servers = [
      ...existing.servers,
      ...snapshot.servers.filter(
        (record) => !seenServers.has(`${record.sourcePath}:${record.server.name}`),
      ),
    ]
  }
  return [...byAgent.values()]
}

export const useMcpStore = create<McpState>((set, get) => ({
  scope: 'global',
  view: 'all',
  repo: null,
  snapshots: [],
  capabilities: {},
  loading: false,
  error: null,
  loadedAt: 0,

  setScope: (scope) => {
    if (get().scope === scope) return
    set({ scope })
    void get().refresh({ scope })
  },

  setView: (view) => {
    if (get().view === view) return
    set({ view })
    void get().refresh({ view })
  },

  refresh: async (options) => {
    const view = options?.view ?? get().view
    const scope = options?.scope ?? (view === 'all' ? get().scope : VIEW_SCOPE[view])
    const repo = options?.repo !== undefined ? options.repo : get().repo
    const sequence = ++scanSequence
    set({ loading: true, error: null, scope, view, repo })
    try {
      // `all` is the only view that needs both scans; the project one is skipped
      // when there is no repo to scan.
      const raw =
        view === 'all'
          ? mergeSnapshots(
              await mcpScan('global', repo),
              repo ? await mcpScan('project', repo) : [],
            )
          : await mcpScan(scope, repo)
      if (sequence !== scanSequence) return
      set({ snapshots: filterByView(raw, view), loading: false, loadedAt: Date.now() })
    } catch (error) {
      if (sequence !== scanSequence) return
      set({
        snapshots: [],
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (Object.keys(get().capabilities).length > 0) return
    try {
      const list = await mcpCapabilities()
      set({
        capabilities: Object.fromEntries(list.map((item) => [item.agent, item])) as Partial<
          Record<McpAgent, McpCapability>
        >,
      })
    } catch {
      // Capabilities are decoration; a failure must not blank the panel.
    }
  },
}))
