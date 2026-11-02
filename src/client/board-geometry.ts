import { BOARD_SIZE, type Cell } from '@/src/game/types'

/** The board cell under a pixel offset (relative to the board's top-left), or null if outside. */
export function cellAt(px: number, py: number, cellSize: number): Cell | null {
  if (px < 0 || py < 0) return null
  const x = Math.floor(px / cellSize)
  const y = Math.floor(py / cellSize)
  if (x >= BOARD_SIZE || y >= BOARD_SIZE) return null
  return { x, y }
}

/** Scroll offsets that put `cell` in the middle of the viewport, clamped to the scrollable range. */
export function scrollToCenter(
  cell: Cell,
  cellSize: number,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const total = BOARD_SIZE * cellSize
  const clamp = (v: number, span: number) => Math.min(Math.max(0, total - span), Math.max(0, v))
  return {
    left: clamp((cell.x + 0.5) * cellSize - viewport.width / 2, viewport.width),
    top: clamp((cell.y + 0.5) * cellSize - viewport.height / 2, viewport.height),
  }
}

/** Center of the bounding box of `cells` (board center when empty). */
export function boundsCenter(cells: Cell[]): Cell {
  if (cells.length === 0) return { x: Math.floor(BOARD_SIZE / 2), y: Math.floor(BOARD_SIZE / 2) }
  const xs = cells.map((c) => c.x)
  const ys = cells.map((c) => c.y)
  return {
    x: Math.floor((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.floor((Math.min(...ys) + Math.max(...ys)) / 2),
  }
}
