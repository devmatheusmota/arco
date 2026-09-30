// Pure mascot logic, kept out of the component so it is unit-testable without
// mounting the overlay or a DOM.

export type MascotAgentState = 'idle' | 'running' | 'attention'

/**
 * Aggregate agent activity into one mascot mood. A working agent wins: the
 * mascot runs while anything is still going. With everything quiet, an unseen
 * completion asks for attention; otherwise the mascot idles.
 */
export function deriveMascotState(hasWorking: boolean, hasUnread: boolean): MascotAgentState {
  if (hasWorking) return 'running'
  if (hasUnread) return 'attention'
  return 'idle'
}

export type MascotDragDirection = 'left' | 'right' | null

/**
 * Direction tracks horizontal travel only. `accepted` (advance the baseline)
 * fires only on a >=4px horizontal move so slow diagonal drags still
 * accumulate instead of resetting on every pointer event.
 */
export function nextDragDirection(
  current: MascotDragDirection,
  deltaX: number,
): { direction: MascotDragDirection; accepted: boolean } {
  if (deltaX >= 4) return { direction: 'right', accepted: true }
  if (deltaX <= -4) return { direction: 'left', accepted: true }
  return { direction: current, accepted: false }
}

/**
 * A custom upload whose width is an integer multiple of its height is treated
 * as a horizontal strip of square frames and animated with CSS steps(). The
 * 1% tolerance absorbs sheets exported with a stray pixel of padding.
 */
export function detectSheetFrameCount(width: number, height: number): number | null {
  if (width <= 0 || height <= 0) return null
  const ratio = width / height
  const frames = Math.round(ratio)
  if (frames < 2 || frames > 32) return null
  if (Math.abs(ratio - frames) > frames * 0.01) return null
  return frames
}

export type MascotPosition = { x: number; y: number }

export function clampMascotPosition(
  pos: MascotPosition,
  size: number,
  viewport: { width: number; height: number },
): MascotPosition {
  return {
    x: Math.min(Math.max(0, pos.x), Math.max(0, viewport.width - size)),
    y: Math.min(Math.max(0, pos.y), Math.max(0, viewport.height - size)),
  }
}
