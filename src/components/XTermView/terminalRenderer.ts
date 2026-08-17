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

/** Attaches the fastest renderer this WebView can provide. */
export function attachTerminalRenderer(terminal: Terminal): TerminalRenderer {
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
