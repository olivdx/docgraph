import { BOARD_MAX, BOARD_MIN, type Cell, type Move, type Side } from './types'
import { FIVE, FOUR, LEVEL_WEIGHT, level, OPEN3, OPEN4, POW3, W_DOUBLE3, W_FIVE, W_OPEN4 } from './patterns'
import { filterByHints, hintBonus, type GauntletHints } from './gauntlet-learn'

/**
 * Gauntlet: the hardest Caro bot. Same rules as the other levels (5+ in a row wins unless both
 * ends are blocked; the board edge blocks), stronger machinery:
 *
 * - Incremental pattern state. For every cell, side and direction it keeps the line pattern that
 *   side would make by playing there (patterns.ts). Placing a stone re-classifies only the 40
 *   cells on its four lines (±5), so move generation and evaluation are array reads.
 * - Evaluation counts both sides' patterns over the whole board (through the cells that complete
 *   them: a four has its completion cell, an open three its open-four cells, and so on, plus fork
 *   cells such as 4-3 and 3-3) and weights the side to move higher (tempo).
 * - Search: iterative-deepening PVS with a Zobrist transposition table, killer and history move
 *   ordering, and forced replies that don't consume depth.
 * - Threat-space search: VCF (continuous fours) and VCT (fours and open threes) where the
 *   defender may block anywhere that kills the threat or counter with a four of their own. At the
 *   root the bot also checks the opponent's VCT and keeps only moves that stop it; if that check
 *   runs out of time, the moves already proven safe are kept.
 * - A small opening book for the first moves.
 */

export type GauntletOptions = {
  timeBudgetMs: number
  rng?: () => number
  hints?: GauntletHints
}

// ---- board geometry ----------------------------------------------------------------------------

const PAD = 5 // a ±5 line window never leaves the array
const SIZE = BOARD_MAX - BOARD_MIN + 1
const STRIDE = SIZE + 2 * PAD
const CELLS = STRIDE * STRIDE
const EMPTY = 0
const WALL = 3
const STEP = [1, STRIDE, STRIDE + 1, 1 - STRIDE]

const toIdx = (x: number, y: number) => (y - BOARD_MIN + PAD) * STRIDE + (x - BOARD_MIN + PAD)
function toCell(i: number): Cell {
  const col = i % STRIDE
  return { x: col - PAD + BOARD_MIN, y: (i - col) / STRIDE - PAD + BOARD_MIN }
}

const WALLS = (() => {
  const b = new Uint8Array(CELLS)
  for (let i = 0; i < CELLS; i++) {
    const col = i % STRIDE
    const row = (i - col) / STRIDE
    if (col < PAD || row < PAD || col >= PAD + SIZE || row >= PAD + SIZE) b[i] = WALL
  }
  return b
})()

// ---- hashing -----------------------------------------------------------------------------------

function xorshift(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s | 0
  }
}
const ZLO = new Int32Array(CELLS * 3)
const ZHI = new Int32Array(CELLS * 3)
{
  const r = xorshift(0x9e3779b9)
  for (let i = 0; i < ZLO.length; i++) {
    ZLO[i] = r()
    ZHI[i] = r()
  }
}
const SIDE_LO = 0x5bd1e995 | 0
const SIDE_HI = 0x27d4eb2f | 0

// Transposition table (module level, reused across moves; a generation tag invalidates old entries).
const TT_SIZE = 1 << 18
const TT_MASK = TT_SIZE - 1
const ttKey = new Int32Array(TT_SIZE)
const ttGen = new Uint16Array(TT_SIZE)
const ttDepth = new Int8Array(TT_SIZE)
const ttFlag = new Uint8Array(TT_SIZE)
const ttVal = new Float64Array(TT_SIZE)
const ttMove = new Int32Array(TT_SIZE)
const EXACT = 1
const LOWER = 2
const UPPER = 3
// Threat-search memo: depth at which "attacker has no VCT/VCF here" was proven.
const tsKey = new Int32Array(TT_SIZE)
const tsGen = new Uint16Array(TT_SIZE)
const tsFail = new Int8Array(TT_SIZE)
let generation = 0

// ---- scoring -----------------------------------------------------------------------------------

const CAP = 1e6 // per-cell cap in the evaluation
const TEMPO = 1.2 // the side to move gets this weight on its own patterns
const WIN = 1e12
const MATE = WIN - 1000
const MAX_PLY = 64

