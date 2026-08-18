import { getCurrentWebview } from '@tauri-apps/api/webview'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'

import { recordAgentActivityInput } from '../../lib/activityTracker'
import { cliPathMatchesAgent } from '../../lib/agentCliPath'
import { AgentCompletionMonitor } from '../../lib/agentCompletionMonitor'
import { preparePtyRuntimeLaunch } from '../../lib/agentRuntimeAdapter'
import { getLocale, translate } from '../../lib/i18n'
import { traceKeyData, traceKeyDown } from '../../lib/keyTrace'
import { measure } from '../../lib/mainThreadBudget'
import { isWindows } from '../../lib/platform'
import { usePtyPanelFocused, usePtyPanelVisible } from '../../lib/ptyVisibility'
import {
  claimDiscoveredSession,
  claimMostRecentSession,
  hasTranscript,
  isSessionClaimed,
  registerSessionClaim,
} from '../../lib/sessionDiscovery'
import { buildCliContextArgs } from '../../lib/cliContext'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import {
  peekSession,
  removeSession,
  savedConversationIdFor,
  saveSession,
} from '../../lib/sessionResume'
import { waitForSessionHint } from '../../lib/sessionWatch'
import { acquireSpawnSlot, releaseSpawnSlot } from '../../lib/spawnQueue'
import {
  aiMemoryCodexConfigWrite,
  aiMemoryDetect,
  aiMemoryMcpConfigPath,
  aiMemoryOpenCodeConfigWrite,
  attachPty,
  clearPtyScrollback,
  findCliLauncher,
  graphifyCodexConfigWrite,
  graphifyEnsureGraph,
  graphifyMcpConfigPath,
  graphifyOpenCodeConfigWrite,
  gsdOpenCodePluginWrite,
  killPty,
  listenPtyActivity,
  listenPtyData,
  listenPtyExit,
  ptyExists,
  readClipboardPayload,
  readGsdChildSession,
  resizePty,
  setPtyVisible,
  snapshotAntigravitySessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
  spawnPty,
  writeClipboardText,
  writePty,
} from '../../lib/tauri'
import {
  agentCliCommand,
  type AgentRuntimeProfile,
  type AgentType,
  type Theme,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { createHiddenBacklog, dropReplayOverlap } from './terminalBacklog'
import { resolveTerminalFontFamily } from './terminalFont'
import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  shouldScrollHostScrollback,
} from './terminalInput'
import {
  type DetectedTerminalLink,
  detectTerminalLinks,
  getLogicalTerminalLine,
  makeXtermLink,
} from './terminalLinks'
import {
  attachTerminalRendererWhenSized,
  detachTerminalRenderer,
  type TerminalRenderer,
} from './terminalRenderer'
import {
  BACKGROUND_REPAINT_MS,
  DIRECT_WRITE_FRAME_LIMIT,
  ECHO_WINDOW_MS,
  FOCUSED_REPAINT_MS,
  TERMINAL_WRITE_FRAME_BUDGET,
  writePtyChunked,
  writePtyWithTimeout,
} from './terminalWrite'
import { getXtermTheme, type LinkActionState } from './xtermThemes'

// Early exits trigger a single fresh-session retry.
const EARLY_EXIT_MS = 4000

const PANEL_RESYNC_DEBOUNCE_MS = 80

const OVERFLOW_PROBE_INTERVAL_MS = 1000

/**
 * A boot step that must never hold the pane hostage.
 *
 * Session discovery, graph indexing and CLI probing are all conveniences: if
 * one of them hangs — a huge repository, a stalled backend, a shell that never
 * answers — the pane must still reach a terminal instead of showing
 * "Preparing terminal…" forever.
 */
const BOOT_STEP_TIMEOUT_MS = 5_000

/** A spawn that never answers must fail loudly, not spin forever. */
async function spawnPtyWithTimeout(
  options: Parameters<typeof spawnPty>[0],
): Promise<{ id: string }> {
  let timer: number | null = null
  try {
    return await Promise.race([
      spawnPty(options),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('spawn_pty timed out after 30 s')), 30_000)
      }),
    ])
  } finally {
    if (timer !== null) window.clearTimeout(timer)
  }
}

