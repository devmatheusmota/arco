import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const delivered: Array<{ ptyId: string; text: string }> = []
const deliverMock = vi.fn<(ptyId: string, text: string) => Promise<void>>()
vi.mock('../lib/paneDelivery', () => ({
  deliverToPty: (ptyId: string, text: string) => deliverMock(ptyId, text),
}))

type Pane = {
  id: string
  disabled?: boolean
  activeTabId: string
  tabs: Array<{ id: string; ptyId: string | null }>
}
const projects: Array<{ id: string; terminals: Pane[] }> = [{ id: 'p1', terminals: [] }]
// `preferences.language` is here because the toasts go through `t()`, which
// reads the locale off this same store.
vi.mock('./projectsStore', () => ({
  useProjectsStore: { getState: () => ({ projects, preferences: { language: 'pt-BR' } }) },
}))

type Runtime = { status: string; alive: boolean; parked: boolean; lastIoAt: number }
// Reassigned rather than mutated, the way zustand replaces the map on every
// update — a test that mutates in place cannot tell a stale snapshot apart from
// a fresh read, because both point at the same object.
let byPtyId: Record<string, Runtime> = {}
const setRuntime = (ptyId: string, patch: Partial<Runtime>) => {
  byPtyId = { ...byPtyId, [ptyId]: { ...byPtyId[ptyId], ...patch } as Runtime }
}
vi.mock('./terminalsStore', () => ({ useTerminalsStore: { getState: () => ({ byPtyId }) } }))

const toasts: Array<{ title: string; body: string }> = []
vi.mock('./uiStore', () => ({
  useUiStore: {
    getState: () => ({
      pushToast: (toast: { title: string; body: string }) => toasts.push(toast),
    }),
  },
}))

const { usePaneInboxStore, dropPaneInbox, DRAIN_TICK_MS, MESSAGE_TTL_MS } =
  await import('./paneInboxStore')

/** A pane the drain can resolve, idle and quiet enough to accept a delivery. */
function readyPane(id = 'pane-1', ptyId = 'pty-1') {
  projects[0].terminals = [{ id, activeTabId: `${id}-tab`, tabs: [{ id: `${id}-tab`, ptyId }] }]
  setRuntime(ptyId, { status: 'waiting', alive: true, parked: false, lastIoAt: 0 })
}

const pending = (id = 'pane-1') => usePaneInboxStore.getState().byTerminalId[id] ?? []