class Timeout extends Error {}
const TIMEOUT = new Timeout()

/** Value of a cell for a side from its four line levels (compound forks included), and the max level. */
function cellValue(l0: number, l1: number, l2: number, l3: number): number {
  let sum = LEVEL_WEIGHT[l0] + LEVEL_WEIGHT[l1] + LEVEL_WEIGHT[l2] + LEVEL_WEIGHT[l3]
  let fours = 0
  let open3 = 0
  let five = false
  for (const l of [l0, l1, l2, l3]) {
    if (l === FIVE) five = true
    else if (l >= FOUR) fours++
    else if (l === OPEN3) open3++
  }
  if (five) return W_FIVE + sum
  if (fours >= 2 || (fours >= 1 && open3 >= 1)) sum = Math.max(sum, W_OPEN4)
  else if (open3 >= 2) sum = Math.max(sum, W_DOUBLE3)
  return sum
}

// ---- engine ------------------------------------------------------------------------------------

export class GauntletEngine {
  readonly b = WALLS.slice()
  /** Level by (cell, side, dir): index (cell * 2 + side - 1) * 4 + dir. Kept for occupied cells too. */
  readonly lv = new Uint8Array(CELLS * 8)
  /** Value by (cell, side): index cell * 2 + side - 1 (meaningful for empty cells). */
  readonly val = new Float64Array(CELLS * 2)
  /** Max level by (cell, side). */
  readonly maxLv = new Uint8Array(CELLS * 2)
  /** Σ min(val, CAP) over empty cells, by side (index 1, 2). */
  readonly total = [0, 0, 0]
  /** Empty cells where the side completes a five / makes an open four. */
  readonly n5 = [0, 0, 0]
  readonly n4o = [0, 0, 0]
  readonly near = new Int16Array(CELLS)
  readonly cand = new Set<number>()
  hashLo = 0
  hashHi = 0
  stones = 0

  // search state
  deadline = Infinity
  nodes = 0
  readonly killers = new Int32Array(MAX_PLY * 2).fill(-1)
  readonly history = new Float64Array(CELLS)
  readonly scoreBuf = new Float64Array(CELLS)
  private tsPly = 0

  constructor(moves: Move[] = []) {
    for (const m of moves) this.place(toIdx(m.x, m.y), m.side === 'X' ? 1 : 2)
  }

  // ---- incremental board ----

  private code(q: number, d: number, s: number): number {
    const b = this.b
    const st = STEP[d]
    let code = 0
    for (let k = 1; k <= 5; k++) {
      const vl = b[q - k * st]
      code += (vl === EMPTY ? 0 : vl === s ? 1 : 2) * POW3[5 - k]
      const vr = b[q + k * st]
      code += (vr === EMPTY ? 0 : vr === s ? 1 : 2) * POW3[4 + k]
    }
    return code
  }

  private removeContrib(q: number, s: number) {
    const k = q * 2 + s - 1
    this.total[s] -= Math.min(this.val[k], CAP)
    const m = this.maxLv[k]
    if (m === FIVE) this.n5[s]--
    else if (m === OPEN4) this.n4o[s]--
  }

  private addContrib(q: number, s: number) {
    const k = q * 2 + s - 1
    const base = k * 4
    const lv = this.lv
    const l0 = lv[base]
    const l1 = lv[base + 1]
    const l2 = lv[base + 2]
    const l3 = lv[base + 3]
    const v = cellValue(l0, l1, l2, l3)
    const m = Math.max(l0, l1, l2, l3)
    this.val[k] = v
    this.maxLv[k] = m
    this.total[s] += Math.min(v, CAP)
    if (m === FIVE) this.n5[s]++
    else if (m === OPEN4) this.n4o[s]++
  }

  private refreshLines(p: number) {
    const b = this.b
    for (let d = 0; d < 4; d++) {
      const st = STEP[d]
      for (let k = -5; k <= 5; k++) {
        if (k === 0) continue
        const q = p + k * st
        if (b[q] === WALL) continue
        const empty = b[q] === EMPTY
        for (let s = 1; s <= 2; s++) {
          const li = (q * 2 + s - 1) * 4 + d
          const nl = level(this.code(q, d, s))
          if (nl === this.lv[li]) continue
          if (empty) this.removeContrib(q, s)
          this.lv[li] = nl
          if (empty) this.addContrib(q, s)
        }
      }
    }
  }

