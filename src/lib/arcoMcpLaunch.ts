import { type ArcoMcpLaunch, setArcoMcpSource } from './arcoMcp'
import { arcoMcpLaunch } from './tauri'

let launch: ArcoMcpLaunch | null = null
let pending: Promise<ArcoMcpLaunch | null> | null = null

/**
 * Asks the app once for the MCP server's endpoint and token.
 *
 * Launches read the answer synchronously; the first one of a run waits for it
 * here, and every later one — restarts included — finds it already known. A
 * listener that was not bound yet answers `null`, which is not kept, so the
 * next launch asks again.
 */
export function ensureArcoMcp(): Promise<ArcoMcpLaunch | null> {
  pending ??= arcoMcpLaunch()
    .then((resolved) => {
      launch = resolved
      if (!resolved) pending = null
      return resolved
    })
    .catch(() => {
      pending = null
      return null
    })
  return pending
}

setArcoMcpSource(() => launch)
