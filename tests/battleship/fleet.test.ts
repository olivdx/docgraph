import { describe, expect, it } from 'vitest'
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

const FULL: Ship[] = [
  { key: 'galleon', cells: [0, 1, 2] },
  { key: 'brig', cells: [12, 18] },
  { key: 'sloop', cells: [34, 35] },
]

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

describe('shipCells', () => {
  it('lays out horizontal and vertical ships inside the board', () => {
    expect(shipCells(3, 0, true)).toEqual([0, 1, 2])
    expect(shipCells(2, 24, false)).toEqual([24, 30])
  })
  it('returns null when the ship leaves the board', () => {
    expect(shipCells(3, 4, true)).toBeNull()
    expect(shipCells(2, 30, false)).toBeNull()
  })
})

describe('centeredCells', () => {
  it('centres on the touched cell and shifts back inside the board', () => {
    expect(centeredCells(3, 7, true)).toEqual([6, 7, 8])
    expect(centeredCells(3, 0, true)).toEqual([0, 1, 2])
    expect(centeredCells(3, 35, false)).toEqual([23, 29, 35])
  })
})

describe('validateFleet', () => {
  it('accepts a full fleet, partial fleets and touching ships', () => {
    expect(() => validateFleet(FULL, true)).not.toThrow()
    expect(() => validateFleet([], false)).not.toThrow()
    expect(() => validateFleet(FULL.slice(0, 2), false)).not.toThrow()
    expect(() =>
      validateFleet([{ key: 'galleon', cells: [0, 1, 2] }, { key: 'brig', cells: [3, 4] }, { key: 'sloop', cells: [6, 7] }], true),
    ).not.toThrow()
  })
  it('rejects unknown and duplicate keys', () => {
    badFleet([{ key: 'raft' as Ship['key'], cells: [0, 1] }])
    badFleet([{ key: 'brig', cells: [0, 1] }, { key: 'brig', cells: [10, 11] }])
  })
  it('rejects wrong length, gaps, diagonals and row wraps', () => {
    badFleet([{ key: 'galleon', cells: [0, 1] }])
    badFleet([{ key: 'brig', cells: [0, 2] }])
    badFleet([{ key: 'brig', cells: [0, 7] }])
    badFleet([{ key: 'brig', cells: [5, 6] }])
  })
  it('rejects cells outside 0..35 or non-integers', () => {
    badFleet([{ key: 'brig', cells: [-1, 0] }])
    badFleet([{ key: 'brig', cells: [35, 36] }])
    badFleet([{ key: 'brig', cells: [1.5, 2.5] }])
  })
  it('rejects overlaps and an incomplete fleet when complete is required', () => {
    badFleet([{ key: 'galleon', cells: [0, 1, 2] }, { key: 'brig', cells: [2, 3] }])
    badFleet(FULL.slice(0, 2), true)
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
    const keep: Ship[] = [{ key: 'galleon', cells: [14, 15, 16] }]
    for (let seed = 1; seed <= 200; seed++) {
      const f = randomFleet(mulberry(seed), keep)
      expect(f.find((s) => s.key === 'galleon')!.cells).toEqual([14, 15, 16])
      expect(() => validateFleet(f, true)).not.toThrow()
    }
  })
})

describe('shots', () => {
  it('resolves miss, hit and sunk', () => {
    expect(resolveShot(FULL, [], 20)).toEqual({ result: 'miss', shipKey: null })
    expect(resolveShot(FULL, [], 12)).toEqual({ result: 'hit', shipKey: 'brig' })
    expect(resolveShot(FULL, [shot(12, 'hit', 'brig')], 18)).toEqual({ result: 'sunk', shipKey: 'brig' })
  })
  it('detects a sunk fleet only when all 7 cells are hit', () => {
    const all = [0, 1, 2, 12, 18, 34, 35].map((c) => shot(c, 'hit'))
    expect(fleetSunk(FULL, all.slice(0, 6))).toBe(false)
    expect(fleetSunk(FULL, all)).toBe(true)
  })
  it('lists the keys of sunk shots', () => {
    expect([...sunkKeys([shot(12, 'hit', 'brig'), shot(18, 'sunk', 'brig'), shot(3, 'miss')])]).toEqual(['brig'])
  })
})