  private bumpNear(p: number, delta: number) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const q = p + dy * STRIDE + dx
        if (this.b[q] === WALL) continue
        this.near[q] += delta
        if (this.near[q] === 0) this.cand.delete(q)
        else if (delta > 0 && this.near[q] === delta) this.cand.add(q)
      }
  }

  place(p: number, s: number) {
    this.removeContrib(p, 1)
    this.removeContrib(p, 2)
    this.b[p] = s
    this.hashLo ^= ZLO[p * 3 + s]
    this.hashHi ^= ZHI[p * 3 + s]
    this.stones++
    this.bumpNear(p, 1)
    this.refreshLines(p)
  }

  unplace(p: number, s: number) {
    this.b[p] = EMPTY
    this.hashLo ^= ZLO[p * 3 + s]
    this.hashHi ^= ZHI[p * 3 + s]
    this.stones--
    this.bumpNear(p, -1)
    this.refreshLines(p)
    this.addContrib(p, 1)
    this.addContrib(p, 2)
  }

  // ---- queries ----

  maxLevel(q: number, s: number) {
    return this.maxLv[q * 2 + s - 1]
  }

  value(q: number, s: number) {
    return this.val[q * 2 + s - 1]
  }

  /** Empty candidate cells where side `s` has max level exactly `l`. */
  cellsAt(s: number, l: number): number[] {
    const out: number[] = []
    for (const q of this.cand) if (this.b[q] === EMPTY && this.maxLv[q * 2 + s - 1] === l) out.push(q)
    return out
  }

  firstAt(s: number, l: number): number {
    for (const q of this.cand) if (this.b[q] === EMPTY && this.maxLv[q * 2 + s - 1] === l) return q
    return -1
  }

  /** Cells where `s` makes a four (closed or open; fives excluded). */
  fourMoves(s: number): number[] {
    const out: number[] = []
    for (const q of this.cand) {
      if (this.b[q] !== EMPTY) continue
      const m = this.maxLv[q * 2 + s - 1]
      if (m === FOUR || m === OPEN4) out.push(q)
    }
    return out
  }

  /** Cells where `s` makes an open three on some line (and no four). */
  threeMoves(s: number): number[] {
    const out: number[] = []
    const lv = this.lv
    for (const q of this.cand) {
      if (this.b[q] !== EMPTY) continue
      const k = q * 2 + s - 1
      if (this.maxLv[k] >= FOUR) continue
      const base = k * 4
      if (lv[base] === OPEN3 || lv[base + 1] === OPEN3 || lv[base + 2] === OPEN3 || lv[base + 3] === OPEN3) out.push(q)
    }
    return out
  }

  /** Static evaluation for the side to move: both sides' patterns, the mover's weighted by TEMPO. */
  evaluate(me: number): number {
    return TEMPO * this.total[me] - this.total[3 - me]
  }

  private moveScore(q: number, me: number): number {
    return this.val[q * 2 + me - 1] + 0.9 * this.val[q * 2 + (3 - me) - 1]
  }

  private sortByScore(cells: number[], me: number): number[] {
    const sb = this.scoreBuf
    for (const q of cells) sb[q] = this.moveScore(q, me) + this.history[q] * 16
    return [...new Set(cells)].sort((p, q) => sb[q] - sb[p] || p - q)
  }

  /** Top `n` empty candidates by move score for `me`. */
  topCells(me: number, n: number): number[] {
    const all: number[] = []
    for (const q of this.cand) if (this.b[q] === EMPTY) all.push(q)
    return this.sortByScore(all, me).slice(0, n)
  }

  /**
   * `me` faces open-four threats (the opponent has an open three): the moves that answer them, i.e.
   * cells that leave the opponent no open four (found by trying them) and `me`'s own fours.
   */
  defensesAgainstOpen3(me: number): number[] {
    const opp = 3 - me
    const pool = new Set<number>([...this.cellsAt(opp, OPEN4), ...this.fourMoves(opp), ...this.topCells(me, 6)])
    const out: number[] = []
    for (const q of this.fourMoves(me)) out.push(q)
    for (const q of pool) {
      if (this.b[q] !== EMPTY || out.includes(q)) continue
      this.place(q, me)
      const ok = this.n4o[opp] === 0 && this.n5[opp] === 0
      this.unplace(q, me)
      if (ok) out.push(q)
    }
    return this.sortByScore(out, me)
  }

  private checkTime() {
    if ((++this.nodes & 255) === 0 && performance.now() > this.deadline) throw TIMEOUT
  }

  // ---- threat-space search ----

  private tsSlot(me: number) {
    return ((this.hashLo ^ (me === 2 ? SIDE_LO : 0)) & TT_MASK) >>> 0
  }

  private tsKnownFail(me: number, depth: number, salt: number): boolean {
    const slot = this.tsSlot(me) ^ salt
    const key = this.hashHi ^ (me === 2 ? SIDE_HI : 0)
    return tsGen[slot] === generation && tsKey[slot] === key && tsFail[slot] >= depth
  }

  private tsStoreFail(me: number, depth: number, salt: number) {
    const slot = this.tsSlot(me) ^ salt
    tsKey[slot] = this.hashHi ^ (me === 2 ? SIDE_HI : 0)
    tsGen[slot] = generation
    tsFail[slot] = depth
  }

  /** VCF for `me` (to move): first move of a win by continuous fours, or -1. */
  vcf(me: number, depth: number): number {
    this.checkTime()
    const opp = 3 - me
    if (this.n5[me] > 0) return this.firstAt(me, FIVE)
    if (this.n5[opp] >= 2) return -1
    if (this.n5[opp] === 1) {
      // Must block; that only keeps a VCF going if the block is itself a four.
      const blk = this.firstAt(opp, FIVE)
      const m = this.maxLevel(blk, me)
      if (m !== FOUR && m !== OPEN4) return -1
      return this.vcfTry(me, [blk], depth)
    }
    if (this.n4o[me] > 0) return this.firstAt(me, OPEN4)
    if (depth <= 0) return -1
    if (this.tsKnownFail(me, depth, 0)) return -1
    const r = this.vcfTry(me, this.sortByScore(this.cellsAt(me, FOUR), me), depth)
    if (r < 0) this.tsStoreFail(me, depth, 0)
    return r
  }

  private vcfTry(me: number, cells: number[], depth: number): number {
    const opp = 3 - me
    for (const c of cells) {
      this.place(c, me)
      try {
        if (this.n5[opp] > 0) continue // (cannot happen: our stone never makes their five)
        if (this.n5[me] >= 2) return c
        if (this.n5[me] === 1) {
          const blk = this.firstAt(me, FIVE)
          this.place(blk, opp)
          try {
            if (this.vcf(me, depth - 1) >= 0) return c
          } finally {
            this.unplace(blk, opp)
          }
        }
      } finally {
        this.unplace(c, me)
      }
    }
    return -1
  }

  /** VCT for `me` (to move): first move of a win by fours and open threes, or -1. */
  vct(me: number, depth: number): number {
    this.checkTime()
    const opp = 3 - me
    if (this.n5[me] > 0) return this.firstAt(me, FIVE)
    if (this.n5[opp] >= 2) return -1
    if (this.tsPly > 48) return -1
    if (this.n5[opp] === 1) {
      // A forced block (after the defender's counter-four); the attack goes on if it still stands.
      const blk = this.firstAt(opp, FIVE)
      this.place(blk, me)
      this.tsPly++
      try {
        return this.vctDefender(me, depth) ? blk : -1
      } finally {
        this.tsPly--
        this.unplace(blk, me)
      }
    }
    if (this.n4o[me] > 0) return this.firstAt(me, OPEN4)
    if (depth <= 0) return -1
    if (this.tsKnownFail(me, depth, 1)) return -1
    // While the defender has an open three of their own, only fours are fast enough.
    const threats = this.n4o[opp] > 0 ? this.fourMoves(me) : [...this.fourMoves(me), ...this.threeMoves(me)]
    const ordered = this.sortByScore(threats, me).slice(0, 16)
    for (const t of ordered) {
      this.place(t, me)
      this.tsPly++
      try {
        if (this.vctDefender(me, depth - 1)) return t
      } finally {
        this.tsPly--
        this.unplace(t, me)
      }
    }
    this.tsStoreFail(me, depth, 1)
    return -1
  }

  /** The defender (3 - me) is to move against `me`'s threat. True if the attacker still wins. */
  private vctDefender(me: number, depth: number): boolean {
    this.checkTime()
    const opp = 3 - me
    if (this.n5[opp] > 0) return false
    if (this.n5[me] >= 2) return true
    if (this.n5[me] === 1) {
      const blk = this.firstAt(me, FIVE)
      this.place(blk, opp)
      this.tsPly++
      try {
        return this.vct(me, depth) >= 0
      } finally {
        this.tsPly--
        this.unplace(blk, opp)
      }
    }
    if (this.n4o[me] === 0) return false // no threat pending
    const defs = this.defensesAgainstOpen3(opp)
    if (defs.length === 0) return true
    for (const d of defs) {
      this.place(d, opp)
      this.tsPly++
      try {
        if (this.vct(me, depth) < 0) return false
      } finally {
        this.tsPly--
        this.unplace(d, opp)
      }
    }
    return true
  }

  // ---- alpha-beta ----

  private keyLo(me: number) {
    return this.hashLo ^ (me === 2 ? SIDE_LO : 0)
  }

  private keyHi(me: number) {
    return this.hashHi ^ (me === 2 ? SIDE_HI : 0)
  }

  /** Moves to search for `me` at a node with no immediate win, loss or forced block. */
  orderedMoves(me: number, depth: number, ply: number, ttBest: number): number[] {
    const opp = 3 - me
    let list: number[]
    if (this.n4o[opp] > 0) {
      list = this.defensesAgainstOpen3(me)
      if (list.length === 0) list = this.topCells(me, 4)
    } else {
      list = this.topCells(me, ply === 0 ? 20 : depth >= 4 ? 12 : 9)
    }
    const front: number[] = []
    if (ttBest >= 0 && list.includes(ttBest)) front.push(ttBest)
    for (const k of [this.killers[ply * 2], this.killers[ply * 2 + 1]]) {
      if (k >= 0 && !front.includes(k) && list.includes(k)) front.push(k)
    }
    return front.length ? [...front, ...list.filter((q) => !front.includes(q))] : list
  }

  search(depth: number, alpha: number, beta: number, me: number, ply: number): number {
    this.checkTime()
    const opp = 3 - me
    if (this.n5[me] > 0) return WIN - ply
    if (this.n5[opp] >= 2) return -(WIN - ply - 1)
    let forced = -1
    if (this.n5[opp] === 1) forced = this.firstAt(opp, FIVE)
    else {
      if (this.n4o[me] > 0) return WIN - ply - 2
      if (depth <= 0 || ply >= MAX_PLY - 1) return this.evaluate(me)
    }

    const kLo = this.keyLo(me)
    const kHi = this.keyHi(me)
    const slot = kLo & TT_MASK
    let ttBest = -1
    if (ttGen[slot] === generation && ttKey[slot] === kHi) {
      ttBest = ttMove[slot]
      if (ttDepth[slot] >= depth) {
        let v = ttVal[slot]
        if (v >= MATE) v -= ply
        else if (v <= -MATE) v += ply
        const f = ttFlag[slot]
        if (f === EXACT || (f === LOWER && v >= beta) || (f === UPPER && v <= alpha)) return v
      }
    }

    const moves = forced >= 0 ? [forced] : this.orderedMoves(me, depth, ply, ttBest)
    if (moves.length === 0) return 0
    // A single (forced) reply doesn't consume depth.
    const next = moves.length === 1 && ply < 24 ? depth : depth - 1
    const a0 = alpha
    let best = -Infinity
    let bestMove = moves[0]
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]
      this.place(m, me)
      let v: number
      try {
        if (i === 0) v = -this.search(next, -beta, -alpha, opp, ply + 1)
        else {
          v = -this.search(next, -alpha - 1, -alpha, opp, ply + 1)
          if (v > alpha && v < beta) v = -this.search(next, -beta, -alpha, opp, ply + 1)
        }
      } finally {
        this.unplace(m, me)
      }
      if (v > best) {
        best = v
        bestMove = m
      }
      if (v > alpha) alpha = v
      if (alpha >= beta) {
        if (forced < 0 && ply < MAX_PLY) {
          const k0 = this.killers[ply * 2]
          if (k0 !== m) {
            this.killers[ply * 2 + 1] = k0
            this.killers[ply * 2] = m
          }
          this.history[m] += depth * depth
        }
        break
      }
    }

    let stored = best
    if (stored >= MATE) stored += ply
    else if (stored <= -MATE) stored -= ply
    ttKey[slot] = kHi
    ttGen[slot] = generation
    ttDepth[slot] = depth
    ttFlag[slot] = best <= a0 ? UPPER : best >= beta ? LOWER : EXACT
    ttVal[slot] = stored
    ttMove[slot] = bestMove
    return best
  }
}

