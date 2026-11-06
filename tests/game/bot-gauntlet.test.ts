import { describe, expect, it } from 'vitest'
import { bookMove, chooseGauntletMove, GauntletEngine, isForcedPosition, __test } from '@/src/game/bot-gauntlet'
import { chooseBotMove } from '@/src/game/bot'
import { buildBoard, findWin, isInside } from '@/src/game/rules'
import type { GauntletHints } from '@/src/game/gauntlet-learn'
import type { Cell, Move, Side } from '@/src/game/types'

const mv = (x: number, y: number, side: Side): Move => ({ x, y, side, at: 0 })
const row = (x0: number, x1: number, y: number, side: Side): Move[] => {
  const out: Move[] = []
  for (let x = x0; x <= x1; x++) out.push(mv(x, y, side))
  return out
}
const inSet = (c: Cell, set: Cell[]) => set.some((s) => s.x === c.x && s.y === c.y)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random adjacent stones around the centre, no five on the board. */
function midgame(seed: number, n: number): Move[] {
  const rng = mulberry32(seed)
  for (;;) {
    const moves: Move[] = []
    let ok = true
    for (let i = 0; i < n && ok; i++) {
      const board = buildBoard(moves)
      let c: Cell = { x: 0, y: 0 }
      if (moves.length) {
        for (;;) {
          const base = moves[Math.floor(rng() * moves.length)]
          c = { x: base.x + Math.floor(rng() * 3) - 1, y: base.y + Math.floor(rng() * 3) - 1 }
          if (isInside(c.x, c.y) && board.get(c.x, c.y) === null) break
        }
      }
      const m = mv(c.x, c.y, i % 2 === 0 ? 'X' : 'O')
      moves.push(m)
      if (findWin(buildBoard(moves), m)) ok = false
    }
    if (ok) return moves
  }
}

const quick = (moves: Move[], side: Side) => chooseGauntletMove(moves, side, { timeBudgetMs: 300 })

describe('Gauntlet engine state', () => {
  it('incremental updates match a fresh build after random place/unplace sequences', () => {
    const { toIdx } = __test
    for (let seed = 1; seed <= 6; seed++) {
      const moves = midgame(seed, 30)
      const e = new GauntletEngine(moves.slice(0, 10))
      const rng = mulberry32(seed * 7)
      const placed: [number, number][] = []
      // play the rest in, then take some back, then put others in
      for (const m of moves.slice(10)) {
        const q = toIdx(m.x, m.y)
        e.place(q, m.side === 'X' ? 1 : 2)
        placed.push([q, m.side === 'X' ? 1 : 2])
      }
      for (let i = 0; i < 8; i++) {
        const [q, s] = placed.pop()!
        e.unplace(q, s)
      }
      const extra: Move[] = []
      for (let i = 0; i < 6; i++) {
        const c = { x: Math.floor(rng() * 9) - 4, y: Math.floor(rng() * 9) - 4 }
        const all = [...moves.slice(0, 10), ...moves.slice(10, 10 + placed.length), ...extra]
        if (all.some((m) => m.x === c.x && m.y === c.y)) continue
        const side: Side = i % 2 ? 'O' : 'X'
        e.place(toIdx(c.x, c.y), side === 'X' ? 1 : 2)
        extra.push(mv(c.x, c.y, side))
      }
      const fresh = new GauntletEngine([...moves.slice(0, 10 + placed.length), ...extra])
      expect(Array.from(e.b)).toEqual(Array.from(fresh.b))
      expect(e.n5).toEqual(fresh.n5)
      expect(e.n4o).toEqual(fresh.n4o)
      expect(e.total[1]).toBeCloseTo(fresh.total[1], 3)
      expect(e.total[2]).toBeCloseTo(fresh.total[2], 3)
      expect([e.hashLo, e.hashHi]).toEqual([fresh.hashLo, fresh.hashHi])
      for (const q of fresh.cand) {
        for (const s of [1, 2]) expect(e.maxLevel(q, s)).toBe(fresh.maxLevel(q, s))
      }
    }
  })
})