// Fake timers stay on for the whole file. The drain's interval id lives in the
// module, so swapping the timer implementation between tests would leave it
// holding an id that no longer exists and never starting again.
beforeAll(() => {
  vi.useFakeTimers()
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(async () => {
  usePaneInboxStore.setState({ byTerminalId: {} })
  projects[0].terminals = []
  byPtyId = {}
  deliverMock.mockReset()
  deliverMock.mockImplementation((ptyId, text) => {
    delivered.push({ ptyId, text })
    return Promise.resolve()
  })
  // Let a drain left running by the previous test see the empty queue and stop.
  await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 2)
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'))
  delivered.length = 0
  toasts.length = 0
})

describe('enqueue', () => {
  it('keeps the order things were sent in and reports the place in line', () => {
    const first = usePaneInboxStore.getState().enqueue('pane-1', 'primeira')
    const second = usePaneInboxStore.getState().enqueue('pane-1', 'segunda')

    expect([first.position, second.position]).toEqual([1, 2])
    expect(pending().map((message) => message.text)).toEqual(['primeira', 'segunda'])
  })

  it('keeps one queue per pane', () => {
    usePaneInboxStore.getState().enqueue('pane-1', 'a')
    usePaneInboxStore.getState().enqueue('pane-2', 'b')

    expect(pending('pane-1')).toHaveLength(1)
    expect(pending('pane-2')).toHaveLength(1)
  })
})

describe('the drain timer', () => {
  // A listener on the runtime store would wake up on every chunk of agent
  // output; a timer that only exists while something is queued costs nothing
  // in the normal case, which is an empty queue.
  it('is not running until something is queued, and stops once the queue empties', async () => {
    expect(vi.getTimerCount()).toBe(0)

    readyPane()
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)
    expect(delivered).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('when the drain delivers', () => {
  it('hands an idle pane its message', async () => {
    readyPane()
    usePaneInboxStore.getState().enqueue('pane-1', 'roda os testes')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)

    expect(delivered).toEqual([{ ptyId: 'pty-1', text: 'roda os testes' }])
    expect(pending()).toHaveLength(0)
  })

  it('delivers one item per tick, not the whole queue at once', async () => {
    readyPane()
    usePaneInboxStore.getState().enqueue('pane-1', 'primeira')
    usePaneInboxStore.getState().enqueue('pane-1', 'segunda')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)
    expect(delivered.map((item) => item.text)).toEqual(['primeira'])

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)
    expect(delivered.map((item) => item.text)).toEqual(['primeira', 'segunda'])
  })

  it('does not start a second delivery while one is still in flight', async () => {
    readyPane()
    let release = () => {}
    deliverMock.mockImplementationOnce((ptyId, text) => {
      delivered.push({ ptyId, text })
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    usePaneInboxStore.getState().enqueue('pane-1', 'primeira')
    usePaneInboxStore.getState().enqueue('pane-1', 'segunda')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 3)
    expect(delivered).toHaveLength(1)

    release()
    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)
    expect(delivered).toHaveLength(2)
  })
})

describe('when the drain holds back', () => {
  // The status is re-read per pane, not snapshotted for the whole pass: the
  // delivery above is awaited, and a pane that went to work during it would
  // still look idle in a picture taken before that happened.
  it('notices a pane that went to work while an earlier delivery was in flight', async () => {
    projects[0].terminals = [
      { id: 'pane-1', activeTabId: 't1', tabs: [{ id: 't1', ptyId: 'pty-1' }] },
      { id: 'pane-2', activeTabId: 't2', tabs: [{ id: 't2', ptyId: 'pty-2' }] },
    ]
    setRuntime('pty-1', { status: 'waiting', alive: true, parked: false, lastIoAt: 0 })
    setRuntime('pty-2', { status: 'waiting', alive: true, parked: false, lastIoAt: 0 })
    deliverMock.mockImplementationOnce((ptyId, text) => {
      delivered.push({ ptyId, text })
      setRuntime('pty-2', { status: 'working' })
      return Promise.resolve()
    })
    usePaneInboxStore.getState().enqueue('pane-1', 'para o primeiro')
    usePaneInboxStore.getState().enqueue('pane-2', 'para o segundo')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)

    expect(delivered.map((item) => item.ptyId)).toEqual(['pty-1'])
    expect(pending('pane-2')).toHaveLength(1)
  })

  it('waits while the agent is working', async () => {
    readyPane()
    setRuntime('pty-1', { status: 'working' })
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 4)
    expect(delivered).toEqual([])

    setRuntime('pty-1', { status: 'waiting' })
    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)
    expect(delivered).toHaveLength(1)
  })

  it('waits out the silence window after the last byte moved', async () => {
    readyPane()
    setRuntime('pty-1', { lastIoAt: Date.now() })
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)
    expect(delivered).toEqual([])

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 2)
    expect(delivered).toHaveLength(1)
  })

  // A pane that has not been on screen since the app started has no process at
  // all. That is the normal state of most of the list, not a reason to refuse.
  it('holds a message for a pane whose process has not been spawned yet', async () => {
    projects[0].terminals = [
      { id: 'pane-1', activeTabId: 'tab', tabs: [{ id: 'tab', ptyId: null }] },
    ]
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 4)
    expect(delivered).toEqual([])
    expect(pending()).toHaveLength(1)
  })

  it('leaves a parked or dead runtime alone', async () => {
    readyPane()
    setRuntime('pty-1', { parked: true })
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')
    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 2)
    expect(delivered).toEqual([])

    setRuntime('pty-1', { parked: false, alive: false })
    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 2)
    expect(delivered).toEqual([])
  })

  it('waits while the pane is disabled, because that is reversible', async () => {
    readyPane()
    projects[0].terminals[0].disabled = true
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS * 2)
    expect(delivered).toEqual([])
    expect(pending()).toHaveLength(1)
  })
})

describe('when the message has nowhere to go', () => {
  it('forgets the queue of a pane that no longer exists', async () => {
    usePaneInboxStore.getState().enqueue('sumiu', 'oi')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)

    expect(usePaneInboxStore.getState().byTerminalId).toEqual({})
    expect(delivered).toEqual([])
    // The command line answered `ok` when this was queued, so a silent drop
    // would leave whoever sent it believing the message landed.
    expect(toasts[0].body).toMatch(/1 mensagem\(ns\) esperavam o pane sumiu/)
  })

  // Reinjecting an instruction written half an hour ago into whatever the agent
  // is doing now is worse than losing it.
  it('drops a message that has waited past its time to live', async () => {
    projects[0].terminals = [
      { id: 'pane-1', activeTabId: 'tab', tabs: [{ id: 'tab', ptyId: null }] },
    ]
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')

    vi.setSystemTime(Date.now() + MESSAGE_TTL_MS + 1)
    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)

    expect(pending()).toHaveLength(0)
    expect(delivered).toEqual([])
    expect(toasts[0].body).toMatch(/esperaram mais de meia hora/)
  })

  it('says so instead of losing a delivery in silence', async () => {
    readyPane()
    deliverMock.mockImplementation(() => Promise.reject(new Error('pty morto')))
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')

    await vi.advanceTimersByTimeAsync(DRAIN_TICK_MS)

    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('Mensagem não entregue')
    expect(toasts[0].body).toMatch(/pty morto/)
    // Not retried: the failed write already put bytes in the composer, and
    // pasting over them is worse than losing the message.
    expect(pending()).toHaveLength(0)
  })
})

describe('dropPaneInbox', () => {
  it('forgets what was waiting for a pane that is going away', () => {
    usePaneInboxStore.getState().enqueue('pane-1', 'oi')
    usePaneInboxStore.getState().enqueue('pane-2', 'tchau')

    dropPaneInbox('pane-1')

    expect(pending('pane-1')).toHaveLength(0)
    expect(pending('pane-2')).toHaveLength(1)
  })
})
