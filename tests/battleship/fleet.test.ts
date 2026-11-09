import { describe, expect, it } from 'vitest'
import { CELLS, FLEET, N } from '@/src/battleship/constants'
import {
  centeredCells,
  fleetSunk,
  randomFleet,
  resolveShot,
  shipCells,
  sunkKeys,
  validateFleet,
} from '@/src/battleship/fleet'
import type { Ship, Shot } from '@/src/battleship/types'
import { RoomError } from '@/src/tournament/types'
import { mulberry } from '../tournament/helpers'
import { FLEET_A, SHIP_CELLS } from './helpers'

function badFleet(ships: Ship[], complete = false) {
  try {
    validateFleet(ships, complete)
  } catch (e) {
    expect(e).toBeInstanceOf(RoomError)
    expect((e as RoomError).code).toBe('bad_fleet')
    return
  }
  throw new Error('expected bad_fleet')
}

const shot = (cell: number, result: Shot['result'], shipKey: Shot['shipKey'] = null): Shot => ({
  seq: 1,
  cell,
  result,
  shipKey,
  at: 0,
  auto: false,
})

describe('board and fleet', () => {
  it('is a 10×10 sea with the classic 5-4-3-3-2 fleet', () => {
    expect(N).toBe(10)
    expect(CELLS).toBe(100)
    expect(FLEET.map((f) => [f.key, f.len])).toEqual([
      ['ghost', 5],
      ['galleon', 4],
      ['frigate', 3],
      ['brig', 3],
      ['sloop', 2],
    ])
  })
})

describe('shipCells', () => {
  it('lays out horizontal and vertical ships inside the board', () => {
    expect(shipCells(3, 0, true)).toEqual([0, 1, 2])
    expect(shipCells(2, 80, false)).toEqual([80, 90])
    expect(shipCells(5, 5, true)).toEqual([5, 6, 7, 8, 9])
  })
  it('returns null when the ship leaves the board', () => {
    expect(shipCells(3, 8, true)).toBeNull()
    expect(shipCells(2, 90, false)).toBeNull()
  })
})

describe('centeredCells', () => {
  it('centres on the touched cell and shifts back inside the board', () => {
    expect(centeredCells(3, 11, true)).toEqual([10, 11, 12])
    expect(centeredCells(3, 0, true)).toEqual([0, 1, 2])
    expect(centeredCells(3, 99, false)).toEqual([79, 89, 99])
    expect(centeredCells(5, 44, true)).toEqual([42, 43, 44, 45, 46])
  })
})

describe('validateFleet', () => {
  it('accepts a full fleet, partial fleets and touching ships', () => {
    expect(() => validateFleet(FLEET_A, true)).not.toThrow()
    expect(() => validateFleet([], false)).not.toThrow()
    expect(() => validateFleet(FLEET_A.slice(0, 2), false)).not.toThrow()
    expect(() =>
      validateFleet(
        [
          { key: 'ghost', cells: [0, 1, 2, 3, 4] },
          { key: 'galleon', cells: [5, 6, 7, 8] },
          { key: 'frigate', cells: [10, 11, 12] },
          { key: 'brig', cells: [13, 14, 15] },
          { key: 'sloop', cells: [16, 17] },
        ],
        true,
      ),
    ).not.toThrow()
  })
  it('rejects unknown and duplicate keys', () => {
    badFleet([{ key: 'raft' as Ship['key'], cells: [0, 1] }])
    badFleet([{ key: 'sloop', cells: [0, 1] }, { key: 'sloop', cells: [10, 11] }])
  })
  it('rejects wrong length, gaps, diagonals and row wraps', () => {
    badFleet([{ key: 'frigate', cells: [0, 1] }])
    badFleet([{ key: 'sloop', cells: [0, 2] }])
    badFleet([{ key: 'sloop', cells: [0, 11] }])
    badFleet([{ key: 'sloop', cells: [9, 10] }])
  })
  it('rejects cells outside 0..99 or non-integers', () => {
    badFleet([{ key: 'sloop', cells: [-1, 0] }])
    badFleet([{ key: 'sloop', cells: [99, 100] }])
    badFleet([{ key: 'sloop', cells: [1.5, 2.5] }])
  })
  it('rejects overlaps and an incomplete fleet when complete is required', () => {
    badFleet([{ key: 'frigate', cells: [0, 1, 2] }, { key: 'sloop', cells: [2, 3] }])
    badFleet(FLEET_A.slice(0, 4), true)
  })
})

describe('randomFleet', () => {
  it('always returns a valid full fleet', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const f = randomFleet(mulberry(seed))
      expect(() => validateFleet(f, true)).not.toThrow()
    }
  })
  it('keeps already placed ships exactly', () => {
    const keep: Ship[] = [{ key: 'galleon', cells: [44, 45, 46, 47] }]
    for (let seed = 1; seed <= 200; seed++) {
      const f = randomFleet(mulberry(seed), keep)
      expect(f.find((s) => s.key === 'galleon')!.cells).toEqual([44, 45, 46, 47])
      expect(() => validateFleet(f, true)).not.toThrow()
    }
  })
})

describe('shots', () => {
  it('resolves miss, hit and sunk', () => {
    expect(resolveShot(FLEET_A, [], 55)).toEqual({ result: 'miss', shipKey: null })
    expect(resolveShot(FLEET_A, [], 98)).toEqual({ result: 'hit', shipKey: 'sloop' })
    expect(resolveShot(FLEET_A, [shot(98, 'hit', 'sloop')], 99)).toEqual({ result: 'sunk', shipKey: 'sloop' })
  })
  it('detects a sunk fleet only when all 17 cells are hit', () => {
    const all = SHIP_CELLS.map((c) => shot(c, 'hit'))
    expect(all).toHaveLength(17)
    expect(fleetSunk(FLEET_A, all.slice(0, 16))).toBe(false)
    expect(fleetSunk(FLEET_A, all)).toBe(true)
  })
  it('lists the keys of sunk shots', () => {
    expect([...sunkKeys([shot(98, 'hit', 'sloop'), shot(99, 'sunk', 'sloop'), shot(3, 'miss')])]).toEqual(['sloop'])
  })
})
