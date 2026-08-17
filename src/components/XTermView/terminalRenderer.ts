import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * GPU renderer for a pane.
 *
 * xterm.js falls back to a DOM renderer that builds one element per cell. That
 * is what makes scrolling crawl once a workspace holds several panes with a
 * large scrollback: every frame walks thousands of nodes on the main thread.
 *
 * The renderer is attached per pane rather than once per terminal because a
 * WebView caps how many live WebGL contexts a page may hold (Chromium drops the
 * oldest past ~16). Panes that are off screen do not need acceleration, so
 * binding the context to visibility keeps the count at what is actually on
 * screen and leaves the eviction path unused.
 */

/** Attaches the GPU renderer, or returns null when the WebView cannot provide one. */
export function attachWebglRenderer(terminal: Terminal): WebglAddon | null {
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
    return addon
  } catch (error) {
    console.warn('[xterm-renderer] WebGL unavailable; falling back to the DOM renderer', error)
    return null
  }
}

/** Releases the GPU context. Safe to call on an addon that already lost it. */
export function detachWebglRenderer(addon: WebglAddon | null): null {
  if (!addon) return null
  try {
    addon.dispose()
  } catch {}
  return null
}
