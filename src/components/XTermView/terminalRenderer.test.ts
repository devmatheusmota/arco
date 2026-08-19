import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const webglDispose = vi.fn()
let lostContext: (() => void) | null = null
let webglConstructed = 0

class FakeWebglAddon {
  constructor() {
    webglConstructed += 1
  }
  onContextLoss(handler: () => void) {
    lostContext = handler
  }
  dispose = webglDispose
  activate() {}
}

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }))
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: class {} }))
vi.mock('../../lib/tauri', () => ({ recordAppEvent: vi.fn(() => Promise.resolve()) }))

const { attachTerminalRenderer, attachTerminalRendererWhenSized } =
  await import('./terminalRenderer')

function fakeTerminal(): Terminal {
  return { loadAddon: vi.fn(), element: document.createElement('div') } as unknown as Terminal
}

function fakeContainer(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height }) as DOMRect,
  } as unknown as HTMLElement
}

beforeEach(() => {
  webglDispose.mockClear()
  lostContext = null
  webglConstructed = 0
  // Run the retry loop synchronously so the attempt budget is what ends it.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

describe('attachTerminalRenderer', () => {
  it('tells the owner to forget the renderer when the context is lost', () => {
    const onContextLoss = vi.fn()
    const renderer = attachTerminalRenderer(fakeTerminal(), onContextLoss)

    expect(renderer.kind).toBe('webgl')
    lostContext?.()

    expect(webglDispose).toHaveBeenCalledOnce()
    expect(onContextLoss).toHaveBeenCalledOnce()
  })
})

describe('attachTerminalRendererWhenSized', () => {
  it('attaches once the pane has a size', () => {
    const settled = vi.fn()
    attachTerminalRendererWhenSized(fakeTerminal(), fakeContainer(400, 200), settled)

    expect(settled).toHaveBeenCalledOnce()
    expect(settled.mock.calls[0][0]).toMatchObject({ kind: 'webgl' })
  })

  it('gives up instead of binding a GPU context to a pane that never got one', () => {
    const settled = vi.fn()
    attachTerminalRendererWhenSized(fakeTerminal(), fakeContainer(0, 0), settled, { attempts: 3 })

    expect(settled).toHaveBeenCalledExactlyOnceWith(null)
    expect(webglConstructed).toBe(0)
  })

  it('settles nothing once cancelled', () => {
    const settled = vi.fn()
    // A container that only gets a size later: the first frame finds it at 0x0.
    let width = 0
    const container = {
      getBoundingClientRect: () => ({ width, height: 200 }) as DOMRect,
    } as unknown as HTMLElement
    vi.stubGlobal('requestAnimationFrame', () => 1)

    const cancel = attachTerminalRendererWhenSized(fakeTerminal(), container, settled)
    cancel()
    width = 400

    expect(settled).not.toHaveBeenCalled()
  })
})
