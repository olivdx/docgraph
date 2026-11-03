/**
 * 9×9 Sudoku generator and solver. Pure and dependency-free, so it runs on the server (rooms) and in
 * the browser (solo). Grids are 81-char strings, row-major, '0' = empty.
 */
import type { Difficulty } from './types'

export const GIVENS: Record<Difficulty, { min: number; max: number }> = {
  easy: { min: 38, max: 42 },
  medium: { min: 30, max: 34 },
  hard: { min: 25, max: 28 },
}

const ROW = (i: number) => Math.floor(i / 9)
const COL = (i: number) => i % 9
const BOX = (i: number) => Math.floor(ROW(i) / 3) * 3 + Math.floor(COL(i) / 3)

/** For each cell, the 20 other cells sharing its row, column or box. */
export const PEERS: number[][] = Array.from({ length: 81 }, (_, i) => {
  const out: number[] = []
  for (let j = 0; j < 81; j++) {
    if (j !== i && (ROW(j) === ROW(i) || COL(j) === COL(i) || BOX(j) === BOX(i))) out.push(j)
  }
  return out
})

const ALL = 0x3fe // bits 1..9

function popcount(n: number): number {
  let c = 0
  while (n) {
    n &= n - 1
    c++
  }
  return c
}

/**
 * Counts solutions of `cells` (mutated during search, restored after), stopping at `limit`.
 * When `rng` is given, digits are tried in random order and the first solution found is left in
 * `out` (used to build a random full grid).
 */
function search(cells: number[], limit: number, rng?: () => number, out?: number[]): number {
  const rows = new Array(9).fill(0)
  const cols = new Array(9).fill(0)
  const boxes = new Array(9).fill(0)
  for (let i = 0; i < 81; i++) {
    const d = cells[i]
    if (!d) continue
    const bit = 1 << d
    if ((rows[ROW(i)] | cols[COL(i)] | boxes[BOX(i)]) & bit) return 0 // contradictory givens
    rows[ROW(i)] |= bit
    cols[COL(i)] |= bit
    boxes[BOX(i)] |= bit
  }
  let count = 0
  const rec = (): boolean => {
    // most-constrained empty cell
    let best = -1
    let bestMask = 0
    let bestCount = 10
    for (let i = 0; i < 81; i++) {
      if (cells[i]) continue
      const mask = ALL & ~(rows[ROW(i)] | cols[COL(i)] | boxes[BOX(i)])
      const c = popcount(mask)
      if (c < bestCount) {
        best = i
        bestMask = mask
        bestCount = c
        if (c <= 1) break
      }
    }
    if (best === -1) {
      count++
      if (out && count === 1) for (let i = 0; i < 81; i++) out[i] = cells[i]
      return count >= limit
    }
    if (bestCount === 0) return false
    const digits: number[] = []
    for (let d = 1; d <= 9; d++) if (bestMask & (1 << d)) digits.push(d)
    if (rng) shuffle(digits, rng)
    const r = ROW(best)
    const c = COL(best)
    const b = BOX(best)
    for (const d of digits) {
      const bit = 1 << d
      cells[best] = d
      rows[r] |= bit
      cols[c] |= bit
      boxes[b] |= bit
      const stop = rec()
      cells[best] = 0
      rows[r] &= ~bit
      cols[c] &= ~bit
      boxes[b] &= ~bit
      if (stop) return true
    }
    return false
  }
  rec()
  return count
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const toCells = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) - 48)
export const toStr = (cells: number[]): string => cells.join('')

/** Number of solutions of `grid`, capped at `limit` (default 2: enough to tell "unique"). */
export function countSolutions(grid: string, limit = 2): number {
  return search(toCells(grid), limit)
}

/** The solution of `grid`, or null when it has none. */
export function solve(grid: string): string | null {
  const out = new Array(81).fill(0)
  return search(toCells(grid), 1, undefined, out) ? toStr(out) : null
}

function randomFullGrid(rng: () => number): number[] {
  const out = new Array(81).fill(0)
  search(new Array(81).fill(0), 1, rng, out)
  return out
}

/**
 * A random puzzle with exactly one solution and a given count inside the difficulty's range.
 * Cells are removed in random order while the solution stays unique; a pass that can't get down
 * to the range starts over with a fresh grid (rare, mostly on hard). The best attempt is kept as a
 * fallback so this always returns.
 */
export function generate(difficulty: Difficulty, rng: () => number = Math.random): { puzzle: string; solution: string } {
  const { min, max } = GIVENS[difficulty]
  const target = min + Math.floor(rng() * (max - min + 1))
  let best: { puzzle: string; solution: string; givens: number } | null = null
  for (let attempt = 0; attempt < 20; attempt++) {
    const solution = randomFullGrid(rng)
    const cells = [...solution]
    let givens = 81
    for (const i of shuffle([...Array(81).keys()], rng)) {
      if (givens <= target) break
      const keep = cells[i]
      cells[i] = 0
      if (search(cells, 2) !== 1) cells[i] = keep
      else givens--
    }
    const res = { puzzle: toStr(cells), solution: toStr(solution), givens }
    if (givens <= max) return { puzzle: res.puzzle, solution: res.solution }
    if (!best || givens < best.givens) best = res
  }
  return { puzzle: best!.puzzle, solution: best!.solution }
}

export const givenCount = (puzzle: string): number => [...puzzle].filter((c) => c !== '0').length
