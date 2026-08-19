import { invoke } from '@tauri-apps/api/core'
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

import { measure } from '../mainThreadBudget'

// Every event handler is timed so main-thread cost can be attributed by event.
const listen = <T>(event: string, handler: (payload: { payload: T }) => void) =>
  tauriListen<T>(event, (received) =>
    measure(`ev:${event.split('/')[0]}`, () => handler(received as { payload: T })),
  )

const OPEN_PATH_EVENT = 'arco://open-path'

export type CliShimStatus = {
  supported: boolean
  installed: boolean

  stale: boolean
  path: string | null
  binDir: string | null

  onPath: boolean
}

/** O Rust serializa em snake_case; normalizamos na fronteira do IPC. */
type RawCliShimStatus = {
  supported: boolean
  installed: boolean
  stale: boolean
  path: string | null
  bin_dir: string | null
  on_path: boolean
}

function toCliShimStatus(raw: RawCliShimStatus): CliShimStatus {
  return {
    supported: raw.supported,
    installed: raw.installed,
    stale: raw.stale,
    path: raw.path,
    binDir: raw.bin_dir,
    onPath: raw.on_path,
  }
}

export async function cliTakePendingOpen(): Promise<string | null> {
  return invoke<string | null>('cli_take_pending_open')
}

export async function cliShimStatus(): Promise<CliShimStatus> {
  return toCliShimStatus(await invoke<RawCliShimStatus>('cli_shim_status'))
}

export async function cliShimInstall(): Promise<CliShimStatus> {
  return toCliShimStatus(await invoke<RawCliShimStatus>('cli_shim_install'))
}

export async function cliShimUninstall(): Promise<CliShimStatus> {
  return toCliShimStatus(await invoke<RawCliShimStatus>('cli_shim_uninstall'))
}

export function listenCliOpenPath(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>(OPEN_PATH_EVENT, (event) => handler(event.payload))
}

/** What the terminal command prints, and whether it exits 0. */
export type CliResult = {
  ok: boolean
  message?: string
  data?: unknown
}

/**
 * Answers a `/cli/*` request the listener is still holding open.
 *
 * The command line waits for this: without it the request times out and the
 * command fails, which is the point — a write that never reached the store must
 * not report success.
 */
export async function cliReply(requestId: string, result: CliResult): Promise<void> {
  await invoke('cli_reply', { requestId, result })
}