// ---- opening book ------------------------------------------------------------------------------

const dist0 = (c: Cell) => Math.max(Math.abs(c.x), Math.abs(c.y))

function pickNearCenter(options: Cell[], taken: Set<string>, rng?: () => number): Cell | null {
  const legal = options.filter(
    (c) => c.x >= BOARD_MIN && c.y >= BOARD_MIN && c.x <= BOARD_MAX && c.y <= BOARD_MAX && !taken.has(`${c.x},${c.y}`),
  )
  if (legal.length === 0) return null
  const best = Math.min(...legal.map(dist0))
  const top = legal.filter((c) => dist0(c) === best)
  return top[rng ? Math.floor(rng() * top.length) % top.length : 0]
}

/**
 * Opening book (by shape, so every rotation and mirror is covered):
 * - move 1: the centre;
 * - move 2 (as O): a diagonal neighbour of X's stone (the indirect opening);
 * - move 3 (as X): against a direct (orthogonal) reply, the cell next to O and diagonal to X
 *   ("flower moon" / Kagetsu); against a diagonal reply, the cell mirroring O across X's row or
 *   column ("bay moon" / Hogetsu). Both are strong first-player openings in free-style gomoku.
 */
export function bookMove(moves: Move[], side: Side, rng?: () => number): Cell | null {
  const taken = new Set(moves.map((m) => `${m.x},${m.y}`))
  if (moves.length === 0) return { x: 0, y: 0 }
  if (moves.length === 1 && side === 'O') {
    const p = moves[0]
    return pickNearCenter(
      [
        { x: p.x + 1, y: p.y + 1 },
        { x: p.x - 1, y: p.y + 1 },
        { x: p.x + 1, y: p.y - 1 },
        { x: p.x - 1, y: p.y - 1 },
      ],
      taken,
      rng,
    )
  }
  if (moves.length === 2 && side === 'X' && moves[0].side === 'X' && moves[1].side === 'O') {
    const a = moves[0]
    const o = moves[1]
    const dx = o.x - a.x
    const dy = o.y - a.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return null
    const options =
      dx === 0
        ? [
            { x: a.x + 1, y: o.y },
            { x: a.x - 1, y: o.y },
          ]
        : dy === 0
          ? [
              { x: o.x, y: a.y + 1 },
              { x: o.x, y: a.y - 1 },
            ]
          : [
              { x: a.x + dx, y: a.y - dy },
              { x: a.x - dx, y: a.y + dy },
            ]
    return pickNearCenter(options, taken, rng)
  }
  return null
}

