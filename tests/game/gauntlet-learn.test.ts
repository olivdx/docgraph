import { describe, expect, it } from 'vitest'
import {
  canonicalPosition,
  deltasFromGame,
  filterByHints,
  hintBonus,
  hintsFromDoc,
  HINT_BONUS_CAP,
  type BookDoc,
  type GameRecord,
  type GauntletHints,
} from '@/src/game/gauntlet-learn'
import type { Cell, Move, Side } from '@/src/game/types'

const mv = (x: number, y: number, side: Side): Move => ({ x, y, side, at: 0 })

// All 8 symmetries about (0,0): rotations by 90 degrees and their mirrors.
const SYMS: ((c: Cell) => Cell)[] = [
  (c) => ({ x: c.x, y: c.y }),
  (c) => ({ x: -c.y, y: c.x }),
  (c) => ({ x: -c.x, y: -c.y }),
  (c) => ({ x: c.y, y: -c.x }),
  (c) => ({ x: -c.x, y: c.y }),
  (c) => ({ x: c.y, y: c.x }),
  (c) => ({ x: c.x, y: -c.y }),
  (c) => ({ x: -c.y, y: -c.x }),
]

const POS: Move[] = [mv(0, 0, 'X'), mv(1, 1, 'O'), mv(2, 0, 'X'), mv(1, -1, 'O'), mv(3, 2, 'X')]

describe('canonicalPosition', () => {
  it('gives the same key for every symmetry of a position', () => {
    const base = canonicalPosition(POS).key
    for (const s of SYMS) {
      const t = POS.map((m) => ({ ...m, ...s(m) }))
      expect(canonicalPosition(t).key).toBe(base)
    }
  })

  it('gives different keys for different positions', () => {
    const other = [...POS.slice(0, 4), mv(3, 3, 'X')]
    expect(canonicalPosition(other).key).not.toBe(canonicalPosition(POS).key)
    expect(canonicalPosition(POS).key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('round-trips cells through toCanon/fromCanon', () => {
    const pos = canonicalPosition(POS)
    for (const c of [{ x: 7, y: -3 }, { x: 0, y: 0 }, { x: -12, y: 5 }]) {
      expect(pos.fromCanon(pos.toCanon(c))).toEqual(c)
    }
  })

  it('still produces a key when a symmetry would leave the board (x = -50)', () => {
    const edge = [mv(-50, 0, 'X'), mv(-49, 1, 'O'), mv(-48, 0, 'X')]
    const pos = canonicalPosition(edge)
    expect(pos.key).toMatch(/^[0-9a-f]{16}$/)
    // Mirrored across y it must map to the same key (that symmetry keeps x = -50 in range).
    const mirrored = edge.map((m) => ({ ...m, y: -m.y }))
    expect(canonicalPosition(mirrored).key).toBe(pos.key)
  })
})

describe('hintsFromDoc', () => {
  it('returns an empty map for null and translates canonical cells to board cells', () => {
    const pos = canonicalPosition(POS)
    expect(hintsFromDoc(null, pos).size).toBe(0)
    const boardCell = { x: 4, y: 1 }
    const canon = pos.toCanon(boardCell)
    const doc: BookDoc = {
      _id: `${pos.key}:O`,
      side: 'O',
      moves: { [`${canon.x},${canon.y}`]: { w: -4, n: 3, wins: 0, losses: 3 } },
      updatedAt: 0,
    }
    const hints = hintsFromDoc(doc, pos)
    expect(hints.get('4,1')).toEqual({ w: -4, n: 3, wins: 0, losses: 3 })
  })
})

const never = () => false

function rec(moves: Move[], botSide: Side, winnerSide: Side): GameRecord {
  return {
    _id: 'R:M:1',
    roomCode: 'R',
    matchId: 'M',
    gameIndex: 1,
    moves,
    botSide,
    winnerSide,
    endReason: 'five_in_row',
    createdAt: 0,
  }
}

// X: 0,0  O: 1,1  X: 2,0  O: 1,-1  X: 3,2  O: 4,4  (bot = O -> bot moves at ply 1, 3, 5)
const GAME: Move[] = [mv(0, 0, 'X'), mv(1, 1, 'O'), mv(2, 0, 'X'), mv(1, -1, 'O'), mv(3, 2, 'X'), mv(4, 4, 'O')]

describe('deltasFromGame', () => {
  it('gives +1 to every non-forced, non-book bot move of a won game', () => {
    const d = deltasFromGame(rec(GAME, 'O', 'O'), never, never)
    expect(d.map((x) => x.delta)).toEqual([1, 1, 1])
    expect(d.every((x) => x.side === 'O' && x.won)).toBe(true)
    // keys are those of the positions *before* each bot move
    expect(d[0].key).toBe(canonicalPosition(GAME.slice(0, 1)).key)
    expect(d[2].key).toBe(canonicalPosition(GAME.slice(0, 5)).key)
  })

  it('penalises a lost game more the closer to the end (k = 3 -> -5/3, -7/3, -3)', () => {
    const d = deltasFromGame(rec(GAME, 'O', 'X'), never, never)
    expect(d.map((x) => +x.delta.toFixed(4))).toEqual([-1.6667, -2.3333, -3])
    expect(d.every((x) => !x.won)).toBe(true)
  })

  it('skips book and forced positions', () => {
    const inBook = (moves: Move[]) => moves.length < 2 // ply 1 is "book"
    const isForced = (moves: Move[]) => moves.length === 5 // last bot move is "forced"
    const d = deltasFromGame(rec(GAME, 'O', 'X'), isForced, inBook)
    expect(d).toHaveLength(1)
    expect(d[0].delta).toBe(-3) // k = 1
    expect(d[0].key).toBe(canonicalPosition(GAME.slice(0, 3)).key)
  })

  it('stores the move cell in canonical coordinates', () => {
    const d = deltasFromGame(rec(GAME, 'O', 'O'), never, never)
    const pos = canonicalPosition(GAME.slice(0, 1))
    const c = pos.toCanon({ x: 1, y: 1 })
    expect(d[0].cell).toBe(`${c.x},${c.y}`)
  })
})

describe('filterByHints / hintBonus', () => {
  const cells: Cell[] = [{ x: 0, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]
  const entry = (w: number, n: number) => ({ w, n, wins: 0, losses: n })

  it('removes cells seen >= 3 times with w <= -3', () => {
    const hints: GauntletHints = new Map([['0,1', entry(-3, 3)], ['2,2', entry(-5, 2)], ['3,3', entry(-2.9, 10)]])
    expect(filterByHints(cells, hints)).toEqual([{ x: 2, y: 2 }, { x: 3, y: 3 }])
  })

  it('never removes everything', () => {
    const hints: GauntletHints = new Map([['0,1', entry(-9, 9)]])
    expect(filterByHints([{ x: 0, y: 1 }], hints)).toEqual([{ x: 0, y: 1 }])
    expect(filterByHints(cells, undefined)).toEqual(cells)
  })

  it('bonus is w * 2000, clamped, 0 when unknown', () => {
    const hints: GauntletHints = new Map([['0,1', entry(2, 2)], ['2,2', entry(-50, 50)]])
    expect(hintBonus({ x: 0, y: 1 }, hints)).toBe(4000)
    expect(hintBonus({ x: 2, y: 2 }, hints)).toBe(-HINT_BONUS_CAP)
    expect(hintBonus({ x: 3, y: 3 }, hints)).toBe(0)
    expect(hintBonus({ x: 3, y: 3 }, undefined)).toBe(0)
  })
})
