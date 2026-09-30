import { useEffect, useMemo, useRef, useState } from 'react'

import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import styles from './MascotOverlay.module.css'
import {
  clampMascotPosition,
  deriveMascotState,
  detectSheetFrameCount,
  type MascotDragDirection,
  type MascotPosition,
  nextDragDirection,
} from './mascotState'
import { resolvePetUrl } from './pets'

const MASCOT_SIZE = 112
const SHEET_FPS = 8
const POSITION_STORAGE_KEY = 'arco.mascotPosition'

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

function defaultPosition(): MascotPosition {
  return clampMascotPosition(
    { x: window.innerWidth - MASCOT_SIZE - 24, y: window.innerHeight - MASCOT_SIZE - 24 },
    MASCOT_SIZE,
    viewport(),
  )
}

function loadStoredPosition(): MascotPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MascotPosition>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return clampMascotPosition({ x: parsed.x, y: parsed.y }, MASCOT_SIZE, viewport())
  } catch {
    return null
  }
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden')
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return hidden
}

type DragSession = {
  pointerId: number
  originX: number
  originY: number
  startClientX: number
  startClientY: number
  /** Baseline for direction detection; advances on each accepted move. */
  baselineX: number
  direction: MascotDragDirection
}

function MascotOverlayInner() {
  const petId = useProjectsStore((s) => s.preferences.mascotPet)
  const customImage = useProjectsStore((s) => s.preferences.mascotCustomImage)
  // Boolean-returning selectors so the throttled per-pane IO updates in the
  // terminals store only re-render the mascot when the aggregate flips.
  const hasWorking = useTerminalsStore((s) => {
    for (const runtime of Object.values(s.byPtyId)) {
      if (runtime.alive && runtime.status === 'working') return true
    }
    return false
  })
  const hasUnread = useProjectsStore((s) => {
    for (const project of s.projects) {
      for (const terminal of project.terminals) {
        for (const tab of terminal.tabs) {
          if (tab.completionUnread) return true
        }
      }
    }
    return false
  })
  const documentHidden = useDocumentHidden()

  const url = resolvePetUrl(petId, customImage)
  const isCustom = petId === 'custom' && Boolean(customImage)
  const agentState = deriveMascotState(hasWorking, hasUnread)

  const [position, setPosition] = useState<MascotPosition>(
    () => loadStoredPosition() ?? defaultPosition(),
  )
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const positionRef = useRef(position)
  positionRef.current = position
  const dragRef = useRef<DragSession | null>(null)

  const [sheetFrames, setSheetFrames] = useState<number | null>(null)
  useEffect(() => {
    if (!isCustom) {
      setSheetFrames(null)
      return
    }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled) setSheetFrames(detectSheetFrameCount(image.naturalWidth, image.naturalHeight))
    }
    image.onerror = () => {
      if (!cancelled) setSheetFrames(null)
    }
    image.src = url
    return () => {
      cancelled = true
    }
  }, [isCustom, url])

  useEffect(() => {
    const onResize = () => setPosition((prev) => clampMascotPosition(prev, MASCOT_SIZE, viewport()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      originX: positionRef.current.x,
      originY: positionRef.current.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      baselineX: e.clientX,
      direction: null,
    }
    setDragging(true)
  }

  // Moves write transform and direction straight to the DOM node: no React
  // render per pointer event. State reconciles once, on release.
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const el = rootRef.current
    if (!drag || drag.pointerId !== e.pointerId || !el) return
    const next = clampMascotPosition(
      {
        x: drag.originX + (e.clientX - drag.startClientX),
        y: drag.originY + (e.clientY - drag.startClientY),
      },
      MASCOT_SIZE,
      viewport(),
    )
    positionRef.current = next
    el.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
    const { direction, accepted } = nextDragDirection(drag.direction, e.clientX - drag.baselineX)
    if (accepted) drag.baselineX = e.clientX
    if (direction !== drag.direction) {
      drag.direction = direction
      if (direction) el.dataset.dragDir = direction
      else delete el.dataset.dragDir
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const el = rootRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (el) delete el.dataset.dragDir
    setDragging(false)
    setPosition(positionRef.current)
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positionRef.current))
    } catch {
      // A blocked storage only loses the position across restarts.
    }
  }

  const sheetKeyframes = useMemo(() => {
    if (!sheetFrames) return null
    return `@keyframes arco-mascot-sheet-${sheetFrames} { from { background-position: 0 0; } to { background-position: ${-sheetFrames * MASCOT_SIZE}px 0; } }`
  }, [sheetFrames])

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={styles.root}
      data-state={agentState}
      data-dragging={dragging || undefined}
      data-paused={documentHidden || undefined}
      style={{
        width: MASCOT_SIZE,
        height: MASCOT_SIZE,
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className={styles.bob}>
        {isCustom && sheetFrames ? (
          <>
            <style>{sheetKeyframes}</style>
            <div
              className={styles.sheet}
              style={{
                backgroundImage: `url(${url})`,
                backgroundSize: `${sheetFrames * MASCOT_SIZE}px ${MASCOT_SIZE}px`,
                animation: `arco-mascot-sheet-${sheetFrames} ${sheetFrames / SHEET_FPS}s steps(${sheetFrames}) infinite`,
              }}
            />
          </>
        ) : (
          <img className={styles.sprite} src={url} alt="" draggable={false} />
        )}
      </div>
      {agentState === 'attention' ? <span className={styles.dot} /> : null}
    </div>
  )
}

export function MascotOverlay() {
  const enabled = useProjectsStore((s) => s.preferences.enabledFeatures.mascot)
  if (!enabled) return null
  return <MascotOverlayInner />
}
