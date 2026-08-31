import { invoke } from '@tauri-apps/api/core'

export type AntigravitySessionSnapshot = {
  id: string
  preview: string
  modified_at_ms: number
}

export async function snapshotAntigravitySessions(
  cwd: string,
): Promise<AntigravitySessionSnapshot[]> {
  return invoke<AntigravitySessionSnapshot[]>('snapshot_antigravity_sessions', { cwd })
}

export type ModelCost = {
  model: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number

  cost_usd: number | null
}

export type SessionCost = {
  session_id: string
  agent: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  total_tokens: number
  cost_usd: number | null
  model: string | null
  by_model: ModelCost[]
}

export async function getSessionCost(
  agent: string,
  cwd: string,
  sessionId: string,
): Promise<SessionCost> {
  return invoke<SessionCost>('get_session_cost', { agent, cwd, sessionId })
}

export async function getTranscriptCost(path: string): Promise<SessionCost> {
  return invoke<SessionCost>('get_transcript_cost', { path })
}

export type ClaudeSessionMeta = {
  id: string
  title: string | null
  first_user_prompt: string | null
  message_count: number
  modified_at_ms: number
  size_bytes: number
}

export type ClaudeSessionSnapshot = {
  id: string
  modified_at_ms: number
  size_bytes: number
  /** False for transcripts written by an automated run, such as `/security-review`. */
  interactive?: boolean
}

export type CodexSessionSnapshot = {
  id: string
  cwd: string
  modified_at_ms: number
  size_bytes: number
}

export async function snapshotClaudeSessions(cwd: string): Promise<ClaudeSessionSnapshot[]> {
  return invoke<ClaudeSessionSnapshot[]>('snapshot_claude_sessions', { cwd })
}

export async function snapshotCodexSessions(cwd: string): Promise<CodexSessionSnapshot[]> {
  return invoke<CodexSessionSnapshot[]>('snapshot_codex_sessions', { cwd })
}

export async function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>('list_claude_sessions', { cwd })
}

export async function getClaudeSessionTitle(
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  return invoke<string | null>('get_claude_session_title', { cwd, sessionId })
}

/** Codex keeps every project's rollouts in one tree, so the id alone finds it. */
export async function getCodexSessionTitle(sessionId: string): Promise<string | null> {
  return invoke<string | null>('get_codex_session_title', { sessionId })
}

// --- OpenCode Sessions ---

export type OpenCodeSessionSnapshot = {
  id: string
  modified_at_ms: number
}

export async function snapshotOpenCodeSessions(cwd: string): Promise<OpenCodeSessionSnapshot[]> {
  return invoke<OpenCodeSessionSnapshot[]>('snapshot_opencode_sessions', { cwd })
}
