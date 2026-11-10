export type ShipKey = 'ghost' | 'galleon' | 'frigate' | 'brig' | 'sloop'

export interface Ship {
  key: ShipKey
  /** Board cells (row * N + col), in order along the ship. */
  cells: number[]
}

export type Seat = 'a' | 'b'
export type ShotResult = 'miss' | 'hit' | 'sunk'

export interface Shot {
  /** Per-shooter sequence number, 1-based (idempotency for retried requests). */
  seq: number
  cell: number
  result: ShotResult
  /** The ship hit (stored for hit and sunk; views reveal it only for sunk). */
  shipKey: ShipKey | null
  at: number
  /** Fired by the server because the turn clock ran out. */
  auto: boolean
}

export type BattleMatchStatus = 'waiting' | 'pending' | 'placing' | 'playing' | 'finished'
/** `left`: the loser left the cup (Leave cup, or started/joined another cup). */
export type BattleEndReason = 'fleet_sunk' | 'no_show' | 'afk' | 'disconnect_timeout' | 'resign' | 'bye' | 'left'

export interface BattleMatch {
  id: string
  round: number
  slot: number
  kind: 'normal' | 'third_place'
  a: string | null
  b: string | null
  status: BattleMatchStatus
  pendingSince: number | null
  readyAt: Record<Seat, number | null>
  placingStartedAt: number | null
  placingDeadlineAt: number | null
  /** Never sent to the opponent before a ship sinks or the match ends (see views). */
  fleets: Record<Seat, Ship[]>
  lockedAt: Record<Seat, number | null>
  /** When the battle (shooting) started. */
  startedAt: number | null
  turn: Seat | null
  turnDeadlineAt: number | null
  missedTurns: Record<Seat, number>
  /** Shots fired BY each seat. */
  shots: Record<Seat, Shot[]>
  winner: Seat | null
  endReason: BattleEndReason | null
  finishedAt: number | null
}

export interface BattlePlayer {
  userId: string
  name: string
  avatarUrl: string | null
  /** Set when the player left a running cup: every match of theirs is lost (missing on older rooms). */
  leftAt?: number | null
  seed: number | null
  joinedAt: number
}

export type BattleRoomStatus = 'lobby' | 'running' | 'finished' | 'cancelled'

export interface BattleRoom {
  _id: string
  name: string
  hostId: string
  status: BattleRoomStatus
  players: BattlePlayer[]
  totalRounds: number
  matches: BattleMatch[]
  placements: { first: string | null; second: string | null; third: string | null }
  version: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  expiresAt: Date
}
