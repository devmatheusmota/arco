import { describe, expect, it } from 'vitest'

import {
  clampMascotPosition,
  deriveMascotState,
  detectSheetFrameCount,
  nextDragDirection,
} from './mascotState'

describe('deriveMascotState', () => {
  it('runs while any agent is working, even with an unseen completion', () => {
    expect(deriveMascotState(true, true)).toBe('running')
    expect(deriveMascotState(true, false)).toBe('running')
  })

  it('asks for attention only once everything is quiet', () => {
    expect(deriveMascotState(false, true)).toBe('attention')
  })

  it('idles otherwise', () => {
    expect(deriveMascotState(false, false)).toBe('idle')
  })
})

describe('nextDragDirection', () => {
  it('needs a 4px horizontal move to pick a direction', () => {
    expect(nextDragDirection(null, 3)).toEqual({ direction: null, accepted: false })
    expect(nextDragDirection(null, 4)).toEqual({ direction: 'right', accepted: true })
    expect(nextDragDirection(null, -4)).toEqual({ direction: 'left', accepted: true })
  })

  it('keeps the current direction on a sub-threshold move', () => {
    expect(nextDragDirection('right', -3)).toEqual({ direction: 'right', accepted: false })
    expect(nextDragDirection('left', 2)).toEqual({ direction: 'left', accepted: false })
  })

  it('flips when travel crosses the threshold the other way', () => {
    expect(nextDragDirection('right', -5)).toEqual({ direction: 'left', accepted: true })
  })
})

describe('detectSheetFrameCount', () => {
  it('detects a horizontal strip of square frames by aspect ratio', () => {
    expect(detectSheetFrameCount(384, 96)).toBe(4)
    expect(detectSheetFrameCount(768, 96)).toBe(8)
  })

  it('tolerates a stray pixel of padding', () => {
    expect(detectSheetFrameCount(385, 96)).toBe(4)
  })

  it('rejects plain images and degenerate sizes', () => {
    expect(detectSheetFrameCount(96, 96)).toBeNull()
    expect(detectSheetFrameCount(120, 96)).toBeNull()
    expect(detectSheetFrameCount(0, 96)).toBeNull()
    expect(detectSheetFrameCount(96, 0)).toBeNull()
    expect(detectSheetFrameCount(96 * 33, 96)).toBeNull()
  })
})

describe('clampMascotPosition', () => {
  const viewport = { width: 1000, height: 800 }

  it('keeps the mascot inside the viewport', () => {
    expect(clampMascotPosition({ x: -20, y: -20 }, 112, viewport)).toEqual({ x: 0, y: 0 })
    expect(clampMascotPosition({ x: 5000, y: 5000 }, 112, viewport)).toEqual({ x: 888, y: 688 })
  })

  it('pins to the origin when the viewport is smaller than the mascot', () => {
    expect(clampMascotPosition({ x: 50, y: 50 }, 112, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
    })
  })
})
