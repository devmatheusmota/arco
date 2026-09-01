import { useEffect, useState } from 'react'

import { getClaudeSessionTitle, getCodexSessionTitle } from '../lib/tauri'
import type { SubTab } from '../lib/types'

const CACHE_TTL_MS = 300_000

/** The agents that name their own conversations. */
type TitledAgent = 'claude' | 'codex'

/**
 * Backoff for a session that has no title yet. The title is written shortly after
 * the first exchange, so the early attempts are close together — a flat 60s meant
 * the tab kept its placeholder name for a full minute of active use. The tail is
 * long enough to still catch a session that sat idle before being used.
 */
const RETRY_DELAYS_MS = [3_000, 8_000, 20_000, 45_000, 90_000, 180_000, 300_000]

type TitleCacheEntry = {
  loadedAt: number
  title: string | null
  pending?: Promise<string | null>
}

const titlesByKey = new Map<string, TitleCacheEntry>()

function cacheKey(agent: TitledAgent, cwd: string, sessionId: string): string {
  return `${agent} ${cwd.trim().toLowerCase()} ${sessionId}`
}

/**
 * The title already in the cache, without subscribing to it.
 *
 * Find/Jump lists every pane at once, so it cannot call the hook per row — but
 * it has to show the name the sidebar shows, or a name read on screen cannot be
 * found by typing it. The sidebar has almost always populated this cache by the
 * time the palette opens; when it has not, the caller falls back to the pane's
 * own name, which is what it used to show anyway.
 */
export function peekCachedChatTitle(tab: SubTab | undefined): string | null {
  const type = tab?.type
  const agent = type === 'claude' || type === 'codex' ? type : null
  if (!agent || !tab?.sessionId || !tab.cwd) return null
  return titlesByKey.get(cacheKey(agent, tab.cwd, tab.sessionId))?.title ?? null
}

function compactTitle(value: string | null | undefined): string | null {
  const title = value?.replace(/\s+/g, ' ').trim()
  return title || null
}

function fetchTitle(agent: TitledAgent, cwd: string, sessionId: string): Promise<string | null> {
  return agent === 'codex' ? getCodexSessionTitle(sessionId) : getClaudeSessionTitle(cwd, sessionId)
}

async function loadTitle(
  agent: TitledAgent,
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const key = cacheKey(agent, cwd, sessionId)
  const cached = titlesByKey.get(key)
  const now = Date.now()
  if (cached?.pending) return cached.pending
  // Only a title is worth caching. Caching the absence of one made every retry
  // answer from memory instead of re-reading the file, so a session that had not
  // been named yet stayed unnamed until the app restarted and cleared the map.
  if (cached?.title && now - cached.loadedAt < CACHE_TTL_MS) return cached.title

  const pending = fetchTitle(agent, cwd, sessionId)
    .then((value) => {
      const title = compactTitle(value)
      titlesByKey.set(key, { loadedAt: Date.now(), title })
      return title
    })
    .catch(() => {
      const title = cached?.title ?? null
      titlesByKey.set(key, { loadedAt: Date.now(), title })
      return title
    })

  titlesByKey.set(key, {
    loadedAt: cached?.loadedAt ?? 0,
    title: cached?.title ?? null,
    pending,
  })
  return pending
}

/**
 * Resolves the current conversation title. Reads only the session file of this
 * row and stops polling once a title exists — the previous version rescanned
 * every JSONL of the project on a timer, per row.
 */
export function useSidebarChatTitle(tab: SubTab | undefined): string | null {
  const [title, setTitle] = useState<string | null>(null)
  const sessionId = tab?.sessionId
  const cwd = tab?.cwd
  const type = tab?.type

  useEffect(() => {
    setTitle(null)
    const agent: TitledAgent | null = type === 'claude' || type === 'codex' ? type : null
    if (!agent || !sessionId || !cwd) return

    let cancelled = false
    let attempts = 0
    let timer: number | undefined

    const refresh = async () => {
      const next = await loadTitle(agent, cwd, sessionId)
      if (cancelled) return
      if (next) {
        setTitle(next)
        return
      }
      const delay = RETRY_DELAYS_MS[attempts]
      attempts += 1
      if (delay !== undefined) {
        timer = window.setTimeout(() => void refresh(), delay)
      }
    }

    void refresh()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [cwd, sessionId, type])

  return title
}
