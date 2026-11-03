export type Difficulty = 'easy' | 'medium' | 'hard'
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']
export const isDifficulty = (v: unknown): v is Difficulty => DIFFICULTIES.includes(v as Difficulty)

export type SudokuStatus = 'lobby' | 'playing' | 'finished' | 'cancelled'
/** Why a player stopped before solving: own clock ran out, gave up, or someone else solved first. */
export type OutReason = 'timeout' | 'gave_up' | 'stopped'

export interface SudokuEntry {
  seq: number
  cell: number
  digit: number
  correct: boolean
  at: number
}

export interface SudokuPlayer {
  userId: string
  name: string
  avatarUrl: string | null
  joinedAt: number
  /** 81 chars: givens plus this player's correct entries. Empty until the game starts. */
  grid: string
  mistakes: number
  deadlineAt: number | null
  finishedAt: number | null
  outAt: number | null
  outReason: OutReason | null
  lastCorrectAt: number | null
  /** The last entry this player made (idempotency: a retried seq returns this instead of re-applying). */
  lastEntry: SudokuEntry | null
}

export interface SudokuRoom {
  _id: string
  name: string
  hostId: string
  difficulty: Difficulty
  status: SudokuStatus
  /** 81 chars, '0' = empty. Null until Start. */
  puzzle: string | null
  /** Never sent to clients before the room is finished. */
  solution: string | null
  players: SudokuPlayer[]
  startedAt: number | null
  finishedAt: number | null
  winnerId: string | null
  version: number
  createdAt: number
  expiresAt: Date
}
