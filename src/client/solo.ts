import { GAME_MS, PENALTY_MS } from '@/src/sudoku/constants'
import { generate } from '@/src/sudoku/generator'
import type { Difficulty } from '@/src/sudoku/types'

/** A solo game lives only in this browser (localStorage), so a reload resumes it. */
export interface SoloGame {
  difficulty: Difficulty
  puzzle: string
  solution: string
  grid: string
  mistakes: number
  startedAt: number
  deadlineAt: number
  finishedAt: number | null
  outAt: number | null
  outReason: 'timeout' | 'gave_up' | null
}

const KEY = 'sudoku:solo'
export const SOLO_NOTES_KEY = 'sudoku:notes:solo'

export function loadSolo(): SoloGame | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as SoloGame) : null
  } catch {
    return null
  }
}

export function saveSolo(g: SoloGame): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(g))
  } catch {}
}

export function newSolo(difficulty: Difficulty, now = Date.now()): SoloGame {
  const { puzzle, solution } = generate(difficulty)
  try {
    localStorage.removeItem(SOLO_NOTES_KEY)
  } catch {}
  return {
    difficulty,
    puzzle,
    solution,
    grid: puzzle,
    mistakes: 0,
    startedAt: now,
    deadlineAt: now + GAME_MS,
    finishedAt: null,
    outAt: null,
    outReason: null,
  }
}

export const soloOver = (g: SoloGame) => g.finishedAt !== null || g.outAt !== null

/** Applies the time-out if the clock ran out. */
export function settleSolo(g: SoloGame, now = Date.now()): SoloGame {
  if (soloOver(g) || now < g.deadlineAt) return g
  return { ...g, outAt: g.deadlineAt, outReason: 'timeout' }
}

/** Same rules as a room: right digit locks in, wrong one costs PENALTY_MS. */
export function soloEnter(g0: SoloGame, cell: number, digit: number, now = Date.now()): { game: SoloGame; correct: boolean } {
  const g = settleSolo(g0, now)
  if (soloOver(g) || g.grid[cell] !== '0') return { game: g, correct: false }
  if (g.solution[cell] === String(digit)) {
    const grid = g.grid.slice(0, cell) + digit + g.grid.slice(cell + 1)
    return { game: { ...g, grid, finishedAt: grid === g.solution ? now : null }, correct: true }
  }
  return { game: settleSolo({ ...g, mistakes: g.mistakes + 1, deadlineAt: g.deadlineAt - PENALTY_MS }, now), correct: false }
}
