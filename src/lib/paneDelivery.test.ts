import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const chunked = vi.fn<(id: string, text: string, bracketed: boolean) => Promise<void>>(() =>
  Promise.resolve(),
)
vi.mock('../components/XTermView/terminalWrite', () => ({
  writePtyChunked: (id: string, text: string, bracketed: boolean) => chunked(id, text, bracketed),
}))

const writes: Array<{ id: string; data: string }> = []
vi.mock('./tauri', () => ({
  writePty: (id: string, data: string) => {
    writes.push({ id, data })
    return Promise.resolve()
  },
}))

const armed: Array<{ ptyId: string; data: string }> = []
vi.mock('./activityTracker', () => ({
  recordAgentActivityInput: (ptyId: string, data: string) => armed.push({ ptyId, data }),
}))

const ios: string[] = []
vi.mock('../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ recordIo: (ptyId: string) => ios.push(ptyId) }) },
}))

const { deliverToPty } = await import('./paneDelivery')

/** Runs a delivery to completion, including the submit that trails it. */
async function deliver(text: string, ptyId = 'pty-1') {
  const done = deliverToPty(ptyId, text)
  await vi.advanceTimersByTimeAsync(2_000)
  await done
}

beforeEach(() => {
  vi.useFakeTimers()
  chunked.mockClear()
  chunked.mockImplementation(() => Promise.resolve())
  writes.length = 0
  armed.length = 0
  ios.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('deliverToPty', () => {
  it('pastes the text in brackets and submits it twice', async () => {
    await deliver('rodar os testes')

    expect(chunked).toHaveBeenCalledWith('pty-1', 'rodar os testes', true)
    expect(writes).toEqual([
      { id: 'pty-1', data: '\r' },
      { id: 'pty-1', data: '\r' },
    ])
  })

  // Bracketed paste is the safety net for a pane that turns out to be mid-turn:
  // the text lands in the composer instead of executing a line at a time.
  it('always pastes in brackets, including a multi-line message', async () => {
    await deliver('primeira linha\nsegunda linha')

    expect(chunked.mock.calls[0][2]).toBe(true)
  })

  it('holds the second submit back so it lands after the first is absorbed', async () => {
    const done = deliverToPty('pty-1', 'oi')
    await vi.advanceTimersByTimeAsync(200)
    expect(writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_300)
    await done
    expect(writes).toHaveLength(2)
  })

  // The monitor arms from `handleInput`, whose only caller is `terminal.onData`
  // — so before this the pane read `waiting` while the agent worked.
  it('arms the completion monitor as if the text had been typed', async () => {
    await deliver('revisar o PR 11132')

    expect(armed).toEqual([{ ptyId: 'pty-1', data: 'revisar o PR 11132\r' }])
  })

  it('arms with the first line only, which is what an echo looks like', async () => {
    await deliver(`${'a'.repeat(500)}\nresto`)

    expect(armed[0].data).toBe(`${'a'.repeat(200)}\r`)
  })

  it('skips the arming when there is nothing that reads as a prompt', async () => {
    await deliver('   \n  ')

    expect(armed).toEqual([])
    expect(writes).toHaveLength(2)
  })

  it('records the I/O so a caller watching for silence does not fire again', async () => {
    await deliver('oi')

    expect(ios).toEqual(['pty-1'])
  })

  it('throws what the write threw, without submitting', async () => {
    chunked.mockImplementation(() => Promise.reject(new Error('pty morto')))

    await expect(deliverToPty('pty-1', 'oi')).rejects.toThrow('pty morto')
    expect(writes).toEqual([])
    expect(armed).toEqual([])
  })
})