describe('Gauntlet tactics', () => {
  it('takes an immediate open win', () => {
    const moves = [mv(-10, -10, 'X'), mv(5, 5, 'X'), mv(-10, 5, 'X'), mv(5, -10, 'X'), mv(10, 10, 'X'), ...row(-5, -2, -5, 'O')]
    expect(inSet(quick(moves, 'O'), [{ x: -6, y: -5 }, { x: -1, y: -5 }])).toBe(true)
  })

  it('does not "win" into a both-blocked five', () => {
    const moves = [mv(-6, -10, 'X'), ...row(-5, -2, -10, 'O'), mv(0, -10, 'X'), mv(-6, -3, 'X'), ...row(-5, -2, -3, 'O'), mv(5, 5, 'X'), mv(7, 7, 'X'), mv(9, 5, 'X'), mv(-12, 10, 'X')]
    expect(quick(moves, 'O')).toEqual({ x: -1, y: -3 })
  })

  it('blocks a four', () => {
    const moves = [...row(0, 3, 0, 'X'), mv(-1, 0, 'O'), mv(10, 10, 'O'), mv(-10, 10, 'O')]
    expect(quick(moves, 'O')).toEqual({ x: 4, y: 0 })
  })

  it('answers an open three (blocks it or counters with a four)', () => {
    const moves = [...row(0, 2, 0, 'X'), mv(10, 10, 'O'), mv(-10, -10, 'O')] // X: 3 stones, O: 2 → O to move
    const c = quick(moves, 'O')
    expect(inSet(c, [{ x: -1, y: 0 }, { x: 3, y: 0 }, { x: -2, y: 0 }, { x: 4, y: 0 }])).toBe(true)
  })

  it('finds a double four (VCF)', () => {
    // O: row y=0 at 0..2 closed by X(-1,0); column x=4 at 1..3 closed by X(4,4). (4,0) makes two fours.
    const moves = [
      mv(-1, 0, 'X'), mv(0, 0, 'O'), mv(4, 4, 'X'), mv(1, 0, 'O'), mv(10, 10, 'X'), mv(2, 0, 'O'),
      mv(12, -8, 'X'), mv(4, 1, 'O'), mv(-10, 9, 'X'), mv(4, 2, 'O'), mv(-12, -12, 'X'), mv(4, 3, 'O'), mv(15, 3, 'X'),
    ]
    expect(quick(moves, 'O')).toEqual({ x: 4, y: 0 })
  })

  it('never returns an occupied or off-board cell (corner pressure)', () => {
    const moves = [mv(-50, -50, 'X'), mv(-49, -50, 'O'), mv(-50, -49, 'X'), mv(-49, -49, 'O'), mv(-48, -48, 'X')]
    const c = quick(moves, 'O')
    expect(isInside(c.x, c.y)).toBe(true)
    expect(buildBoard(moves).get(c.x, c.y)).toBeNull()
  })

  it('stays within its time budget on a busy midgame', () => {
    const moves = midgame(795, 40)
    const t0 = performance.now()
    const c = chooseGauntletMove(moves, 'X', { timeBudgetMs: 500 })
    expect(performance.now() - t0).toBeLessThan(800)
    expect(buildBoard(moves).get(c.x, c.y)).toBeNull()
  })

  it('is what chooseBotMove plays for the gauntlet level', () => {
    const moves = [...row(0, 3, 0, 'X'), mv(-1, 0, 'O'), mv(10, 10, 'O'), mv(-10, 10, 'O')]
    expect(chooseBotMove(moves, 'O', { mode: 'full', level: 'gauntlet', timeBudgetMs: 200 })).toEqual({ x: 4, y: 0 })
  })
})

describe('Gauntlet opening book', () => {
  it('opens in the centre and answers diagonally', () => {
    expect(bookMove([], 'X')).toEqual({ x: 0, y: 0 })
    const c = bookMove([mv(3, -2, 'X')], 'O')!
    expect(Math.abs(c.x - 3)).toBe(1)
    expect(Math.abs(c.y + 2)).toBe(1)
  })

  it('direct reply → the cell next to O and diagonal to X, in every orientation', () => {
    expect(inSet(bookMove([mv(0, 0, 'X'), mv(0, 1, 'O')], 'X')!, [{ x: 1, y: 1 }, { x: -1, y: 1 }])).toBe(true)
    expect(inSet(bookMove([mv(5, 5, 'X'), mv(6, 5, 'O')], 'X')!, [{ x: 6, y: 6 }, { x: 6, y: 4 }])).toBe(true)
  })

  it('diagonal reply → O mirrored across X', () => {
    expect(inSet(bookMove([mv(0, 0, 'X'), mv(1, 1, 'O')], 'X')!, [{ x: 1, y: -1 }, { x: -1, y: 1 }])).toBe(true)
  })

  it('out of book after a distant reply or later', () => {
    expect(bookMove([mv(0, 0, 'X'), mv(3, 0, 'O')], 'X')).toBeNull()
    expect(bookMove([mv(0, 0, 'X'), mv(1, 1, 'O'), mv(1, -1, 'X')], 'O')).toBeNull()
  })
})

describe('isForcedPosition', () => {
  it('is true when we can make five', () => {
    expect(isForcedPosition([...row(0, 3, 0, 'X'), ...row(0, 3, 5, 'O')], 'X')).toBe(true)
  })

  it('is true when the opponent threatens five', () => {
    expect(isForcedPosition([...row(0, 3, 0, 'X'), ...row(0, 2, 5, 'O')], 'O')).toBe(true)
  })

  it('is true when we have an open four', () => {
    expect(isForcedPosition([...row(1, 4, 0, 'X'), ...row(0, 2, 5, 'O')], 'X')).toBe(true)
  })

  it('is false in a quiet position', () => {
    expect(isForcedPosition([mv(0, 0, 'X'), mv(1, 1, 'O'), mv(2, 0, 'X')], 'O')).toBe(false)
  })
})

describe('chooseGauntletMove with hints', () => {
  const moves = midgame(9, 8)
  const side: Side = moves.length % 2 === 0 ? 'X' : 'O'
  const base = chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1) })

  it('uses a non-forced midgame seed', () => {
    expect(isForcedPosition(moves, side)).toBe(false)
  })

  it('plays the same move with empty hints', () => {
    expect(chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1), hints: new Map() })).toEqual(base)
  })

  it('avoids a condemned move', () => {
    const hints: GauntletHints = new Map([[`${base.x},${base.y}`, { w: -6, n: 4, wins: 0, losses: 4 }]])
    const got = chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1), hints })
    expect(got).not.toEqual(base)
  })

  it('does not avoid a move condemned on too little evidence', () => {
    const hints: GauntletHints = new Map([[`${base.x},${base.y}`, { w: -6, n: 2, wins: 0, losses: 2 }]])
    const got = chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1), hints })
    expect(got).toEqual(base)
  })
})
