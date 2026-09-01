import { useEffect, useState } from 'react'

// One timer for every relative timestamp on screen.
//
// A row that says "12 min" has to notice when it becomes "13 min", but a timer
// per row means fifteen of them in the sidebar alone, all waking at different
// moments. This is a single interval with a subscriber list: the rows re-render
// together, once a minute, and nothing ticks while none are mounted.

const TICK_MS = 60_000

const subscribers = new Set<(tick: number) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let tick = 0

function start() {
  if (timer) return
  timer = setInterval(() => {
    tick += 1
    for (const notify of subscribers) notify(tick)
  }, TICK_MS)
}

function stop() {
  if (!timer || subscribers.size > 0) return
  clearInterval(timer)
  timer = null
}

/** Re-renders once a minute, so a relative timestamp does not go stale in place. */
export function useRelativeTick(): number {
  const [value, setValue] = useState(tick)

  useEffect(() => {
    subscribers.add(setValue)
    start()
    return () => {
      subscribers.delete(setValue)
      stop()
    }
  }, [])

  return value
}
