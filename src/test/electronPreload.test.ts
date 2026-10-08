import { createRequire } from 'node:module'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const preloadPath = require.resolve('../../electron/preload.cjs')

type Internals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number
  runCallback: (id: number, payload: unknown) => void
}

/** Loads the preload against a stub electron and hands back what it exposed. */
function loadPreload(env: Record<string, string> = {}) {
  const exposed: Record<string, unknown> = {}
  let deliver: ((payload: { event: string; payload: unknown }) => void) | null = null
  require.cache[require.resolve('electron')] = {
    loaded: true,
    exports: {
      contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => {
          exposed[key] = value
        },
      },
      ipcRenderer: {
        on: (_channel: string, listener: (event: unknown, payload: never) => void) => {
          deliver = (payload) => listener({}, payload as never)
        },
        invoke: async () => null,
      },
    },
  } as unknown as NodeJS.Module
  const saved = { ...process.env }
  Object.assign(process.env, env)
  delete require.cache[preloadPath]
  try {
    require(preloadPath)
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
  return {
    exposed,
    internals: exposed.__TAURI_INTERNALS__ as Internals,
    unregister: (
      exposed.__TAURI_EVENT_PLUGIN_INTERNALS__ as {
        unregisterListener: (event: string, eventId: number) => void
      }
    ).unregisterListener,
    emit: (event: string, payload: unknown) => deliver?.({ event, payload }),
  }
}

afterEach(() => {
  delete require.cache[preloadPath]
})

describe('preload event bridge', () => {
  it('delivers events to a listener until it unsubscribes, then lets the handler go', async () => {
    const { internals, unregister, emit } = loadPreload()
    const received: unknown[] = []
    const handlerId = internals.transformCallback((event) => received.push(event))
    const eventId = (await internals.invoke('plugin:event|listen', {
      event: 'pty://data/a',
      handler: handlerId,
    })) as number

    emit('pty://data/a', 'hello')
    expect(received).toHaveLength(1)

    unregister('pty://data/a', eventId)
    emit('pty://data/a', 'after')
    // The callback itself is gone too, not only the subscription.
    internals.runCallback(handlerId, 'direct')
    expect(received).toHaveLength(1)
  })

  it('survives the second unsubscribe the API sends for the same listener', async () => {
    const { internals, unregister } = loadPreload()
    const handlerId = internals.transformCallback(() => {})
    const eventId = (await internals.invoke('plugin:event|listen', {
      event: 'x',
      handler: handlerId,
    })) as number
    unregister('x', eventId)
    await expect(internals.invoke('plugin:event|unlisten', { event: 'x', eventId })).resolves.toBe(
      null,
    )
  })
})

describe('preload diagnostic switches', () => {
  it('exposes nothing by default', () => {
    const { exposed } = loadPreload()
    expect(exposed.__ARCO_KEY_TRACE__).toBeUndefined()
    expect(exposed.__ARCO_TERMINAL_RENDERER__).toBeUndefined()
  })

  it('turns the traces on from the environment the app started with', () => {
    const { exposed } = loadPreload({
      ARCO_KEY_TRACE: '1',
      ARCO_IPC_BENCH: '1',
      ARCO_TERMINAL_RENDERER: 'canvas',
    })
    expect(exposed.__ARCO_KEY_TRACE__).toBe(true)
    expect(exposed.__ARCO_IPC_BENCH__).toBe(true)
    expect(exposed.__ARCO_TERMINAL_RENDERER__).toBe('canvas')
  })

  it('ignores a renderer name it does not know', () => {
    const { exposed } = loadPreload({ ARCO_TERMINAL_RENDERER: 'vulkan' })
    expect(exposed.__ARCO_TERMINAL_RENDERER__).toBeUndefined()
  })
})
