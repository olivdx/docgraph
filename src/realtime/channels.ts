import type { Move } from '@/src/game/types'

/** Doorbell: something changed and is stored; subscribers re-fetch through the API. */
export const CHANGED_EVENT = 'changed'
/**
 * A human move in a human-vs-human match, published *before* it is stored so the opponent can
 * draw it at once. It may still be lost (CAS conflict, deadline passed): the `changed` doorbell
 * and polling always bring the stored truth, which wins after a short grace period.
 */
export const MOVE_EVENT = 'move'

export interface MoveSignal {
  matchId: string
  /** 1-based game number within the match (Bo3); a signal for another game is ignored. */
  game: number
  /** Index of `moves[0]` in the current game's move list. */
  from: number
  moves: Move[]
  /** The next player's turn clock as of the move, or null when the move ended the game. */
  turnRemainingMs: number | null
}

/** Realtime channel names, shared by server (publish) and client (subscribe). Codes are upper-case. */
export const caroRoomChannel = (code: string) => `caro:${code.toUpperCase()}`
export const caroMatchChannel = (code: string, matchId: string) => `caro:${code.toUpperCase()}:${matchId}`
export const sudokuChannel = (code: string) => `sudoku:${code.toUpperCase()}`
export const battleshipRoomChannel = (code: string) => `battleship:${code.toUpperCase()}`
export const battleshipMatchChannel = (code: string, matchId: string) => `battleship:${code.toUpperCase()}:${matchId}`
