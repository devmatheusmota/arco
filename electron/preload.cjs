// Implements the contract `@tauri-apps/api` expects, so the existing frontend
// runs on Electron untouched: it keeps calling `invoke()` and `listen()`, and
// those land on Electron IPC instead of Tauri's.
//
// The pieces the API actually touches are `window.__TAURI_INTERNALS__`
// (`invoke`, `transformCallback`) and `window.__TAURI_EVENT_PLUGIN_INTERNALS__`
// (`unregisterListener`). Event subscription itself arrives as the internal
// command `plugin:event|listen`, which is handled here rather than in the main
// process, since the handler is a function living in this page.

const { contextBridge, ipcRenderer } = require('electron')

let nextCallbackId = 1
const callbacks = new Map()

let nextEventId = 1
/** event name -> Map<eventId, {handlerId, once}> */
const listeners = new Map()

function transformCallback(callback, once = false) {
  const id = nextCallbackId++
  callbacks.set(id, { callback, once })
  return id
}

function runCallback(id, payload) {
  const entry = callbacks.get(id)
  if (!entry) return
  if (entry.once) callbacks.delete(id)
  entry.callback(payload)
}

function addListener(event, handlerId) {
  const eventId = nextEventId++
  if (!listeners.has(event)) listeners.set(event, new Map())
  listeners.get(event).set(eventId, handlerId)
  return eventId
}

function removeListener(event, eventId) {
  const forEvent = listeners.get(event)
  if (!forEvent) return
  forEvent.delete(eventId)
  if (forEvent.size === 0) listeners.delete(event)
}

// The main process emits {event, payload}; deliver it in the shape the API's
// `listen` handler expects.
ipcRenderer.on('tauri:event', (_ipcEvent, { event, payload }) => {
  const forEvent = listeners.get(event)
  if (!forEvent) return
  for (const [eventId, handlerId] of forEvent) {
    runCallback(handlerId, { event, id: eventId, payload })
  }
})

async function invoke(cmd, args = {}) {
  if (cmd === 'plugin:event|listen') {
    return addListener(args.event, args.handler)
  }
  if (cmd === 'plugin:event|unlisten') {
    removeListener(args.event, args.eventId)
    return null
  }
  const response = await ipcRenderer.invoke('tauri:invoke', { cmd, args })
  if (response && response.__error) throw new Error(response.__error)
  return response
}

contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {
  invoke,
  transformCallback,
  runCallback,
  // Tauri exposes these for asset loading; the Electron build serves files
  // straight from disk.
  convertFileSrc: (filePath, protocol = 'asset') => `${protocol}://localhost/${filePath}`,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
})

contextBridge.exposeInMainWorld('__TAURI_EVENT_PLUGIN_INTERNALS__', {
  unregisterListener: (event, eventId) => removeListener(event, eventId),
})

// Marks the shell for code that needs to branch on it.
contextBridge.exposeInMainWorld('__ARCO_SHELL__', 'electron')

// Window dragging.
//
// The title bar is custom (the window is frameless) and marks its draggable
// areas with `data-tauri-drag-region`, which Tauri understands natively and
// Chromium does not. Mapping those same elements to the CSS drag region keeps
// one source of truth in the markup: interactive children opt out, or they
// would stop receiving clicks.
const DRAG_STYLE = `
  [data-tauri-drag-region] { -webkit-app-region: drag; }
  [data-tauri-drag-region] button,
  [data-tauri-drag-region] input,
  [data-tauri-drag-region] select,
  [data-tauri-drag-region] textarea,
  [data-tauri-drag-region] a,
  [data-tauri-drag-region] [role="button"],
  [data-tauri-drag-region] [role="tab"],
  [data-tauri-drag-region] [data-no-drag] { -webkit-app-region: no-drag; }
`

window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style')
  style.textContent = DRAG_STYLE
  document.head.append(style)
})
