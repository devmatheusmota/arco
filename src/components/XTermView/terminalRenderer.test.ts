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

const {
  attachTerminalRenderer,
  attachTerminalRendererWhenSized,
  detachTerminalRenderer,
  stopWebglCursorBlink,
} = await import('./terminalRenderer')

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

describe('detachTerminalRenderer', () => {
  it('hands the GPU context back instead of waiting for the canvas to be collected', () => {
    const loseContext = vi.fn()
    const terminal = fakeTerminal()
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    const canvas = document.createElement('canvas')
    canvas.getContext = (() => ({
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    })) as HTMLCanvasElement['getContext']
    screen.appendChild(canvas)
    terminal.element?.appendChild(screen)

    const renderer = attachTerminalRenderer(terminal)
    detachTerminalRenderer(renderer, terminal)

    expect(webglDispose).toHaveBeenCalledOnce()
    expect(loseContext).toHaveBeenCalledOnce()
  })
})

describe('the WebGL cursor blink timer', () => {
  /** The renderer keeps its blink state where the addon never disposes it. */
  function withBlinkState(addon: unknown, order: string[]) {
    const clear = vi.fn(() => order.push('blink stopped'))
    ;(addon as { _renderer: unknown })._renderer = { _cursorBlinkStateManager: { clear } }
    webglDispose.mockImplementation(() => order.push('addon disposed'))
    return clear
  }

  it('is stopped before the addon goes, when the pane releases its renderer', () => {
    const terminal = fakeTerminal()
    const renderer = attachTerminalRenderer(terminal)
    const order: string[] = []
    const clear = withBlinkState(renderer.addon, order)

    detachTerminalRenderer(renderer, terminal)

    expect(clear).toHaveBeenCalledOnce()
    expect(order).toEqual(['blink stopped', 'addon disposed'])
  })

  it('is stopped when the GPU context is lost', () => {
    const renderer = attachTerminalRenderer(fakeTerminal())
    const clear = withBlinkState(renderer.addon, [])

    lostContext?.()

    expect(clear).toHaveBeenCalledOnce()
  })

  it('does nothing on an addon that does not have one', () => {
    expect(() => stopWebglCursorBlink({})).not.toThrow()
    expect(() => stopWebglCursorBlink(null)).not.toThrow()
  })
})

// Last: the failure is remembered for the rest of the page.
describe('a WebGL setup that failed', () => {
  it('is not tried again on the next attach', () => {
    const failing = fakeTerminal()
    vi.mocked(failing.loadAddon).mockImplementationOnce(() => {
      throw new Error('WebGL2 not supported')
    })
    expect(attachTerminalRenderer(failing).kind).toBe('canvas')
    const triesBefore = webglConstructed

    expect(attachTerminalRenderer(fakeTerminal()).kind).toBe('canvas')
    expect(webglConstructed).toBe(triesBefore)
  })
})
