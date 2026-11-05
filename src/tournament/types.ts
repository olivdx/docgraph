import type { Cell, Move, Side } from '@/src/game/types'

export type RoomStatus = 'lobby' | 'running' | 'finished' | 'cancelled'
export type MatchStatus = 'waiting' | 'pending' | 'playing' | 'finished' // waiting = an entrant still TBD
/** `left`: free play ended because a player left (or let the rematch wait run out). */
export type EndReason = 'five_in_row' | 'turn_timeout' | 'disconnect_timeout' | 'resign' | 'no_show' | 'board_full' | 'left'

export interface Player {
  userId: string
  name: string
  avatarUrl: string | null
  isBot: boolean
  seed: number | null
  joinedAt: number
}

export type BestOf = 1 | 3
export const isBestOf = (v: unknown): v is BestOf => v === 1 || v === 3

/** `cup`: the knockout tournament (Bo1/Bo3). `free`: one 1-vs-1 match (or vs a bot) with endless rematches. */
export type RoomMode = 'cup' | 'free'
/** What the host picks in the lobby. */
export type MatchFormat = 'bo1' | 'bo3' | 'free'
export const isMatchFormat = (v: unknown): v is MatchFormat => v === 'bo1' || v === 'bo3' || v === 'free'

/** Host picks in the lobby; applies to every human-vs-bot move once the room starts. */
export type BotLevel = 'prelude' | 'duel' | 'gauntlet'
export const isBotLevel = (v: unknown): v is BotLevel => v === 'prelude' || v === 'duel' || v === 'gauntlet'
export const resolveBotLevel = (room: Pick<Room, 'botLevel'>): BotLevel => room.botLevel ?? 'duel'

/** A completed game of a match (Bo3 has up to three). */
export interface GameResult {
  winner: string // userId
  endReason: EndReason
  finishedAt: number
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
  /** The current game's moves (during a break between games: the finished game's). */
  moves: Move[]
  /** Completed games, in order. */
  games: GameResult[]
  /** End of the break before the next game (Bo3), else null. */
  nextGameAt: number | null
  /** Free play, after a game: waiting since `since` for both players to accept a rematch (bots accept at once). */
  rematch: { since: number; ready: string[] } | null
  turnDeadlineAt: number | null
  botMoveDueAt: number | null
  /** The match winner, as a side of the LAST game (sides swap per game), so `m[m.winner]` is their id. */
  winner: Side | null
  endReason: EndReason | null
  /** The last game's winning line (kept through a break). */
  winLine: Cell[] | null
  finishedAt: number | null
}

export interface Room {
  _id: string
  name: string
  hostId: string
  status: RoomStatus
  mode: RoomMode
  /** Cup only (free play is always one game at a time). */
  bestOf: BestOf
  /** Locked at start; missing on old rooms means duel (current bot). */
  botLevel?: BotLevel
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
  | 'not_found' | 'not_lobby' | 'full' | 'not_host' | 'host_must_cancel' | 'too_few_players' | 'too_many_players'
  | 'not_participant' | 'not_playing' | 'not_your_turn' | 'occupied' | 'out_of_bounds' | 'already_active' | 'conflict'

export class RoomError extends Error {
  constructor(public code: RoomErrorCode, public extra?: Record<string, unknown>) {
    super(code)
    this.name = 'RoomError'
  }
}
