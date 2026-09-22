/**
 * Where the panes of a project sit on screen, and which one is next to which.
 *
 * `ProjectContainer` and `PaneStack` draw from these, and the pane shortcuts
 * navigate by them, so the keyboard moves through the same layout the eye sees
 * without reading the DOM for it.
 */

import type { PaneDirection } from './keybindings'
import type { Terminal, WorkspaceContainer } from './types'

export type PanesOnScreen = {
  /** The session the container holds as active, which picks the front on screen. */
  activePane: Terminal | null
  /** The sessions of that front, in container order. */
  visibleIds: string[]
  /** The terminal beside them, when there is one. */
  sidePane: Terminal | null
}

/**
 * The front on screen is the one the active session belongs to, so the two never
 * disagree and nothing has to be stored to keep them in step.
 *
 * `panes` are the container's sessions, in its order.
 */
export function panesOnScreen(panes: Terminal[], container: WorkspaceContainer): PanesOnScreen {
  const activePane =
    panes.find((terminal) => terminal.id === container.activePaneId) ?? panes[0] ?? null
  const activeGroupId = activePane?.groupId ?? null
  const visibleIds = (
    activeGroupId
      ? panes.filter((terminal) => terminal.groupId === activeGroupId)
      : // A pane with no group is on its own until the next load adopts it.
        panes.filter((terminal) => terminal.id === activePane?.id)
  ).map((terminal) => terminal.id)
  const sidePane =
    container.sidePaneId && container.sidePaneId !== activePane?.id
      ? (panes.find((terminal) => terminal.id === container.sidePaneId) ?? null)
      : null
  return { activePane, visibleIds, sidePane }
}

export type GridCell = { left: number; top: number; width: number; height: number }

/**
 * Cells for `count` panes, in percent of the stack.
 *
 * A grid, not a row: four sessions side by side are four columns nobody can
 * read. Squaring off keeps every pane wide enough to hold a line of output, and
 * the last row spreads across whatever it has so no cell is left empty.
 */
export function paneGridCells(count: number): GridCell[] {
  const total = Math.max(1, count)
  const columns = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / columns)
  const height = 100 / rows
  const cells: GridCell[] = []
  for (let index = 0; index < total; index += 1) {
    const row = Math.floor(index / columns)
    const inRow = Math.min(columns, total - row * columns)
    const width = 100 / inRow
    cells.push({ left: (index - row * columns) * width, top: row * height, width, height })
  }
  return cells
}

export type PaneRect = { id: string; left: number; top: number; right: number; bottom: number }

// The side terminal opens at 35% and can be dragged; only its being to the right
// of the whole stack matters for finding neighbours, not its width.
const STACK_SHARE = 65

/** The panes on screen as rectangles in one 100×100 space: the grid, then the side. */
export function paneRects(stackIds: string[], sideId: string | null): PaneRect[] {
  const share = sideId ? STACK_SHARE : 100
  const cells = paneGridCells(stackIds.length)
  const rects = stackIds.map((id, index) => {
    const cell = cells[index]
    const left = (cell.left * share) / 100
    return {
      id,
      left,
      right: left + (cell.width * share) / 100,
      top: cell.top,
      bottom: cell.top + cell.height,
    }
  })
  if (sideId) rects.push({ id: sideId, left: share, right: 100, top: 0, bottom: 100 })
  return rects
}

const EDGE_TOLERANCE = 0.01

/**
 * The pane next to `currentId` in `direction`, or null at the edge — moving
 * past the last pane does not wrap around to the other side.
 *
 * The closest pane that shares a stretch of edge with the current one wins; a
 * tie goes to the one aligned best, then to the first in layout order.
 */
export function paneInDirection(
  rects: PaneRect[],
  currentId: string | null,
  direction: PaneDirection,
): string | null {
  const from = rects.find((rect) => rect.id === currentId)
  if (!from) return rects[0]?.id ?? null
  const horizontal = direction === 'left' || direction === 'right'
  let best: { id: string; gap: number; overlap: number; offset: number } | null = null
  for (const rect of rects) {
    if (rect.id === from.id) continue
    const gap =
      direction === 'left'
        ? from.left - rect.right
        : direction === 'right'
          ? rect.left - from.right
          : direction === 'up'
            ? from.top - rect.bottom
            : rect.top - from.bottom
    if (gap < -EDGE_TOLERANCE) continue
    const overlap = horizontal
      ? Math.min(from.bottom, rect.bottom) - Math.max(from.top, rect.top)
      : Math.min(from.right, rect.right) - Math.max(from.left, rect.left)
    if (overlap <= EDGE_TOLERANCE) continue
    const offset = horizontal
      ? Math.abs((from.top + from.bottom) / 2 - (rect.top + rect.bottom) / 2)
      : Math.abs((from.left + from.right) / 2 - (rect.left + rect.right) / 2)
    const better =
      !best ||
      gap < best.gap - EDGE_TOLERANCE ||
      (Math.abs(gap - best.gap) <= EDGE_TOLERANCE &&
        (offset < best.offset - EDGE_TOLERANCE ||
          (Math.abs(offset - best.offset) <= EDGE_TOLERANCE &&
            overlap > best.overlap + EDGE_TOLERANCE)))
    if (better) best = { id: rect.id, gap, overlap, offset }
  }
  return best?.id ?? null
}

/** The pane `step` places after `currentId` in `ids`, wrapping at both ends. */
export function paneInCycle(ids: string[], currentId: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const index = currentId ? ids.indexOf(currentId) : -1
  if (index === -1) return ids[0]
  return ids[(index + step + ids.length) % ids.length]
}
