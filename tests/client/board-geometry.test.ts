import { describe, it, expect } from 'vitest'
import { boundsCenter, cellAt, scrollToCenter } from '@/src/client/board-geometry'

describe('cellAt', () => {
  it('maps the top-left pixel to (0,0)', () => {
    expect(cellAt(0, 0, 32)).toEqual({ x: 0, y: 0 })
  })
  it('maps the last pixel to (29,29)', () => {
    expect(cellAt(959, 959, 32)).toEqual({ x: 29, y: 29 })
  })
  it('returns null outside the board', () => {
    expect(cellAt(960, 10, 32)).toBeNull()
    expect(cellAt(10, 960, 32)).toBeNull()
    expect(cellAt(-1, 10, 32)).toBeNull()
  })
  it('respects the cell size', () => {
    expect(cellAt(47, 48, 24)).toEqual({ x: 1, y: 2 })
  })
})

describe('scrollToCenter', () => {
  const viewport = { width: 320, height: 400 }
  it('centers the cell in the viewport', () => {
    // cell 15 center = 15.5*32 = 496 → 496-160 = 336, 496-200 = 296
    expect(scrollToCenter({ x: 15, y: 15 }, 32, viewport)).toEqual({ left: 336, top: 296 })
  })
  it('is clamped to ≥ 0 near the top-left corner', () => {
    expect(scrollToCenter({ x: 0, y: 1 }, 32, viewport)).toEqual({ left: 0, top: 0 })
  })
  it('is clamped to the max scroll near the bottom-right corner', () => {
    // max = 960-320 = 640, 960-400 = 560
    expect(scrollToCenter({ x: 29, y: 29 }, 32, viewport)).toEqual({ left: 640, top: 560 })
  })
  it('is 0 when the board is smaller than the viewport', () => {
    expect(scrollToCenter({ x: 29, y: 29 }, 24, { width: 1000, height: 1000 })).toEqual({ left: 0, top: 0 })
  })
})

describe('boundsCenter', () => {
  it('returns the board center when there are no cells', () => {
    expect(boundsCenter([])).toEqual({ x: 15, y: 15 })
  })
  it('returns the center of the bounding box', () => {
    expect(boundsCenter([{ x: 2, y: 4 }, { x: 10, y: 8 }, { x: 5, y: 6 }])).toEqual({ x: 6, y: 6 })
  })
})
