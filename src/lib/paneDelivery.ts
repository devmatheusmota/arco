/**
 * Putting text into a running agent's input and submitting it.
 *
 * This is what the app does when it types for the user: the initial prompt a
 * session is born with, and anything else handed to a pane that is already up.
 * It lived inside `useXtermSession` and could only ever serve the pane it was
 * written for, which is why it is here instead.
 */

import { writePtyChunked } from '../components/XTermView/terminalWrite'
import { useTerminalsStore } from '../stores/terminalsStore'
import { recordAgentActivityInput } from './activityTracker'
import { writePty } from './tauri'

/** How long the agent's input box gets to settle before the submit lands. */
const SUBMIT_DELAY_MS = 150

/**
 * Claude and Codex redraw their composer on the first Enter and swallow it
 * often enough that one submit is not reliable. The second is harmless when the
 * first took: the composer is empty and an Enter on an empty line does nothing.
 */
const SECOND_SUBMIT_DELAY_MS = 1_200

/**
 * How much of the delivery the completion monitor is told about.
 *
 * `AgentCompletionMonitor.handleInput` walks its argument character by
 * character and keeps the result as the needle for echo detection. Handing it a
 * whole delivery costs a pass over every byte and leaves a needle no echo chunk
 * could ever contain. The first line is what an echo actually looks like.
 */
const ARMING_PROMPT_MAX = 200

/**
 * Tells the activity tracker's monitor that something was typed and submitted.
 *
 * Without this, only a keystroke moves a pane into `working` — the monitor is
 * armed from `handleInput`, and the only caller is `terminal.onData`. A pane
 * written to programmatically stayed `waiting` while the agent worked, so
 * anything reading the status to decide whether the agent is free saw an idle
 * pane and kept piling work onto it.
 *
 * The pane's own monitor, the one behind the "response ready" badge, is not
 * reachable from here: it lives in the component. So a delivery moves the
 * status but does not raise that badge when the agent finishes.
 */
function armCompletionMonitor(ptyId: string, text: string): void {
  const firstLine = text.trim().split('\n', 1)[0] ?? ''
  const prompt = firstLine.slice(0, ARMING_PROMPT_MAX)
  if (!prompt) return
  // The carriage return is what arms it; the text alone only fills the buffer.
  recordAgentActivityInput(ptyId, `${prompt}\r`)
}

/**
 * Writes `text` into the PTY as a bracketed paste and submits it.
 *
 * Bracketed paste is what keeps a multi-line message from being run a line at a
 * time, and it is also the safety net when the agent turns out to be mid-turn:
 * the text lands in the composer instead of executing.
 *
 * Throws whatever the write threw. The second submit is fire-and-forget, so a
 * failure there is swallowed — by then the message is already in the composer.
 */
export async function deliverToPty(ptyId: string, text: string): Promise<void> {
  await writePtyChunked(ptyId, text, true)
  await new Promise((resolve) => window.setTimeout(resolve, SUBMIT_DELAY_MS))
  await writePty(ptyId, '\r')
  armCompletionMonitor(ptyId, text)
  // Marks the pane as having just moved bytes, so a caller watching for silence
  // does not read the quiet before the agent answers as the agent being free.
  useTerminalsStore.getState().recordIo(ptyId)
  window.setTimeout(() => void writePty(ptyId, '\r').catch(() => {}), SECOND_SUBMIT_DELAY_MS)
}
