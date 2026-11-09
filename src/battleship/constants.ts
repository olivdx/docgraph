import type { ShipKey } from './types'

export { FINISHED_TTL_MS, LOBBY_TTL_MS } from '@/src/tournament/constants'

/** The sea is N×N; cell = row * N + col. */
export const N = 6
export const CELLS = N * N
export const FLEET: readonly { key: ShipKey; name: string; len: number }[] = [
  { key: 'galleon', name: 'Galleon', len: 3 },
  { key: 'brig', name: 'Brig', len: 2 },
  { key: 'sloop', name: 'Sloop', len: 2 },
]

/** Caro codes are 6 chars, Sudoku 5, Battleship 4: a ref link's game is clear from its length. */
export const BATTLE_CODE_LEN = 4
export const MATCH_ID_LEN = 4
export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 32

export const PLACE_MS = 45_000
export const TURN_MS = 20_000
/** Added to the next turn after a shot: covers the poll delay and the shot animation. */
export const SHOT_GRACE_MS = 3_000
export const MAX_MISSED_TURNS = 3
export const NO_SHOW_MS = 60_000
export const DISCONNECT_DETECT_MS = 5_000
export const RECONNECT_GRACE_MS = 30_000
