/**
 * Messages waiting for a pane to be free.
 *
 * Deliberately not persisted. A queue is a bet that the agent on the other end
 * is still in the conversation it was in when the message was written, and an
 * instruction reinjected into a fresh session after a restart is worse than one
 * that was lost — so closing the app empties it, and the command line says so.
 *
 * A message is delivered when the pane looks idle, which is a silence
 * heuristic, not something the agent reports. The window and the one-item-per-
 * tick pace exist to make a wrong guess cheap: bracketed paste leaves the text
 * sitting in the composer rather than running it mid-turn.
 */

import { nanoid } from 'nanoid'
import { create } from 'zustand'

import { getLocale, translate } from '../lib/i18n'
import { deliverToPty } from '../lib/paneDelivery'
import type { Terminal } from '../lib/types'
import { useProjectsStore } from './projectsStore'
import { useTerminalsStore } from './terminalsStore'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

export type QueuedMessage = {
  id: string
  text: string
  queuedAt: number
}

/** How often the queue looks for a pane that has gone quiet. */
export const DRAIN_TICK_MS = 500

/**
 * How long a pane has to be silent before it counts as free.
 *
 * Short on purpose: the completion monitor is the real signal, and this only
 * has to cover the gap between the last byte of a turn and the status catching
 * up with it.
 */
export const QUIET_WINDOW_MS = 700

/** After this, a message is stale enough that injecting it would surprise more than it helps. */
export const MESSAGE_TTL_MS = 30 * 60_000

type PaneInboxState = {
  byTerminalId: Record<string, QueuedMessage[]>
  /** Appends a message and returns its place in the line, counting from 1. */
  enqueue: (terminalId: string, text: string) => { message: QueuedMessage; position: number }
  /** Replaces a pane's queue; an empty one removes the pane entirely. */
  replace: (terminalId: string, queue: QueuedMessage[]) => void
  drop: (terminalId: string) => void
}

export const usePaneInboxStore = create<PaneInboxState>((set, get) => ({
  byTerminalId: {},

  enqueue: (terminalId, text) => {
    const message: QueuedMessage = { id: nanoid(), text, queuedAt: Date.now() }
    const queue = [...(get().byTerminalId[terminalId] ?? []), message]
    set((state) => ({ byTerminalId: { ...state.byTerminalId, [terminalId]: queue } }))
    startDrain()
    return { message, position: queue.length }
  },

  replace: (terminalId, queue) =>
    set((state) => {
      if (!(terminalId in state.byTerminalId)) {
        return queue.length === 0
          ? state
          : { byTerminalId: { ...state.byTerminalId, [terminalId]: queue } }
      }
      const next = { ...state.byTerminalId }
      if (queue.length === 0) delete next[terminalId]
      else next[terminalId] = queue
      return { byTerminalId: next }
    }),

  drop: (terminalId) =>
    set((state) => {
      if (!(terminalId in state.byTerminalId)) return state
      const next = { ...state.byTerminalId }
      delete next[terminalId]
      return { byTerminalId: next }
    }),
}))

/** Forgets what was waiting for a pane that is going away. */
export function dropPaneInbox(terminalId: string): void {
  usePaneInboxStore.getState().drop(terminalId)
}

/** What the drain found when it went looking for the pane a queue belongs to. */
type PaneTarget =
  | { kind: 'gone' }
  | { kind: 'waiting'; terminal: Terminal }
  | { kind: 'ready'; ptyId: string; terminal: Terminal }

/**
 * Finds the PTY a message should land in.
 *
 * "No live PTY" is the normal state of a pane that has not been on screen since
 * the app started — the session is real, its process simply has not been
 * spawned yet — so it is a reason to wait, not to refuse.
 */
function resolvePane(terminalId: string): PaneTarget {
  for (const project of useProjectsStore.getState().projects) {
    const terminal = project.terminals.find((item) => item.id === terminalId)
    if (!terminal) continue
    if (terminal.disabled) return { kind: 'waiting', terminal }
    const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
    return tab?.ptyId
      ? { kind: 'ready', ptyId: tab.ptyId, terminal }
      : { kind: 'waiting', terminal }
  }
  return { kind: 'gone' }
}