function withTimeout<T>(
  work: Promise<T>,
  fallback: T,
  timeoutMs = BOOT_STEP_TIMEOUT_MS,
): Promise<T> {
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

function isBrowserInputPending(): boolean {
  const scheduling = (
    navigator as Navigator & {
      scheduling?: { isInputPending?: (opts?: { includeContinuous?: boolean }) => boolean }
    }
  ).scheduling
  return scheduling?.isInputPending?.() ?? false
}

let aiMemoryMissingWarned = false

type BootPhase = 'preparing' | 'queued' | 'spawning' | 'attaching' | 'ready'

export function useXtermSession(params: {
  ptyId: string
  command?: AgentType | null
  cwd?: string | null
  extraArgs?: string[]
  initialInput?: string
  sessionId?: string
  env?: Record<string, string>
  graphifyRepo?: string | null

  gsdWatcherEnabled?: boolean

  trustSessionId?: boolean

  readOnly?: boolean
  runtimeProfile: AgentRuntimeProfile
  terminalTheme: Theme
  cliPathOverride: string | null
  sessionPersistenceKey: string
  retryKey: number
  containerRef: MutableRefObject<HTMLDivElement | null>
  terminalRef: MutableRefObject<Terminal | null>
  ptyIdRef: MutableRefObject<string | null>
  lastCtrlCRef: MutableRefObject<number>
  linkActionsRef: MutableRefObject<LinkActionState | null>
  spawnedAtRef: MutableRefObject<number>
  usedResumeRef: MutableRefObject<boolean>
  earlyExitRetriedRef: MutableRefObject<boolean>
  forceFreshRef: MutableRefObject<boolean>
  onSpawnedRef: MutableRefObject<((id: string) => void) | undefined>
  onSessionIdRef: MutableRefObject<((id: string | undefined) => void) | undefined>
  onInitialInputSentRef: MutableRefObject<(() => void) | undefined>
  onExitRef: MutableRefObject<((code: number | null) => void) | undefined>
  onLaunchErrorRef: MutableRefObject<((error: unknown) => void) | undefined>
  onAgentCompleteRef: MutableRefObject<(() => void) | undefined>
  setBootPhase: Dispatch<SetStateAction<BootPhase>>
  setCommandNotFound: Dispatch<SetStateAction<string | null>>
  setLinkActions: Dispatch<SetStateAction<LinkActionState | null>>
  setRetryKey: Dispatch<SetStateAction<number>>
  setDropActive: Dispatch<SetStateAction<boolean>>
  showLinkActionsMenu: (event: MouseEvent, link: DetectedTerminalLink) => void
  recordPromptInput: (data: string) => boolean
  navigateHistory: (direction: 'up' | 'down') => void
}) {
  const {
    ptyId,
    command,
    cwd,
    extraArgs,
    initialInput,
    sessionId,
    env,
    graphifyRepo,
    gsdWatcherEnabled,
    trustSessionId,
    readOnly,
    runtimeProfile,
    terminalTheme,
    cliPathOverride,
    sessionPersistenceKey,
    retryKey,
    containerRef,
    terminalRef,
    ptyIdRef,
    lastCtrlCRef,
    linkActionsRef,
    spawnedAtRef,
    usedResumeRef,
    earlyExitRetriedRef,
    forceFreshRef,
    onSpawnedRef,
    onSessionIdRef,
    onInitialInputSentRef,
    onExitRef,
    onLaunchErrorRef,
    onAgentCompleteRef,
    setBootPhase,
    setCommandNotFound,
    setLinkActions,
    setRetryKey,
    setDropActive,
    showLinkActionsMenu,
    recordPromptInput,
    navigateHistory,
  } = params

  const isPanelVisible = usePtyPanelVisible(ptyId)
  const isPanelFocused = usePtyPanelFocused(ptyId)
  const isPanelFocusedRef = useRef(isPanelFocused)
  isPanelFocusedRef.current = isPanelFocused
  const isPanelVisibleRef = useRef(isPanelVisible)
  const wasPanelVisibleRef = useRef(isPanelVisible)

  const isFirstVisibilityRunRef = useRef(true)

  const resyncTerminalRef = useRef<(() => Promise<void>) | null>(null)
  /** Writes what the pane missed while hidden; false when only a full resync can recover it. */
  const flushHiddenBacklogRef = useRef<(() => boolean) | null>(null)
  const rendererRef = useRef<TerminalRenderer | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (import.meta.env.DEV) {
      console.debug('[Arco][xterm] mount', {
        sessionPersistenceKey,
        retryKey,
        ptyId: ptyIdRef.current,
      })
    }

    let disposed = false
    const spawnQueueAbort = new AbortController()
    let unlistenData: (() => void) | null = null
    let unlistenActivity: (() => void) | null = null
    let unlistenExit: (() => void) | null = null
    let unlistenDragDrop: (() => void) | null = null
    let resizeTimer: number | null = null
    let writeFrame: number | null = null
    let pendingWrites: string[] = []
    let pendingWriteLength = 0
    let writeFrameIsTimeout = false
    let lastUserInputAt = 0
    const repaintIntervalMs = () => {
      if (Date.now() - lastUserInputAt < ECHO_WINDOW_MS) return 0
      return isPanelFocusedRef.current ? FOCUSED_REPAINT_MS : BACKGROUND_REPAINT_MS
    }
    let lastTerminalWriteAt = 0
    let lastOverflowProbeAt = 0
    let pendingWriteDrainResolvers: Array<() => void> = []
    let resumeErrorBuffer = ''

    let resyncCaptureRef: string[] | null = null
    let lastCols = 0
    let lastRows = 0
    let forceNextResize = false
    let completionMonitor: AgentCompletionMonitor | null = null
    let linkProviderDisposable: { dispose: () => void } | null = null
    let linkScrollDisposable: { dispose: () => void } | null = null
    let writeRecoveryPending = false
    let queuedInput = ''
    let inputFlushScheduled = false
    let inputWriteChain = Promise.resolve()

    const resourcePolicy = useProjectsStore.getState().preferences.resourcePolicy
    const terminal = new Terminal({
      cursorBlink: !readOnly,

      disableStdin: Boolean(readOnly),
      convertEol: false,
      allowProposedApi: true,
      scrollback: getTerminalScrollbackRows({
        agent: command != null && command !== 'shell',
        memoryBudgetMb: resourcePolicy.memoryBudgetMb,
      }),

      // xterm.js passa a assumir que o backend redesenha a tela sozinho
      // (como o ConPTY faz), o que corrompe o repaint de TUIs densas que

      ...(isWindows() ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } } : {}),
      fontFamily: resolveTerminalFontFamily(),
      fontSize: 14,
      theme: getXtermTheme(terminalTheme),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)

    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    // Opening into a container the browser has not laid out yet leaves xterm's
    // render service without dimensions, and its viewport then throws on the
    // first scroll sync. So the open waits for a real size — but it must never
    // wait forever: a hidden window gets no animation frames, and a pane that
    // never opens shows "Preparing terminal…" for good. Hence a size observer
    // plus a deadline, and the open happens on whichever comes first.
    let cancelRendererAttach: (() => void) | null = null
    let openObserver: ResizeObserver | null = null
    let openDeadline: number | null = null
    let opened = false
    const openTerminal = () => {
      if (disposed || opened) return
      opened = true
      openObserver?.disconnect()
      openObserver = null
      if (openDeadline !== null) {
        window.clearTimeout(openDeadline)
        openDeadline = null
      }
      terminal.open(container)
      if (isPanelVisibleRef.current) {
        cancelRendererAttach = attachTerminalRendererWhenSized(terminal, container, (renderer) => {
          rendererRef.current = renderer
        })
      }
      terminal.focus()
      void start()
    }
    const openWhenSized = () => {
      const rect = container.getBoundingClientRect()
      if (rect.width >= 2 && rect.height >= 2) {
        openTerminal()
        return
      }
      openObserver = new ResizeObserver(() => {
        const size = container.getBoundingClientRect()
        if (size.width >= 2 && size.height >= 2) openTerminal()
      })
      openObserver.observe(container)
      openDeadline = window.setTimeout(openTerminal, 500)
    }
    terminalRef.current = terminal
    // Focusing xterm's off-screen helper textarea makes the WebView scroll the
    // pane sideways even under `overflow: hidden`. Clamping now reacts to the
    // scroll event instead of running on every keystroke and every write frame:
    // the element lookups plus the inline style write forced a style recalc and
    // a layout flush per frame, which is what typing felt like. `.xterm-screen`
    // keeps its width through the `max-width` rule in the stylesheet, so no
    // inline style is needed here.
    let xtermElement: HTMLElement | null = null
    let viewportElement: HTMLElement | null = null
    const clampHorizontalScroll = () => {
      if (container.scrollLeft !== 0) container.scrollLeft = 0
      if (!xtermElement?.isConnected) {
        xtermElement = container.querySelector<HTMLElement>('.xterm')
      }
      if (!viewportElement?.isConnected) {
        viewportElement = container.querySelector<HTMLElement>('.xterm-viewport')
      }
      if (xtermElement && xtermElement.scrollLeft !== 0) xtermElement.scrollLeft = 0
      if (viewportElement && viewportElement.scrollLeft !== 0) viewportElement.scrollLeft = 0
    }
    // Focusing the pane also makes the WebView scroll every ancestor that can
    // scroll, to bring xterm's off-screen helper textarea into view — which is
    // what leaves the whole workspace shifted sideways, sidebar cut off. Only
    // the horizontal offset is reset: vertical scrolling is legitimate.
    const clampAncestorScroll = () => {
      let node: HTMLElement | null = container.parentElement
      while (node && node !== document.body) {
        if (node.scrollLeft !== 0) node.scrollLeft = 0
        node = node.parentElement
      }
      if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0
      const root = document.scrollingElement as HTMLElement | null
      if (root && root.scrollLeft !== 0) root.scrollLeft = 0
    }
    const clampAllHorizontalScroll = () => {
      clampHorizontalScroll()
      clampAncestorScroll()
    }
    container.addEventListener('scroll', clampHorizontalScroll, { capture: true, passive: true })
    document.addEventListener('scroll', clampAncestorScroll, { capture: true, passive: true })
    linkProviderDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const logicalLine = getLogicalTerminalLine(terminal.buffer.active, bufferLineNumber)
        if (!logicalLine?.text) {
          callback(undefined)
          return
        }
        const links = detectTerminalLinks(logicalLine.text).map((link) =>
          makeXtermLink(logicalLine.startLine, terminal.cols, link, {
            openMenu: showLinkActionsMenu,
          }),
        )
        callback(links.length > 0 ? links : undefined)
      },
    })

    linkScrollDisposable = terminal.onScroll(() => {
      if (linkActionsRef.current) setLinkActions(null)
    })

    /** Reschedules the flush so no more than one repaint lands per frame slot. */
    const scheduleWriteFlush = () => {
      if (writeFrame !== null) return
      const waitMs = repaintIntervalMs() - (Date.now() - lastTerminalWriteAt)
      writeFrame =
        waitMs > 1
          ? window.setTimeout(flushPendingWrite, waitMs)
          : window.requestAnimationFrame(flushPendingWrite)
      writeFrameIsTimeout = waitMs > 1
    }

    const cancelWriteFlush = () => {
      if (writeFrame === null) return
      if (writeFrameIsTimeout) window.clearTimeout(writeFrame)
      else window.cancelAnimationFrame(writeFrame)
      writeFrame = null
    }

    const flushPendingWrite = () => {
      writeFrame = null
      if (disposed) return
      if (pendingWriteLength === 0) return
      // An animation frame fires at the display's rate, and a 144 Hz panel turns
      // an agent repainting its TUI into 144 terminal repaints a second. The
      // parse work is the same either way; the painting is what saturates the
      // renderer, so the queue drains on a fixed slot instead of on every frame.
      if (Date.now() - lastTerminalWriteAt < repaintIntervalMs()) {
        scheduleWriteFlush()
        return
      }
      lastTerminalWriteAt = Date.now()

      let budget = TERMINAL_WRITE_FRAME_BUDGET
      let output = ''
      while (budget > 0 && pendingWrites.length > 0) {
        if (output && isBrowserInputPending()) break
        const head = pendingWrites[0]
        const take = Math.min(budget, head.length)
        output += head.slice(0, take)
        budget -= take
        pendingWriteLength -= take
        if (take === head.length) pendingWrites.shift()
        else pendingWrites[0] = head.slice(take)
      }

      if (output) {
        try {
          const isLastQueuedWrite = pendingWriteLength === 0
          measure('xterm.write', () =>
            terminal.write(output, isLastQueuedWrite ? drainWriteWaiters : undefined),
          )
        } catch {}
      }
      if (pendingWriteLength > 0) scheduleWriteFlush()
    }

    const drainWriteWaiters = () => {
      if (disposed || pendingWriteLength > 0 || writeFrame !== null) return
      const resolvers = pendingWriteDrainResolvers
      pendingWriteDrainResolvers = []
      resolvers.forEach((resolve) => resolve())
    }

    const queueTerminalWrite = (chunk: string) => {
      if (!chunk) return
      if (
        (window as Window & { __ARCO_DROP_TERMINAL_WRITES__?: boolean })
          .__ARCO_DROP_TERMINAL_WRITES__
      ) {
        return
      }
      // The echo of a keystroke is a handful of bytes. Parking it until the next
      // animation frame added a frame of latency to every character typed and
      // batched nothing, since there was nothing else in the queue. Only the
      // backlog needs the frame budget, so hand small chunks straight to xterm
      // while keeping a per-frame ceiling: a flood of tiny chunks still has to
      // go through the budgeted path.
      if (
        pendingWriteLength === 0 &&
        writeFrame === null &&
        chunk.length <= DIRECT_WRITE_FRAME_LIMIT &&
        Date.now() - lastTerminalWriteAt >= repaintIntervalMs()
      ) {
        lastTerminalWriteAt = Date.now()
        try {
          measure('xterm.write', () => terminal.write(chunk, drainWriteWaiters))
        } catch {}
        return
      }
      pendingWrites.push(chunk)
      pendingWriteLength += chunk.length
      if (writeFrame !== null) return
      scheduleWriteFlush()
    }

    const queueTerminalWriteAndWait = (chunk: string): Promise<void> => {
      if (!chunk) return Promise.resolve()
      return new Promise((resolve) => {
        pendingWriteDrainResolvers.push(resolve)
        queueTerminalWrite(chunk)
      })
    }

    // Scrollback replays go straight to xterm instead of through the frame
    // budget: a few MB of history split into 16 KB slices costs one rendered
    // frame each, which is what made switching panes crawl from the top of the
    // buffer down to the prompt.
    const writeReplayAtOnce = (replay: string): Promise<void> =>
      new Promise((resolve) => {
        try {
          terminal.write(replay, () => {
            try {
              terminal.scrollToBottom()
            } catch {}
            resolve()
          })
        } catch {
          resolve()
        }
      })

    const getTerminalLineHeight = () => {
      const row = container.querySelector<HTMLElement>('.xterm-rows > div')
      return row?.getBoundingClientRect().height || terminal.options.fontSize || 18
    }

    const onWheel = (event: WheelEvent) => {
      // TUIs (claude/codex) entram no buffer `alternate` e ligam mouse tracking.

      // interceptasse o wheel (preventDefault), o evento sumia e nem o host nem

      if (!shouldScrollHostScrollback(terminal.buffer.active.type, event.shiftKey)) return
      const lines = getWheelScrollLines(event, getTerminalLineHeight())
      if (lines === 0) return
      event.preventDefault()
      event.stopPropagation()
      try {
        terminal.scrollLines(lines)
      } catch {}
    }
    container.addEventListener('wheel', onWheel, { passive: false, capture: true })

    const requestWriteRecovery = (id: string, source: 'input' | 'paste', error: unknown) => {
      console.warn(`[pty-${source}] write failed for ${id}; requesting recovery`, error)
      if (disposed || writeRecoveryPending || id !== ptyIdRef.current) return
      writeRecoveryPending = true
      window.dispatchEvent(
        new CustomEvent('arco:terminal-restart-request', { detail: { ptyId: id } }),
      )
      window.setTimeout(() => {
        writeRecoveryPending = false
      }, 5_000)
    }

    const pasteText = (raw: string) => {
      try {
        if (!raw) return
        const id = ptyIdRef.current
        if (!id) return
        const text = normalizePastedText(raw)
        useTerminalsStore.getState().recordIo(id)
        recordPromptInput(text)
        inputWriteChain = inputWriteChain
          .then(() => writePtyChunked(id, text, terminal.modes.bracketedPasteMode))
          .catch((error) => requestWriteRecovery(id, 'paste', error))
      } catch (err) {
        console.warn('[pty-paste] ignored invalid clipboard payload:', err)
      }
    }

    // texto puro; arquivos do Explorer (CF_HDROP) e imagens cruas (CF_DIB /

    const resolveClipboardPaste = async (): Promise<string> => {
      const payload = await readClipboardPayload()
      switch (payload.kind) {
        case 'text':
          return payload.text
        case 'paths':
          return formatDroppedPaths(payload.paths)
        case 'image':
          return formatDroppedPaths([payload.path])
        case 'empty':
          return ''
      }
    }

    const isOverThisPane = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr)
      return !!el && container.contains(el)
    }
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter' || p.type === 'over') {
          setDropActive(isOverThisPane(p.position))
        } else if (p.type === 'leave') {
          setDropActive(false)
        } else if (p.type === 'drop') {
          setDropActive(false)
          if (isOverThisPane(p.position) && p.paths.length > 0) {
            pasteText(formatDroppedPaths(p.paths))
            terminal.focus()
          }
        }
      })
      .then((un) => {
        if (disposed) un()
        else unlistenDragDrop = un
      })
      .catch(() => {})

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      traceKeyDown(event)
      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl || event.altKey) return true

      const key = event.key.toLowerCase()

      if (
        key === '+' ||
        key === '=' ||
        key === '-' ||
        key === '_' ||
        key === '0' ||
        event.code === 'NumpadAdd' ||
        event.code === 'NumpadSubtract' ||
        event.code === 'Numpad0'
      ) {
        return false
      }

      if (key === 'c' && terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (selection) {
          void writeClipboardText(selection).catch(() => navigator.clipboard?.writeText(selection))
          terminal.clearSelection()
          return false
        }
      }
      if (key === 'c' && !readOnly) {
        const now = Date.now()
        const id = ptyIdRef.current
        if (id && now - lastCtrlCRef.current < 1500) {
          lastCtrlCRef.current = 0
          terminal.write('\r\n\x1b[33m[force kill — PTY terminated]\x1b[0m\r\n')
          void killPty(id)
          return false
        }
        lastCtrlCRef.current = now
      }

      if (key === 'v' && !readOnly) {
        event.preventDefault()
        void resolveClipboardPaste()
          .catch(() => navigator.clipboard?.readText() ?? '')
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
        return false
      }

      // Ctrl+B toggles the left sidebar; the shell must not also receive it.
      if (key === 'b' && !event.shiftKey) return false

      if (!readOnly && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down')
        return false
      }
      return true
    })

    let shouldRestoreTerminalFocus = false
    const focusTerminal = () => {
      shouldRestoreTerminalFocus = true
      terminal.focus()
      clampAllHorizontalScroll()
    }
    const rememberTerminalFocus = () => {
      shouldRestoreTerminalFocus = true
      clampAllHorizontalScroll()
    }
    const rememberPointerFocusIntent = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node) {
        shouldRestoreTerminalFocus = container.contains(target)
      }
    }
    const forgetTerminalFocus = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget
      if (nextTarget instanceof Node && !container.contains(nextTarget)) {
        shouldRestoreTerminalFocus = false
      }
    }
    const restoreLastTerminalFocus = () => {
      if (document.visibilityState === 'hidden' || !shouldRestoreTerminalFocus) return
      terminal.focus()
    }
    container.addEventListener('pointerdown', focusTerminal, true)
    container.addEventListener('click', focusTerminal)
    container.addEventListener('focusin', rememberTerminalFocus)
    container.addEventListener('focusout', forgetTerminalFocus)
    document.addEventListener('pointerdown', rememberPointerFocusIntent, true)
    window.addEventListener('focus', restoreLastTerminalFocus)
    document.addEventListener('visibilitychange', restoreLastTerminalFocus)

    const onPaste = (event: ClipboardEvent) => {
      const raw = event.clipboardData?.getData('text/plain') ?? ''
      event.preventDefault()
      event.stopPropagation()
      if (raw) {
        pasteText(raw)
        return
      }
      void resolveClipboardPaste()
        .catch(() => raw)
        .then(pasteText)
        .catch(() => {
          terminal.focus()
        })
    }
    container.addEventListener('paste', onPaste)

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (readOnly) return

      if (terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (selection) {
          void writeClipboardText(selection).catch(() => navigator.clipboard?.writeText(selection))
          terminal.clearSelection()
        }
      } else if (terminal.modes.mouseTrackingMode === 'none') {
        // With mouse tracking on, xterm already forwarded the click to the PTY and
        // the application pastes on its own — Claude Code does. Pasting here too
        // duplicates the payload; preventDefault cannot undo the forwarded report.
        void resolveClipboardPaste()
          .catch(() => navigator.clipboard?.readText() ?? '')
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
      }
    }
    container.addEventListener('contextmenu', onContextMenu)

    const flushInput = () => {
      inputFlushScheduled = false
      if (disposed || !queuedInput) return
      const id = ptyIdRef.current
      if (!id) return
      const chunk = queuedInput
      queuedInput = ''
      inputWriteChain = inputWriteChain
        .then(() => writePtyWithTimeout(id, chunk))
        .catch((error) => requestWriteRecovery(id, 'input', error))
    }
    const queueInput = (id: string, data: string) => {
      if (id !== ptyIdRef.current || !data || writeRecoveryPending) return
      queuedInput += data
      if (inputFlushScheduled) return
      inputFlushScheduled = true
      queueMicrotask(flushInput)
    }

    const runResize = () => {
      resizeTimer = null
      const id = ptyIdRef.current
      if (!id) return

      const rect = container.getBoundingClientRect()
      if (rect.width < 50 || rect.height < 30) return
      const activeBuffer = terminal.buffer.active
      const distanceFromBottom = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY)
      try {
        fitAddon.fit()
      } catch (error) {
        if (import.meta.env.DEV) console.error('[Arco][xterm] fit failed', error)

        return
      }
      // FitAddon rounds the row count from the container height, and with the
      // pane's padding that can land one row past what is actually visible —
      // the last line then renders below the fold, which is where the prompt
      // lives. Give the row back when the rendered screen overflows.
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (screen) {
        const overflow = screen.getBoundingClientRect().bottom - rect.bottom
        if (overflow > 1 && terminal.rows > 1) {
          try {
            terminal.resize(terminal.cols, terminal.rows - 1)
          } catch {}
        }
      }

      const resizedBuffer = terminal.buffer.active
      if (distanceFromBottom === 0) terminal.scrollToBottom()
      else terminal.scrollToLine(Math.max(0, resizedBuffer.baseY - distanceFromBottom))
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch (error) {
        if (import.meta.env.DEV) console.error('[Arco][xterm] refresh failed', error)
      }
      clampHorizontalScroll()
      const force = forceNextResize
      forceNextResize = false
      if (!force && terminal.cols === lastCols && terminal.rows === lastRows) return
      lastCols = terminal.cols
      lastRows = terminal.rows
      if (import.meta.env.DEV) {
        console.debug(`[pty-debug] ${id}: fit() -> resizePty ${terminal.cols}x${terminal.rows}`)
      }
      void resizePty(id, terminal.cols, terminal.rows)
    }
    const scheduleResize = (force = false) => {
      // Guard de unmount: neutraliza os setTimeout(120/320ms) de onResizeRequest

      if (disposed) return
      forceNextResize ||= force
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(runResize, 80)
    }
    const scheduleObservedResize = () => scheduleResize()
    const onResizeRequest = (event: Event) => {
      const targetPtyId = (event as CustomEvent<{ ptyId?: string }>).detail?.ptyId
      if (targetPtyId && targetPtyId !== ptyIdRef.current) return
      scheduleResize(true)
      window.setTimeout(() => scheduleResize(true), 120)
      window.setTimeout(() => scheduleResize(true), 320)
    }
    const ro = new ResizeObserver(scheduleObservedResize)
    ro.observe(container)
    const onZoomChanged = () => {
      const currentFontSize = terminal.options.fontSize
      terminal.options.fontSize = currentFontSize
      scheduleResize(true)
    }
    window.addEventListener('arco:zoom-changed', onZoomChanged)
    window.addEventListener('arco:terminal-resize-request', onResizeRequest)

    const initialFitTimer = window.setTimeout(() => {
      scheduleResize()
    }, 150)

    // zero em vez de tentar reconciliar incrementalmente. `reset()` + replay

    // What the pane missed while it was hidden. Taking these bytes in order
    // keeps the terminal in the state the agent believes it is in; the reset +
    // raw replay below re-runs repaints recorded under a different geometry and
    // leaves the two disagreeing, so it is kept only for what the backlog can
    // no longer cover.
    const hiddenBacklog = createHiddenBacklog()

    /** Writes in one shot when the frame queue is idle, which it is after a hidden stretch. */
    const writeBacklogAtOnce = (chunk: string) => {
      if (pendingWriteLength === 0 && writeFrame === null) {
        try {
          terminal.write(chunk)
        } catch {}
        return
      }
      queueTerminalWrite(chunk)
    }

    const flushHiddenBacklog = (): boolean => {
      if (hiddenBacklog.overflowed) {
        hiddenBacklog.reset()
        return false
      }
      const pending = hiddenBacklog.drain()
      if (pending) writeBacklogAtOnce(pending)
      return true
    }
    flushHiddenBacklogRef.current = flushHiddenBacklog

    const doResync = async () => {
      const id = ptyIdRef.current
      if (!id || disposed) return
      try {
        const arrivedDuringFetch: string[] = []
        resyncCaptureRef = arrivedDuringFetch
        const replay = await attachPty(id)
        resyncCaptureRef = null
        if (disposed) return
        terminal.reset()
        pendingWrites = []
        pendingWriteLength = 0
        cancelWriteFlush()
        if (replay) void writeReplayAtOnce(replay)
        // The host appends to its scrollback before it emits, so part of what
        // arrived during the fetch is already inside the replay.
        const pending = dropReplayOverlap(replay, arrivedDuringFetch.join(''))
        if (pending) queueTerminalWrite(pending)
      } catch {
        resyncCaptureRef = null
      }
    }
    resyncTerminalRef.current = doResync

    // Registra os dois listeners de streaming: `data` (canal caro — escreve

    // chunk ser processado em duplicidade.

    const registerPtyStreamListeners = async (
      id: string,
      inspectChunk?: (chunk: string) => void,
    ): Promise<boolean> => {
      const dataUnlisten = await listenPtyData(id, (chunk) => {
        measure('pty.data', () => {
          useTerminalsStore.getState().recordIo(id)
          if (resyncCaptureRef) resyncCaptureRef.push(chunk)
          queueTerminalWrite(chunk)
          completionMonitor?.handleOutput(chunk)
          inspectChunk?.(chunk)
        })
      })
      if (disposed) {
        dataUnlisten()
        return false
      }
      unlistenData = dataUnlisten

      const activityUnlisten = await listenPtyActivity(id, (chunk) => {
        measure('pty.activity', () => {
          useTerminalsStore.getState().recordIo(id)
          // This channel carries the output of a hidden pane in full. Holding it
          // is what lets the pane come back without a reset and replay.
          if (isPanelVisibleRef.current) queueTerminalWrite(chunk)
          else hiddenBacklog.push(chunk)
          completionMonitor?.handleOutput(chunk)
          inspectChunk?.(chunk)
        })
      })
      if (disposed) {
        activityUnlisten()
        return false
      }
      unlistenActivity = activityUnlisten
      return true
    }

    const attachExistingPty = async (existingId: string) => {
      setBootPhase('attaching')
      ptyIdRef.current = existingId
      useTerminalsStore.getState().registerPty(existingId)
      onSpawnedRef.current?.(existingId)

      void setPtyVisible(existingId, isPanelVisibleRef.current).catch(() => {})

      if (command === 'claude' || command === 'codex' || command === 'opencode') {
        completionMonitor = new AgentCompletionMonitor({
          ptyId: existingId,
          agent: command,
          label: command,
          cwd,
          onStatusChange: (status) => useTerminalsStore.getState().setStatus(existingId, status),
          onComplete: () => onAgentCompleteRef.current?.(),
        })
      }

      // gastar o burst de write mais pesado (TUIs como o OpenCode) enquanto

      if (isPanelVisibleRef.current) {
        const replay = await attachPty(existingId)
        if (disposed) return
        if (replay) await writeReplayAtOnce(replay)
        if (disposed) return
      }

      if (!(await registerPtyStreamListeners(existingId))) return

      const exitUnlisten = await listenPtyExit(existingId, (payload) => {
        console.info(
          `[pty-launch] ${command ?? 'shell'} EXIT (attach) id=${existingId} code=${payload.code ?? '—'} reason=${payload.reason ?? '—'}`,
        )
        if (payload.reason === 'restarted') {
          useTerminalsStore.getState().markExited(existingId)
          return
        }
        if (payload.reason === 'suspended') {
          useTerminalsStore.getState().markSuspended(existingId)
          completionMonitor?.dispose()
          completionMonitor = null
          return
        }
        useTerminalsStore.getState().markExited(existingId)
        completionMonitor?.dispose()
        completionMonitor = null
        removeSession(sessionPersistenceKey)
        onExitRef.current?.(payload.code)
      })
      if (disposed) {
        exitUnlisten()
        return
      }
      unlistenExit = exitUnlisten

      scheduleResize()
      if (!disposed) setBootPhase('ready')
    }

    terminal.onData((data) => {
      if (readOnly) return
      const id = ptyIdRef.current
      if (!id) return
      lastUserInputAt = Date.now()
      traceKeyData()
      useTerminalsStore.getState().recordIo(id)
      const startsNewSession = recordPromptInput(data)
      completionMonitor?.handleInput(data)
      const trackedPtyId = ptyIdRef.current
      if (trackedPtyId) recordAgentActivityInput(trackedPtyId, data)
      // Reading scrollWidth flushes layout, and a pane only starts overflowing
      // sideways after a resize — sampling it per keystroke paid that flush on
      // every character. The scroll listener clamps the drift meanwhile.
      const now = Date.now()
      if (now - lastOverflowProbeAt > OVERFLOW_PROBE_INTERVAL_MS) {
        lastOverflowProbeAt = now
        if (container.scrollWidth > container.clientWidth + 2) scheduleResize(true)
      }
      queueInput(id, data)
      if (startsNewSession && command && command !== 'shell') {
        cancelWriteFlush()
        pendingWrites = []
        pendingWriteLength = 0
        terminal.clear()
        terminal.scrollToBottom()
        // queueInput schedules its flush first, so this runs only after /new
        // reaches the agent and before its fresh-session output is persisted.
        queueMicrotask(() => {
          inputWriteChain = inputWriteChain
            .then(() => clearPtyScrollback(id))
            .catch((error) => console.warn('[pty-scrollback] failed to clear after /new:', error))
        })
      }
    })

    const RESUMABLE_AGENTS = ['claude', 'codex', 'opencode', 'antigravity']

    async function start() {
      try {
        // Skip zero-sized panes; the observer retries after layout settles.
        try {
          const rect = container?.getBoundingClientRect()
          if (rect && rect.width >= 50 && rect.height >= 30) fitAddon.fit()
        } catch {}
        setCommandNotFound(null)
        setBootPhase('preparing')

        const existingRuntime = useTerminalsStore.getState().byPtyId[ptyId]
        if (existingRuntime?.alive && !existingRuntime.parked) {
          await attachExistingPty(ptyId)
          return
        }
        const backendHasPty = await withTimeout(ptyExists(ptyId), false)
        if (backendHasPty) {
          await attachExistingPty(ptyId)
          return
        }

        let launcherOverride: string | undefined
        if (command && command !== 'shell') {
          if (cliPathOverride) {
            if (cliPathMatchesAgent(command, cliPathOverride)) {
              launcherOverride = cliPathOverride
              console.info(`[pty-launch] ${command} using override: ${cliPathOverride}`)
            } else {
              useProjectsStore.getState().setCliPath(command, null)
              useUiStore.getState().pushToast({
                title: translate(getLocale(), 'prefs.cliPathMismatch'),
                body: translate(getLocale(), 'prefs.cliPathMismatchBody', {
                  agent: command,
                  command: agentCliCommand(command) ?? command,
                }),
              })
            }
          }
          if (!launcherOverride) {
            const auto = await withTimeout(
              findCliLauncher(agentCliCommand(command) ?? command),
              null,
            )
            console.info(`[pty-launch] ${command} findCliLauncher → ${auto ?? 'null (NOT FOUND)'}`)
            if (!auto) {
              console.warn(
                `[pty-launch] ${command} unresolved — showing the not-found overlay and staying offline`,
              )
              setCommandNotFound(command)
              useTerminalsStore.getState().setStatus(ptyId, 'offline')
              return
            }
          }
        }

        const savedSession =
          command && RESUMABLE_AGENTS.includes(command) ? peekSession(sessionPersistenceKey) : null
        const savedConversationId = savedConversationIdFor(savedSession, command, cwd)
        let resumeId = sessionId ?? savedConversationId
        // Fallback: se a tentativa anterior morreu no nascimento usando resume,

        if (forceFreshRef.current) {
          console.warn(`[pty-launch] ${command} reabrindo SEM resume (fallback de early-exit)`)
          resumeId = undefined
        }
        if (
          resumeId &&
          cwd &&
          command &&
          isSessionClaimed(command, cwd, resumeId, sessionPersistenceKey)
        ) {
          console.warn(
            `[pty-launch] ${command} session ${resumeId} is already claimed; starting a fresh writer`,
          )
          resumeId = undefined
          removeSession(sessionPersistenceKey)
          onSessionIdRef.current?.(undefined)
        }
        // Reserve the resume ID before creating the PTY. Without this early
        // claim, two panes can pass the check above at the same time and both
        // launch `codex resume`, which makes Codex reject one writer.
        if (resumeId && cwd && command) {
          registerSessionClaim(command, cwd, resumeId, sessionPersistenceKey)
        }

        // `trustSessionId` pula essa checagem — confirmado empiricamente que

        // verdade e descarta o resume, apagando `sessionId` do tab.
        if (
          !trustSessionId &&
          (command === 'claude' ||
            command === 'codex' ||
            command === 'antigravity' ||
            command === 'opencode') &&
          resumeId &&
          cwd
        ) {
          try {
            const existing = await withTimeout(
              command === 'claude'
                ? snapshotClaudeSessions(cwd)
                : command === 'codex'
                  ? snapshotCodexSessions(cwd)
                  : command === 'antigravity'
                    ? snapshotAntigravitySessions(cwd)
                    : snapshotOpenCodeSessions(cwd),
              [],
            )
            const match = existing.find((session) => session.id === resumeId)
            const notListed = !match

            if (notListed && command !== 'opencode') {
              console.warn(`[pty-launch] ${command} ignorando sessão órfã ${resumeId}`)
              resumeId = undefined
              removeSession(sessionPersistenceKey)
              onSessionIdRef.current?.(undefined)
            } else if (match && !hasTranscript(match) && command !== 'opencode') {
              // The pointer survived a restart but names a session that never got
              // a transcript — the agent had created the directory and nothing
              // else. Resuming it opens a blank pane and buries the real
              // conversation, so fall back to the newest one that has content.
              const withContent = existing
                .filter(hasTranscript)
                .sort((a, b) => b.modified_at_ms - a.modified_at_ms)[0]
              if (withContent) {
                console.warn(
                  `[pty-launch] ${command} sessão ${resumeId} está vazia; retomando ${withContent.id}`,
                )
                resumeId = withContent.id
                onSessionIdRef.current?.(withContent.id)
              } else {
                console.warn(`[pty-launch] ${command} sessão ${resumeId} está vazia; sessão nova`)
                resumeId = undefined
                removeSession(sessionPersistenceKey)
                onSessionIdRef.current?.(undefined)
              }
            }
          } catch {}
          if (disposed) return
        }

        if (command === 'opencode' && !resumeId && cwd && !forceFreshRef.current) {
          try {
            const sessions = await snapshotOpenCodeSessions(cwd)

            // — e como `useGsdSyncSessions` acha o terminal certo justamente

            // escondendo/fechando a pane dele.

            // `.gsd-child-session` em algum momento (spawn anterior com o

            const gsdChildId = await readGsdChildSession(cwd).catch(() => null)
            const candidates = gsdChildId ? sessions.filter((s) => s.id !== gsdChildId) : sessions
            const claimed = claimMostRecentSession('opencode', cwd, candidates)
            if (claimed) resumeId = claimed.id
          } catch {}
          if (disposed) return
        }
        const preparedRuntime = command
          ? preparePtyRuntimeLaunch(command, runtimeProfile, extraArgs ?? [], env)
          : { args: extraArgs ?? [], env }

        // o spawn.
        const mcpConfigPaths: string[] = []

        if (
          graphifyRepo &&
          (command === 'claude' || command === 'codex' || command === 'opencode')
        ) {
          void withTimeout(graphifyEnsureGraph(graphifyRepo), undefined)
          if (command === 'claude') {
            const p = await withTimeout(graphifyMcpConfigPath(graphifyRepo), undefined)
            if (p) mcpConfigPaths.push(p)
          } else if (command === 'opencode') {
            await graphifyOpenCodeConfigWrite(graphifyRepo).catch(() => {})
          } else if (command === 'codex') {
            await graphifyCodexConfigWrite(graphifyRepo).catch(() => {})
          }
          if (disposed) return
        }

        const aiMemoryEnabled = useProjectsStore.getState().preferences.enabledFeatures.aiMemory
        if (
          aiMemoryEnabled &&
          cwd &&
          (command === 'claude' || command === 'codex' || command === 'opencode')
        ) {
          const status = await withTimeout(aiMemoryDetect(), undefined)
          if (status?.installed) {
            if (command === 'claude') {
              const p = await withTimeout(aiMemoryMcpConfigPath(cwd), undefined)
              if (p) mcpConfigPaths.push(p)
            } else if (command === 'opencode') {
              await aiMemoryOpenCodeConfigWrite(cwd).catch(() => {})
            } else if (command === 'codex') {
              await aiMemoryCodexConfigWrite(cwd).catch(() => {})
            }
          } else if (!aiMemoryMissingWarned) {
            aiMemoryMissingWarned = true
            useUiStore.getState().pushToast({
              title: translate(getLocale(), 'aiMemory.notInstalledTitle'),
              body: translate(getLocale(), 'aiMemory.notInstalledBody'),
            })
          }
          if (disposed) return
        }

        if (command === 'opencode' && cwd && gsdWatcherEnabled) {
          const modelChain = useProjectsStore.getState().preferences.gsdSyncModelChain ?? []

          await gsdOpenCodePluginWrite(cwd, modelChain).catch((error) => {
            console.error(`[pty-launch] gsdOpenCodePluginWrite falhou pra ${cwd}:`, error)
          })
          if (disposed) return
        }

        const launch = command
          ? buildAgentLaunch(command, preparedRuntime.args, resumeId, undefined, mcpConfigPaths)
          : { args: preparedRuntime.args, sessionId: undefined, createdSession: false }
        // Every session started here is told the `arco` command exists, unless
        // the preference says to leave the agent exactly as it starts elsewhere.
        const cliContextArgs = command
          ? buildCliContextArgs(
              command,
              useProjectsStore.getState().preferences.cliContextInjection !== false,
            )
          : []
        const allArgs = [...launch.args, ...cliContextArgs]
        const spawnArgs = allArgs.length > 0 ? allArgs : undefined
        if (command && command !== 'shell') {
          console.info(
            `[pty-launch] ${command} args=${JSON.stringify(spawnArgs ?? [])} resumeId=${resumeId ?? '—'} launcherOverride=${launcherOverride ?? '(auto/PATH)'}`,
          )
        }
        if (launch.sessionId && launch.sessionId !== sessionId) {
          onSessionIdRef.current?.(launch.sessionId)
        }
        if (command && cwd) {
          registerSessionClaim(command, cwd, launch.sessionId, sessionPersistenceKey)
        }

        // Claude gets its id up front through --session-id, but /new and /resume
        // typed inside the CLI move it to another conversation. Baselining the
        // directory here lets the watcher below adopt whatever it moves to.
        const discoveredSessionsBeforePromise =
          cwd && (!launch.sessionId || command === 'claude')
            ? command === 'codex'
              ? snapshotCodexSessions(cwd).catch(() => [])
              : command === 'antigravity'
                ? snapshotAntigravitySessions(cwd).catch(() => [])
                : command === 'opencode'
                  ? snapshotOpenCodeSessions(cwd).catch(() => [])
                  : command === 'claude'
                    ? snapshotClaudeSessions(cwd).catch(() => [])
                    : null
            : null

        // Too many parallel PTY spawns can stall the app.
        setBootPhase('queued')
        const acquiredSpawnSlot = await acquireSpawnSlot(spawnQueueAbort.signal)
        if (!acquiredSpawnSlot) return
        if (disposed) {
          releaseSpawnSlot()
          return
        }
        setBootPhase('spawning')
        let response: { id: string }
        try {
          response = await spawnPtyWithTimeout({
            cols: terminal.cols,
            rows: terminal.rows,
            id: ptyId,
            command: command ? agentCliCommand(command) : undefined,
            cwd: cwd ?? undefined,
            extraArgs: spawnArgs,
            launcherOverride,
            env: preparedRuntime.env,
          })
        } finally {
          releaseSpawnSlot()
        }
        console.info(`[pty-launch] ${command ?? 'shell'} spawn OK id=${response.id}`)
        spawnedAtRef.current = Date.now()
        usedResumeRef.current = Boolean(resumeId)
        if (disposed) return
        setBootPhase('attaching')
        ptyIdRef.current = response.id
        useTerminalsStore.getState().registerPty(response.id)
        onSpawnedRef.current?.(response.id)

        // visibilidade correta desde o primeiro lote (ex.: pane aberto num

        void setPtyVisible(response.id, isPanelVisibleRef.current).catch(() => {})
        if (command && cwd && launch.sessionId) {
          // Owned by the tab as well as the PTY: the PTY id changes on every
          // respawn, and a claim only reachable through a dead PTY id would make
          // the tab treat its own conversation as taken and start a fresh one.
          registerSessionClaim(command, cwd, launch.sessionId, sessionPersistenceKey)
          registerSessionClaim(command, cwd, launch.sessionId, response.id)
        }

        if (command === 'claude' || command === 'codex' || command === 'opencode') {
          completionMonitor = new AgentCompletionMonitor({
            ptyId: response.id,
            agent: command,
            label: command,
            cwd,
            onStatusChange: (status) => useTerminalsStore.getState().setStatus(response.id, status),
            onComplete: () => onAgentCompleteRef.current?.(),
          })
        }

        // spawn vai consumir essa entrada e injetar o resume adequado da CLI.
        if (command && RESUMABLE_AGENTS.includes(command)) {
          saveSession(sessionPersistenceKey, {
            sessionId: response.id,
            claudeSessionId: command === 'claude' ? launch.sessionId : undefined,
            codexSessionId: command === 'codex' ? launch.sessionId : undefined,
            opencodeSessionId: command === 'opencode' ? launch.sessionId : undefined,
            antigravitySessionId: command === 'antigravity' ? launch.sessionId : undefined,
            cwd: cwd ?? '',
            agent: command,
            timestamp: Date.now(),
          })

          if (
            (command === 'codex' ||
              command === 'antigravity' ||
              command === 'opencode' ||
              command === 'claude') &&
            cwd &&
            discoveredSessionsBeforePromise
          ) {
            const detectCreatedSession = async () => {
              const before = new Set((await discoveredSessionsBeforePromise).map((s) => s.id))
              if (launch.sessionId) before.add(launch.sessionId)

              // reivindicada/persistida (perdia resume ao reabrir o pane). Primeiras

              let attempt = 0
              while (!disposed) {
                const delayMs = attempt < 10 ? 3000 : 15000
                if (command === 'codex' || command === 'claude') {
                  await Promise.race([
                    new Promise((resolve) => setTimeout(resolve, delayMs)),
                    waitForSessionHint(command),
                  ])
                } else {
                  await new Promise((resolve) => setTimeout(resolve, delayMs))
                }
                if (disposed) return
                const sessions =
                  command === 'codex'
                    ? await snapshotCodexSessions(cwd).catch(() => [])
                    : command === 'antigravity'
                      ? await snapshotAntigravitySessions(cwd).catch(() => [])
                      : command === 'claude'
                        ? await snapshotClaudeSessions(cwd).catch(() => [])
                        : await snapshotOpenCodeSessions(cwd).catch(() => [])

                // equivalente no bloco de resume acima.
                let filteredSessions = sessions
                if (command === 'opencode') {
                  const gsdChildId = await readGsdChildSession(cwd).catch(() => null)
                  if (gsdChildId) filteredSessions = sessions.filter((s) => s.id !== gsdChildId)
                }
                const newSession = claimDiscoveredSession(
                  command,
                  cwd,
                  before,
                  filteredSessions,
                  sessionPersistenceKey,
                )
                // The agent creates the session directory before writing any
                // transcript, so a fresh empty one shows up here looking exactly
                // like a real conversation. Saving it would bury the pointer to
                // the session that actually has content — which is how a restart
                // used to lose the history.
                if (newSession && !hasTranscript(newSession)) {
                  attempt += 1
                  continue
                }
                if (newSession) {
                  saveSession(sessionPersistenceKey, {
                    sessionId: response.id,
                    claudeSessionId: command === 'claude' ? newSession.id : undefined,
                    codexSessionId: command === 'codex' ? newSession.id : undefined,
                    antigravitySessionId: command === 'antigravity' ? newSession.id : undefined,
                    opencodeSessionId: command === 'opencode' ? newSession.id : undefined,
                    cwd: cwd ?? '',
                    agent: command,
                    timestamp: Date.now(),
                  })
                  onSessionIdRef.current?.(newSession.id)
                  if (command !== 'claude') return
                  // Claude can switch conversation again through /new or /resume,
                  // so the watcher stays alive for the life of the pane.
                  before.add(newSession.id)
                  attempt = 0
                  continue
                }
                attempt += 1
              }
            }
            void detectCreatedSession()
          }
        }

        let resumeConflictHandled = false
        const handleResumeConflict = () => {
          resumeConflictHandled = true
          earlyExitRetriedRef.current = true
          forceFreshRef.current = true
          removeSession(sessionPersistenceKey)
          onSessionIdRef.current?.(undefined)
          terminal.write(
            '\r\n\x1b[33m[arco] Codex session is busy — opening a fresh session…\x1b[0m\r\n',
          )
          void killPty(response.id).catch(() => {})
          setRetryKey((value) => value + 1)
        }

        // registrado logo abaixo, que roda nos dois canais de streaming.
        if (isPanelVisibleRef.current) {
          const replay = await attachPty(response.id)
          if (disposed) return
          if (
            replay &&
            command === 'codex' &&
            usedResumeRef.current &&
            /already has an active writer|thread\/resume failed/i.test(replay)
          ) {
            handleResumeConflict()
            return
          }
          if (replay) await queueTerminalWriteAndWait(replay)
          if (disposed) return
        }

        const inspectResumeConflict = (chunk: string) => {
          if (command !== 'codex' || !usedResumeRef.current || resumeConflictHandled) return
          // PTY events can split the bootstrap error between chunks, so keep
          // a bounded rolling buffer instead of matching each chunk alone.
          resumeErrorBuffer = `${resumeErrorBuffer}${chunk}`.slice(-8192)
          if (/already has an active writer|thread\/resume failed/i.test(resumeErrorBuffer)) {
            handleResumeConflict()
          }
        }
        if (!(await registerPtyStreamListeners(response.id, inspectResumeConflict))) return

        const exitUnlisten = await listenPtyExit(response.id, (payload) => {
          if (disposed) return
          console.info(
            `[pty-launch] ${command ?? 'shell'} EXIT id=${response.id} code=${payload.code ?? '—'} reason=${payload.reason ?? '—'}`,
          )
          if (payload.reason === 'restarted') {
            useTerminalsStore.getState().markExited(response.id)
            return
          }
          if (payload.reason === 'suspended') {
            useTerminalsStore.getState().markSuspended(response.id)
            completionMonitor?.dispose()
            completionMonitor = null
            return
          }
          const isAgent =
            command === 'claude' ||
            command === 'codex' ||
            command === 'opencode' ||
            command === 'antigravity'
          const elapsed = Date.now() - spawnedAtRef.current

          if (
            isAgent &&
            elapsed < EARLY_EXIT_MS &&
            usedResumeRef.current &&
            !earlyExitRetriedRef.current
          ) {
            earlyExitRetriedRef.current = true
            forceFreshRef.current = true
            console.warn(
              `[pty-launch] ${command} saiu em ${elapsed}ms com resume — reabrindo sessão nova (fallback)`,
            )
            useTerminalsStore.getState().markExited(response.id)
            completionMonitor?.dispose()
            completionMonitor = null
            removeSession(sessionPersistenceKey)
            onSessionIdRef.current?.(undefined)
            terminal.write(
              '\r\n\x1b[33m[arco] sessão anterior indisponível — reabrindo sessão nova…\x1b[0m\r\n',
            )
            setRetryKey((v) => v + 1)
            return
          }

          if (isAgent && elapsed < EARLY_EXIT_MS) {
            console.warn(
              `[pty-launch] ${command} saiu em ${elapsed}ms (code ${payload.code ?? '—'}) — sem retry`,
            )
            terminal.write(
              `\r\n\x1b[31m[arco] ${command} encerrou imediatamente (code ${payload.code ?? '—'}).\x1b[0m\r\n` +
                '\x1b[90mVerifique a instalação do CLI ou configure o caminho nas preferências.\x1b[0m\r\n',
            )
          }
          useTerminalsStore.getState().markExited(response.id)
          completionMonitor?.dispose()
          completionMonitor = null

          removeSession(sessionPersistenceKey)
          onExitRef.current?.(payload.code)
        })
        if (disposed) {
          exitUnlisten()
          return
        }
        unlistenExit = exitUnlisten

        const prompt = initialInput?.trim()
        if (prompt) {
          const sendInitialInput = async () => {
            const earliestSendAt = Date.now() + 1_500
            const timedSendAt = Date.now() + 4_000
            const deadline = Date.now() + 10_000
            while (!disposed && Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 250))
              const runtime = useTerminalsStore.getState().byPtyId[response.id]
              const quietFor = runtime ? Date.now() - runtime.lastIoAt : 0
              if (
                Date.now() >= earliestSendAt &&
                runtime?.alive &&
                (quietFor >= 700 || Date.now() >= timedSendAt)
              )
                break
            }
            if (disposed) return
            try {
              await writePtyChunked(response.id, prompt, true)
              await new Promise((resolve) => window.setTimeout(resolve, 150))
              await writePty(response.id, '\r')
              window.setTimeout(() => void writePty(response.id, '\r').catch(() => {}), 1_200)
              onInitialInputSentRef.current?.()
            } catch (error) {
              console.warn('[pty-launch] não foi possível enviar o prompt inicial:', error)
            }
          }
          void sendInitialInput()
        }

        scheduleResize()
        if (!disposed) setBootPhase('ready')
      } catch (err) {
        console.error(`[pty-launch] ${command ?? 'shell'} FALHOU ao iniciar PTY:`, err)
        onLaunchErrorRef.current?.(err)
        if (!disposed) terminal.writeln(`Failed to start PTY: ${String(err)}`)
        if (!disposed) setBootPhase('ready')
      }
    }
    openWhenSized()

    return () => {
      if (import.meta.env.DEV) {
        console.debug('[Arco][xterm] unmount', {
          sessionPersistenceKey,
          retryKey,
          ptyId: ptyIdRef.current,
        })
      }
      disposed = true
      spawnQueueAbort.abort()
      container.removeEventListener('wheel', onWheel, true)
      container.removeEventListener('scroll', clampHorizontalScroll, true)
      document.removeEventListener('scroll', clampAncestorScroll, true)
      container.removeEventListener('pointerdown', focusTerminal, true)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('paste', onPaste)
      container.removeEventListener('focusin', rememberTerminalFocus)
      container.removeEventListener('focusout', forgetTerminalFocus)
      document.removeEventListener('pointerdown', rememberPointerFocusIntent, true)
      window.removeEventListener('focus', restoreLastTerminalFocus)
      document.removeEventListener('visibilitychange', restoreLastTerminalFocus)
      container.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('arco:zoom-changed', onZoomChanged)
      window.removeEventListener('arco:terminal-resize-request', onResizeRequest)
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      cancelWriteFlush()
      pendingWrites = []
      pendingWriteLength = 0
      pendingWriteDrainResolvers = []
      queuedInput = ''
      window.clearTimeout(initialFitTimer)
      unlistenData?.()
      unlistenActivity?.()
      unlistenExit?.()
      unlistenDragDrop?.()
      linkProviderDisposable?.dispose()
      linkScrollDisposable?.dispose()
      completionMonitor?.dispose()
      completionMonitor = null
      setLinkActions(null)
      openObserver?.disconnect()
      if (openDeadline !== null) window.clearTimeout(openDeadline)
      cancelRendererAttach?.()
      rendererRef.current = detachTerminalRenderer(rendererRef.current)
      if (terminalRef.current === terminal) terminalRef.current = null
      ptyIdRef.current = null
      if (resyncTerminalRef.current === doResync) resyncTerminalRef.current = null
      terminal.dispose()
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPersistenceKey, retryKey])

  useEffect(() => {
    isPanelVisibleRef.current = isPanelVisible
    const wasVisible = wasPanelVisibleRef.current
    wasPanelVisibleRef.current = isPanelVisible

    // The GPU context follows visibility, so a workspace only ever holds as many
    // as it shows. A hidden pane renders nothing; keeping its context alive just
    // pushes a visible pane past the WebView's limit.
    const terminal = terminalRef.current
    if (terminal) {
      if (isPanelVisible && !rendererRef.current) {
        const host = containerRef.current
        if (host) {
          attachTerminalRendererWhenSized(terminal, host, (renderer) => {
            rendererRef.current = renderer
          })
        }
      } else if (!isPanelVisible && rendererRef.current) {
        rendererRef.current = detachTerminalRenderer(rendererRef.current)
      }
    }

    if (isFirstVisibilityRunRef.current) {
      isFirstVisibilityRunRef.current = false
      return
    }

    let cancelled = false
    let resyncTimer: number | null = null

    // A pane coming back writes exactly the output it missed, so its terminal is
    // never reset and the agent's own view of the screen stays valid. The full
    // resync only runs when that backlog gave up — more output than the host
    // itself retains, which leaves the raw scrollback as the only source.
    const recovered = isPanelVisible && !wasVisible ? flushHiddenBacklogRef.current?.() : true

    void setPtyVisible(ptyId, isPanelVisible)
      .catch(() => false)
      .then((applied) => {
        if (!applied && isPanelVisible) {
          console.warn(
            `[pty-visibility] ${ptyId} was not registered when the panel became visible; ` +
              'the resource sampler will reconcile it',
          )
        }
        if (cancelled || !isPanelVisible || wasVisible || recovered !== false) return
        resyncTimer = window.setTimeout(() => {
          if (!cancelled) void resyncTerminalRef.current?.()
        }, PANEL_RESYNC_DEBOUNCE_MS)
      })

    return () => {
      cancelled = true
      if (resyncTimer !== null) window.clearTimeout(resyncTimer)
    }
  }, [ptyId, isPanelVisible])
}
