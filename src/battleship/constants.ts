import type { ShipKey } from './types'

export { FINISHED_TTL_MS, LOBBY_TTL_MS } from '@/src/tournament/constants'

/** The sea is N×N; cell = row * N + col. */
export const N = 10
export const CELLS = N * N
/** The classic 5-4-3-3-2 fleet (17 of 100 cells). */
export const FLEET: readonly { key: ShipKey; name: string; len: number }[] = [
  { key: 'ghost', name: 'Ghost Ship', len: 5 },
  { key: 'galleon', name: 'Galleon', len: 4 },
  { key: 'frigate', name: 'Frigate', len: 3 },
  { key: 'brig', name: 'Brig', len: 3 },
  { key: 'sloop', name: 'Sloop', len: 2 },
]
export const MAX_SHIP_LEN = Math.max(...FLEET.map((f) => f.len))

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
