import { BOARD_MAX, BOARD_MIN, type Cell } from '@/src/game/types'

/**
 * Board geometry for the pannable board. An `Offset` is the screen position (px, relative to the
 * viewport's top-left corner) of cell (0,0)'s top-left corner; cell (x,y) is drawn at
 * (x * cellSize + offset.x, y * cellSize + offset.y).
 */
export type Offset = { x: number; y: number }

export const CELL_PX = 32
/** A pointer that moved less than this (px) between down and up is a tap; otherwise a pan. */
export const TAP_SLOP_PX = 8

const onBoard = (v: number) => v >= BOARD_MIN && v <= BOARD_MAX

/** The board cell under a viewport point, or null beyond the board edge. */
export function cellAtPoint(px: number, py: number, offset: Offset, cellSize: number): Cell | null {
  const x = Math.floor((px - offset.x) / cellSize)
  const y = Math.floor((py - offset.y) / cellSize)
  return onBoard(x) && onBoard(y) ? { x, y } : null
}

/** The offset that puts the center of `cell` in the middle of the viewport. */
export function offsetToCenterOn(cell: Cell, viewportW: number, viewportH: number, cellSize: number): Offset {
  return {
    x: viewportW / 2 - (cell.x + 0.5) * cellSize,
    y: viewportH / 2 - (cell.y + 0.5) * cellSize,
  }
}

/** Keeps the viewport center on the board: at most half a viewport of space shows beyond an edge. */
export function clampOffset(offset: Offset, viewportW: number, viewportH: number, cellSize: number): Offset {
  const clamp = (v: number, half: number) =>
    Math.min(half - BOARD_MIN * cellSize, Math.max(half - (BOARD_MAX + 1) * cellSize, v))
  return { x: clamp(offset.x, viewportW / 2), y: clamp(offset.y, viewportH / 2) }
}

/** Whether a pointer movement of (dx, dy) px between down and up counts as a tap. */
export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP_PX
}

/** Center of the bounding box of `cells` ((0,0) when empty). */
export function boundsCenter(cells: Cell[]): Cell {
  if (cells.length === 0) return { x: 0, y: 0 }
  const xs = cells.map((c) => c.x)
  const ys = cells.map((c) => c.y)
  return {
    x: Math.floor((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.floor((Math.min(...ys) + Math.max(...ys)) / 2),
  }
}

/** Whether the whole cell lies inside the viewport. */
export function isCellVisible(
  cell: Cell,
  offset: Offset,
  viewportW: number,
  viewportH: number,
  cellSize: number,
): boolean {
  const x0 = cell.x * cellSize + offset.x
  const y0 = cell.y * cellSize + offset.y
  return x0 >= 0 && y0 >= 0 && x0 + cellSize <= viewportW && y0 + cellSize <= viewportH
}
