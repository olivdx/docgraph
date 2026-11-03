import { describe, it, expect } from 'vitest'
import {
  CELL_PX,
  TAP_SLOP_PX,
  boundsCenter,
  cellAtPoint,
  clampOffset,
  isCellVisible,
  isTap,
  offsetToCenterOn,
} from '@/src/client/board-geometry'

// Offset = screen position (px, relative to the viewport's top-left) of cell (0,0)'s top-left corner.

describe('constants', () => {
  it('fixed 32 px cells, 8 px tap slop', () => {
    expect(CELL_PX).toBe(32)
    expect(TAP_SLOP_PX).toBe(8)
  })
})

describe('cellAtPoint', () => {
  it('maps the offset point to (0,0)', () => {
    expect(cellAtPoint(100, 50, { x: 100, y: 50 }, 32)).toEqual({ x: 0, y: 0 })
    expect(cellAtPoint(131, 81, { x: 100, y: 50 }, 32)).toEqual({ x: 0, y: 0 })
  })
  it('maps points left/above the origin to negative cells', () => {
    expect(cellAtPoint(99, 49, { x: 100, y: 50 }, 32)).toEqual({ x: -1, y: -1 })
    expect(cellAtPoint(100 - 32 * 3, 50 - 32 * 7 + 5, { x: 100, y: 50 }, 32)).toEqual({ x: -3, y: -7 })
  })
  it('maps points right/below the origin to positive cells (beyond the old 30×30 board)', () => {
    expect(cellAtPoint(32 * 35 + 1, 32 * 31 + 31, { x: 0, y: 0 }, 32)).toEqual({ x: 35, y: 31 })
  })
  it('returns the edge cells -50 and 49, and null beyond them', () => {
    expect(cellAtPoint(-50 * 32, 49 * 32 + 31, { x: 0, y: 0 }, 32)).toEqual({ x: -50, y: 49 })
    expect(cellAtPoint(-50 * 32 - 1, 0, { x: 0, y: 0 }, 32)).toBeNull()
    expect(cellAtPoint(50 * 32, 0, { x: 0, y: 0 }, 32)).toBeNull()
    expect(cellAtPoint(0, 50 * 32, { x: 0, y: 0 }, 32)).toBeNull()
  })
})

describe('offsetToCenterOn', () => {
  it('puts the cell center in the viewport center', () => {
    // 320×400 viewport: (0,0) center = 16 px → offset 160-16, 200-16
    expect(offsetToCenterOn({ x: 0, y: 0 }, 320, 400, 32)).toEqual({ x: 144, y: 184 })
    expect(offsetToCenterOn({ x: -3, y: 2 }, 320, 400, 32)).toEqual({ x: 144 + 96, y: 184 - 64 })
  })
})

describe('clampOffset', () => {
  // The viewport center must stay on the board: at most half a viewport of space beyond an edge.
  const vw = 320
  const vh = 400
  it('leaves an in-range offset alone', () => {
    expect(clampOffset({ x: 10, y: -20 }, vw, vh, 32)).toEqual({ x: 10, y: -20 })
  })
  it('stops the left/top edge at the viewport center', () => {
    // left edge (x = -50) on screen at -1600 + off.x ≤ 160 → off.x ≤ 1760
    expect(clampOffset({ x: 99999, y: 99999 }, vw, vh, 32)).toEqual({ x: 1760, y: 1800 })
  })
  it('stops the right/bottom edge at the viewport center', () => {
    // right edge (x = 49 + 1) on screen at 1600 + off.x ≥ 160 → off.x ≥ -1440
    expect(clampOffset({ x: -99999, y: -99999 }, vw, vh, 32)).toEqual({ x: -1440, y: -1400 })
  })
  it('centering on an edge cell is within the clamp', () => {
    const o = offsetToCenterOn({ x: 49, y: -50 }, vw, vh, 32)
    expect(clampOffset(o, vw, vh, 32)).toEqual(o)
  })
})

describe('isTap', () => {
  it('is a tap below 8 px of movement, a drag at 8 px or more', () => {
    expect(isTap(0, 0)).toBe(true)
    expect(isTap(5, -5)).toBe(true)
    expect(isTap(7.9, 0)).toBe(true)
    expect(isTap(8, 0)).toBe(false)
    expect(isTap(-6, 6)).toBe(false)
  })
})

describe('boundsCenter', () => {
  it('returns (0,0) when there are no cells', () => {
    expect(boundsCenter([])).toEqual({ x: 0, y: 0 })
  })
  it('returns the center of the bounding box, negatives included', () => {
    expect(boundsCenter([{ x: 2, y: 4 }, { x: 10, y: 8 }, { x: 5, y: 6 }])).toEqual({ x: 6, y: 6 })
    expect(boundsCenter([{ x: -9, y: -4 }, { x: -2, y: 3 }])).toEqual({ x: -6, y: -1 })
  })
})

describe('isCellVisible', () => {
  // offset (-320,-160) in a 320×480 viewport → cells x 10..19, y 5..19 fully visible
  const off = { x: -320, y: -160 }
  it('true when the whole cell is inside the viewport', () => {
    expect(isCellVisible({ x: 10, y: 5 }, off, 320, 480, 32)).toBe(true)
    expect(isCellVisible({ x: 19, y: 19 }, off, 320, 480, 32)).toBe(true)
  })
  it('false when the cell is outside or only partly visible', () => {
    expect(isCellVisible({ x: 9, y: 10 }, off, 320, 480, 32)).toBe(false)
    expect(isCellVisible({ x: 20, y: 10 }, off, 320, 480, 32)).toBe(false)
    expect(isCellVisible({ x: 12, y: 4 }, off, 320, 480, 32)).toBe(false)
    expect(isCellVisible({ x: 12, y: 5 }, { x: -320, y: -170 }, 320, 480, 32)).toBe(false)
  })
  it('works for negative cells', () => {
    expect(isCellVisible({ x: -3, y: -2 }, { x: 160, y: 100 }, 320, 480, 32)).toBe(true)
    expect(isCellVisible({ x: -6, y: -2 }, { x: 160, y: 100 }, 320, 480, 32)).toBe(false)
  })
})