// ---- move choice -------------------------------------------------------------------------------

const VCF_DEPTH = 14
/** VCT depths tried in turn (iterative deepening finds short wins fast; a deep-first search times out). */
const VCT_DEPTHS = [2, 4, 6, 8, 10, 12]
const DEFENSE_VCT_MAX = 10

/** True when the side to move must act at once: it can make five, must stop a five, or has an open four. */
export function isForcedPosition(moves: Move[], side: Side): boolean {
  const e = new GauntletEngine(moves)
  const me = side === 'X' ? 1 : 2
  const opp = 3 - me
  return e.n5[me] > 0 || e.n5[opp] > 0 || e.n4o[me] > 0
}

/** Chooses the Gauntlet bot's move. Stays within `timeBudgetMs` (plus one node's worth). */
export function chooseGauntletMove(moves: Move[], side: Side, opts: GauntletOptions): Cell {
  const book = bookMove(moves, side, opts.rng)
  if (book) return book

  generation = (generation + 1) & 0xffff || 1
  const start = performance.now()
  const budget = opts.timeBudgetMs
  const e = new GauntletEngine(moves)
  const me = side === 'X' ? 1 : 2
  const opp = 3 - me

  // Immediate tactics.
  if (e.n5[me] > 0) return toCell(e.firstAt(me, FIVE))
  if (e.n5[opp] > 0) return toCell(e.firstAt(opp, FIVE))
  if (e.n4o[me] > 0) return toCell(e.firstAt(me, OPEN4))
  const anyEmpty = [...e.cand].find((q) => e.b[q] === EMPTY)
  if (anyEmpty === undefined) return { x: 0, y: 0 }

  const within = (frac: number, f: () => number): number => {
    e.deadline = start + budget * frac
    try {
      return f()
    } catch (err) {
      if (err instanceof Timeout) return -1
      throw err
    }
  }

  // 1. Our own forced wins: VCF, then VCT with increasing depth.
  let win = within(0.1, () => e.vcf(me, VCF_DEPTH))
  if (win >= 0) return toCell(win)
  win = within(0.35, () => {
    for (const d of VCT_DEPTHS) {
      const r = e.vct(me, d)
      if (r >= 0) return r
    }
    return -1
  })
  if (win >= 0) return toCell(win)

  // 2. Root moves; keep only those that stop the opponent's forced wins (VCF/VCT). The threat is
  // probed with increasing depth; candidate moves are then checked a little deeper than it was found.
  let root = e.orderedMoves(me, 99, 0, -1)
  if (root.length === 1) return toCell(root[0])
  const threatDepth = within(0.45, () => {
    if (e.vcf(opp, VCF_DEPTH) >= 0) return 0
    for (const d of VCT_DEPTHS) {
      if (d > DEFENSE_VCT_MAX) break
      if (e.vct(opp, d) >= 0) return d
    }
    return -1
  })
  if (threatDepth >= 0) {
    const checkDepth = Math.min(DEFENSE_VCT_MAX, threatDepth + 2)
    const pool = [...new Set([...root, ...e.fourMoves(me), ...e.topCells(me, 24)])]
    const safe: number[] = []
    const unsafe: number[] = []
    e.deadline = start + budget * 0.7
    try {
      for (const q of pool) {
        e.place(q, me)
        try {
          if (e.vcf(opp, VCF_DEPTH) < 0 && (checkDepth === 0 || e.vct(opp, checkDepth) < 0)) safe.push(q)
          else unsafe.push(q)
        } finally {
          e.unplace(q, me)
        }
      }
    } catch (err) {
      if (!(err instanceof Timeout)) throw err
    }
    // Out of time or not: moves proven safe win; otherwise prefer unchecked moves over refuted ones.
    if (safe.length > 0) root = safe
    else if (unsafe.length > 0) root = [...root.filter((q) => !unsafe.includes(q)), ...unsafe]
    if (root.length === 1) return toCell(root[0])
  }

  const hints = opts.hints
  if (hints && hints.size > 0) {
    root = filterByHints(
      root.map((q) => toCell(q)),
      hints,
    ).map((cell) => toIdx(cell.x, cell.y))
    if (root.length === 1) return toCell(root[0])
    const weight = (q: number) => hints.get(`${toCell(q).x},${toCell(q).y}`)?.w ?? 0
    root = root
      .map((q, i) => ({ q, i }))
      .sort((a, b) => weight(b.q) - weight(a.q) || a.i - b.i)
      .map((entry) => entry.q)
  }

  // 3. Iterative-deepening PVS for the rest of the budget (a timed-out iteration still informs the choice).
  e.deadline = start + budget * 0.97
  e.killers.fill(-1)
  let bestMove = root[0]
  for (let depth = 1; depth <= 20; depth++) {
    let alpha = -Infinity
    let bestScore = -Infinity
    let iterBest = -1
    let firstValue = -Infinity
    let completed = false
    try {
      for (let i = 0; i < root.length; i++) {
        const q = root[i]
        e.place(q, me)
        let v: number
        try {
          if (i === 0) v = -e.search(depth - 1, -Infinity, Infinity, opp, 1)
          else {
            v = -e.search(depth - 1, -alpha - 1, -alpha, opp, 1)
            if (v > alpha) v = -e.search(depth - 1, -Infinity, -alpha, opp, 1)
          }
        } finally {
          e.unplace(q, me)
        }
        if (i === 0) firstValue = v
        const score = v + hintBonus(toCell(q), hints)
        if (v > alpha) {
          alpha = v
        }
        if (score > bestScore) {
          bestScore = score
          iterBest = q
        }
      }
      completed = true
    } catch (err) {
      if (!(err instanceof Timeout)) throw err
    }
    if (completed) {
      bestMove = iterBest
      if (alpha >= MATE) break // forced win found
      root = [iterBest, ...root.filter((q) => q !== iterBest)]
    } else {
      // Partial iteration: a move that beat the previous best at this depth is better information.
      if (iterBest >= 0 && iterBest !== root[0] && bestScore > firstValue + hintBonus(toCell(root[0]), hints)) bestMove = iterBest
      break
    }
  }
  return toCell(bestMove)
}

// Exposed for tests.
export const __test = { toIdx, toCell, STRIDE }