/** How a pane is named in a message to the user: its reference, or a slice of its id. */
function paneLabel(terminalId: string, terminal?: Terminal): string {
  return terminal?.shortId || terminalId.slice(0, 8)
}

let drainTimer: number | null = null

/** Panes with a delivery in flight, so a slow write is not started twice. */
const delivering = new Set<string>()

function startDrain(): void {
  if (drainTimer !== null) return
  drainTimer = window.setInterval(() => void drainTick(), DRAIN_TICK_MS)
}

function stopDrain(): void {
  if (drainTimer === null) return
  window.clearInterval(drainTimer)
  drainTimer = null
}

/**
 * One pass over the queues.
 *
 * Never a subscription to `useTerminalsStore`: that store moves on every chunk
 * of agent output, and a listener there would wake this up hundreds of times a
 * second to learn nothing. A timer that only exists while something is queued
 * costs nothing in the normal case, which is an empty queue.
 */
async function drainTick(): Promise<void> {
  const inboxes = usePaneInboxStore.getState().byTerminalId
  const terminalIds = Object.keys(inboxes)
  if (terminalIds.length === 0) {
    stopDrain()
    return
  }

  for (const terminalId of terminalIds) {
    if (delivering.has(terminalId)) continue

    // Read per pane, not once for the whole pass: a delivery earlier in this
    // loop was awaited, and a pane that went to work during it would still look
    // idle in a snapshot taken before that happened.
    const now = Date.now()
    const current = usePaneInboxStore.getState().byTerminalId[terminalId] ?? []
    if (current.length === 0) continue

    const target = resolvePane(terminalId)
    if (target.kind === 'gone') {
      usePaneInboxStore.getState().drop(terminalId)
      // The command line answered `ok` when this was queued, so a silent drop
      // would leave whoever sent it believing the message landed.
      useUiStore.getState().pushToast({
        title: t('ui.terminal.queueDiscardedTitle'),
        body: t('ui.terminal.queuePaneGoneBody', {
          count: current.length,
          ref: paneLabel(terminalId),
        }),
      })
      continue
    }

    const queue = current.filter((message) => now - message.queuedAt < MESSAGE_TTL_MS)
    if (queue.length !== current.length) {
      usePaneInboxStore.getState().replace(terminalId, queue)
      useUiStore.getState().pushToast({
        title: t('ui.terminal.queueDiscardedTitle'),
        body: t('ui.terminal.queueExpiredBody', {
          count: current.length - queue.length,
          ref: paneLabel(terminalId, target.terminal),
        }),
      })
    }
    if (queue.length === 0) continue
    if (target.kind === 'waiting') continue

    const runtime = useTerminalsStore.getState().byPtyId[target.ptyId]
    if (!runtime?.alive || runtime.parked) continue
    if (runtime.status === 'working') continue
    if (now - runtime.lastIoAt < QUIET_WINDOW_MS) continue

    // One item per tick. Delivering the rest of a queue into an agent that has
    // not started reading the first message is how a batch turns into noise.
    const [next, ...rest] = queue
    delivering.add(terminalId)
    // Removed before the write, not after: a delivery that failed part-way
    // already put bytes in the composer, and pasting over them is worse than
    // losing the message — which is why the failure is reported rather than retried.
    usePaneInboxStore.getState().replace(terminalId, rest)
    try {
      await deliverToPty(target.ptyId, next.text)
    } catch (error) {
      console.warn('[paneInbox] could not deliver the queued message:', error)
      useUiStore.getState().pushToast({
        title: t('ui.terminal.deliveryFailedTitle'),
        body: t('ui.terminal.deliveryFailedBody', {
          ref: paneLabel(terminalId, target.terminal),
          error: String(error).slice(0, 200),
        }),
      })
    } finally {
      delivering.delete(terminalId)
    }
  }
}
