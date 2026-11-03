import { givenCount } from './generator'
import { correctCells, isRacing, ranking, type RankRow } from './room'
import type { Difficulty, OutReason, SudokuEntry, SudokuRoom, SudokuStatus } from './types'

export type PlayerState = 'lobby' | 'racing' | 'solved' | OutReason

export interface SudokuPlayerView {
  userId: string
  name: string
  avatarUrl: string | null
  isHost: boolean
  state: PlayerState
  cells: number
  mistakes: number
}

export interface SudokuView {
  code: string
  name: string
  hostName: string
  difficulty: Difficulty
  status: SudokuStatus
  youId: string
  youAreIn: boolean
  youAreHost: boolean
  inviteUrl: string
  serverNow: number
  startedAt: number | null
  /** Cells to fill (81 − givens); 0 before Start. */
  toFill: number
  players: SudokuPlayerView[]
  /** The givens: only for members while playing, and for everyone once finished. */
  puzzle: string | null
  /** Only once finished. */
  solution: string | null
  you: {
    grid: string
    mistakes: number
    deadlineAt: number | null
    state: PlayerState
    lastEntry: SudokuEntry | null
  } | null
  winnerId: string | null
  ranking: RankRow[] | null
  version: number
}

export interface SudokuSummary {
  code: string
  name: string
  hostName: string
  difficulty: Difficulty
  status: SudokuStatus
  playerCount: number
  youAreIn: boolean
}

function stateOf(room: SudokuRoom, p: SudokuRoom['players'][number]): PlayerState {
  if (room.status === 'lobby' || room.status === 'cancelled') return 'lobby'
  if (p.finishedAt !== null) return 'solved'
  if (p.outReason) return p.outReason
  return isRacing(p) ? 'racing' : 'timeout'
}

export function toSudokuView(room: SudokuRoom, userId: string, now: number, inviteUrl: string): SudokuView {
  const me = room.players.find((p) => p.userId === userId) ?? null
  const finished = room.status === 'finished'
  const host = room.players.find((p) => p.userId === room.hostId)
  return {
    code: room._id,
    name: room.name,
    hostName: host?.name ?? '?',
    difficulty: room.difficulty,
    status: room.status,
    youId: userId,
    youAreIn: !!me,
    youAreHost: room.hostId === userId,
    inviteUrl,
    serverNow: now,
    startedAt: room.startedAt,
    toFill: room.puzzle ? 81 - givenCount(room.puzzle) : 0,
    players: room.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      avatarUrl: p.avatarUrl,
      isHost: p.userId === room.hostId,
      state: stateOf(room, p),
      cells: correctCells(room, p),
      mistakes: p.mistakes,
    })),
    puzzle: finished || (me && room.status === 'playing') ? room.puzzle : null,
    solution: finished ? room.solution : null,
    you:
      me && me.grid
        ? {
            grid: me.grid,
            mistakes: me.mistakes,
            deadlineAt: me.deadlineAt,
            state: stateOf(room, me),
            lastEntry: me.lastEntry,
          }
        : null,
    winnerId: room.winnerId,
    ranking: finished ? ranking(room) : null,
    version: room.version,
  }
}

export function toSudokuSummary(room: SudokuRoom, userId: string): SudokuSummary {
  return {
    code: room._id,
    name: room.name,
    hostName: room.players.find((p) => p.userId === room.hostId)?.name ?? '?',
    difficulty: room.difficulty,
    status: room.status,
    playerCount: room.players.length,
    youAreIn: room.players.some((p) => p.userId === userId),
  }
}
