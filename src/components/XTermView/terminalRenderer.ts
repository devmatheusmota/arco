import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ITerminalAddon, Terminal } from '@xterm/xterm'

import { recordAppEvent } from '../../lib/tauri'

/**
 * Accelerated renderer for a pane.
 *
 * Without one, xterm.js builds a DOM element per cell. That is what makes an
 * agent redrawing its TUI saturate the WebView's main thread — every repaint
 * walks thousands of nodes — and it slows down the whole app, not just the pane
 * producing the output.
 *
 * Three tiers, in order: WebGL, 2D canvas, DOM. WebGL is the fastest but is not
 * always there — WebKitGTK in particular ships WebGL2 off or unaccelerated on
 * some builds — and the canvas renderer, while slower than the GPU, still draws
 * a whole frame in one pass instead of reflowing a grid of elements.
 *
 * The renderer is attached per pane rather than once per terminal because a
 * WebView caps how many live WebGL contexts a page may hold (Chromium drops the
 * oldest past ~16). Panes that are off screen do not need acceleration, so
 * binding the context to visibility keeps the count at what is actually on
 * screen and leaves the eviction path unused.
 */

export type TerminalRendererKind = 'webgl' | 'canvas' | 'dom'

export type TerminalRenderer = {
  kind: TerminalRendererKind
  addon: ITerminalAddon | null
}

/**
 * Reported once per process. Which tier a machine lands on decides whether an
 * animated TUI costs a few percent of a core or all of it, and the app log is
 * the only place to read it on a release build, where devtools are compiled out.
 */
let rendererReported = false

function reportRenderer(kind: TerminalRendererKind, detail?: string): void {
  if (rendererReported) return
  rendererReported = true
  void recordAppEvent('terminal.renderer', detail ? `${kind}: ${detail}` : kind).catch(() => {})
}

function rendererOverride(): TerminalRendererKind | null {
  const value = (window as Window & { __ARCO_TERMINAL_RENDERER__?: string })
    .__ARCO_TERMINAL_RENDERER__
  return value === 'canvas' || value === 'dom' || value === 'webgl' ? value : null
}

/** Attaches the fastest renderer this WebView can provide. */
export function attachTerminalRenderer(terminal: Terminal): TerminalRenderer {
  const override = rendererOverride()
  if (override === 'dom') {
    reportRenderer('dom', 'forced by ARCO_TERMINAL_RENDERER')
    return { kind: 'dom', addon: null }
  }
  if (override === 'canvas') {
    try {
      const addon = new CanvasAddon()
      terminal.loadAddon(addon)
      reportRenderer('canvas', 'forced by ARCO_TERMINAL_RENDERER')
      return { kind: 'canvas', addon }
    } catch (error) {
      console.warn('[xterm-renderer] forced canvas failed; falling back', error)
    }
  }
  try {
    const addon = new WebglAddon()
    // A lost context leaves the pane blank. Dropping the addon falls the pane
    // back to the DOM renderer, which is slow but always draws.
    addon.onContextLoss(() => {
      try {
        addon.dispose()
      } catch {}
    })
    terminal.loadAddon(addon)
    reportRenderer('webgl')
    return { kind: 'webgl', addon }
  } catch (webglError) {
    console.warn('[xterm-renderer] WebGL unavailable; trying the canvas renderer', webglError)
    try {
      const addon = new CanvasAddon()
      terminal.loadAddon(addon)
      reportRenderer('canvas', String(webglError).slice(0, 160))
      return { kind: 'canvas', addon }
    } catch (canvasError) {
      console.warn('[xterm-renderer] canvas unavailable; falling back to the DOM', canvasError)
      reportRenderer('dom', String(canvasError).slice(0, 160))
      return { kind: 'dom', addon: null }
    }
  }
}

/** Releases the renderer. Safe to call on an addon that already lost its context. */
export function detachTerminalRenderer(renderer: TerminalRenderer | null): null {
  if (!renderer?.addon) return null
  try {
    renderer.addon.dispose()
  } catch {}
  return null
}

/**
 * Attaches once the pane actually has a size.
 *
 * The GPU renderer reads the terminal's cell dimensions when it loads, and a
 * pane mounted into a container that has not been laid out yet has none —
 * Chromium throws on it where WebKit happened to tolerate it. Retrying on the
 * next frames costs nothing and removes the race.
 */
export function attachTerminalRendererWhenSized(
  terminal: Terminal,
  container: HTMLElement,
  onAttached: (renderer: TerminalRenderer) => void,
  attemptsLeft = 30,
): () => void {
  let cancelled = false
  let frame = 0

  const tryAttach = () => {
    if (cancelled) return
    const rect = container.getBoundingClientRect()
    const ready = rect.width > 0 && rect.height > 0 && terminal.element
    if (!ready && attemptsLeft > 0) {
      attemptsLeft -= 1
      frame = requestAnimationFrame(tryAttach)
      return
    }
    onAttached(attachTerminalRenderer(terminal))
  }

  frame = requestAnimationFrame(tryAttach)
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
  }
}
