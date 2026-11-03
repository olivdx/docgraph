import type { Cell, Move, Side } from '@/src/game/types'

export type RoomStatus = 'lobby' | 'running' | 'finished' | 'cancelled'
export type MatchStatus = 'waiting' | 'pending' | 'playing' | 'finished' // waiting = an entrant still TBD
export type EndReason = 'five_in_row' | 'turn_timeout' | 'disconnect_timeout' | 'resign' | 'no_show' | 'board_full'

export interface Player {
  userId: string
  name: string
  avatarUrl: string | null
  isBot: boolean
  seed: number | null
  joinedAt: number
}

export interface Match {
  id: string
  round: number
  slot: number
  kind: 'normal' | 'third_place'
  a: string | null
  b: string | null
  X: string | null
  O: string | null
  status: MatchStatus
  pendingSince: number | null
  startedAt: number | null
  readyAt: { X: number | null; O: number | null }
  moves: Move[]
  turnDeadlineAt: number | null
  botMoveDueAt: number | null
  winner: Side | null
  endReason: EndReason | null
  winLine: Cell[] | null
  finishedAt: number | null
}

export interface Room {
  _id: string
  name: string
  hostId: string
  status: RoomStatus
  players: Player[]
  totalRounds: number
  matches: Match[]
  placements: { first: string | null; second: string | null; third: string | null }
  version: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  expiresAt: Date
}

/** A room as listed for summaries: `matches[].moves` is projected out (never needed there). */
export type ListedRoom = Omit<Room, 'matches'> & { matches: Omit<Match, 'moves'>[] }

export type RoomErrorCode =
  | 'not_found' | 'not_lobby' | 'full' | 'not_host' | 'host_must_cancel' | 'too_few_players'
  | 'not_participant' | 'not_playing' | 'not_your_turn' | 'occupied' | 'out_of_bounds' | 'already_active' | 'conflict'

export class RoomError extends Error {
  constructor(public code: RoomErrorCode, public extra?: Record<string, unknown>) {
    super(code)
    this.name = 'RoomError'
  }
}
