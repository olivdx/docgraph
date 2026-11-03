/**
 * Sudoku room state transitions. Pure: every function takes a room and returns a new one (or throws
 * RoomError). Time rules are applied lazily by `settleSudoku`, which every command runs first.
 */
import { RoomError } from '@/src/tournament/types'
import { FINISHED_TTL_MS, GAME_MS, LOBBY_TTL_MS, MAX_PLAYERS, MIN_PLAYERS, PENALTY_MS } from './constants'
import { generate, givenCount } from './generator'
import type { Difficulty, SudokuPlayer, SudokuRoom } from './types'

export interface UserInfo {
  userId: string
  name: string
  avatarUrl: string | null
}

const clone = (r: SudokuRoom): SudokuRoom => structuredClone(r)

function newPlayer(u: UserInfo, now: number): SudokuPlayer {
  return {
    userId: u.userId,
    name: u.name,
    avatarUrl: u.avatarUrl,
    joinedAt: now,
    grid: '',
    mistakes: 0,
    deadlineAt: null,
    finishedAt: null,
    outAt: null,
    outReason: null,
    lastCorrectAt: null,
    lastEntry: null,
  }
}

export function createSudokuRoom(args: {
  code: string
  host: UserInfo
  name?: string
  difficulty?: Difficulty
  now: number
}): SudokuRoom {
  const { code, host, now } = args
  return {
    _id: code,
    name: args.name || `${host.name.split(' ')[0] || 'Player'}'s Sudoku`,
    hostId: host.userId,
    difficulty: args.difficulty ?? 'medium',
    status: 'lobby',
    puzzle: null,
    solution: null,
    players: [newPlayer(host, now)],
    startedAt: null,
    finishedAt: null,
    winnerId: null,
    version: 0,
    createdAt: now,
    expiresAt: new Date(now + LOBBY_TTL_MS),
  }
}

/** Still racing: started, not solved, not out. */
export const isRacing = (p: SudokuPlayer) => p.deadlineAt !== null && p.finishedAt === null && p.outAt === null

/** In the lobby, or still racing in a playing room. Finished / out players are free to go elsewhere. */
export function isActiveSudoku(room: SudokuRoom, userId: string): boolean {
  const p = room.players.find((x) => x.userId === userId)
  if (!p) return false
  if (room.status === 'lobby') return true
  return room.status === 'playing' && isRacing(p)
}

/** Correct cells this player has filled in (givens excluded). */
export function correctCells(room: SudokuRoom, p: SudokuPlayer): number {
  if (!room.puzzle || !p.grid) return 0
  return givenCount(p.grid) - givenCount(room.puzzle)
}

export interface RankRow {
  place: number
  userId: string
  name: string
  cells: number
  finishedAt: number | null
  mistakes: number
  outReason: SudokuPlayer['outReason']
}

/**
 * Finishers by finish time; then most correct cells, fewer mistakes, earlier last correct entry.
 * Players equal on every key share a place.
 */
export function ranking(room: SudokuRoom): RankRow[] {
  const key = (p: SudokuPlayer): number[] => [
    p.finishedAt === null ? 1 : 0,
    p.finishedAt ?? 0,
    -correctCells(room, p),
    p.mistakes,
    p.lastCorrectAt ?? Number.MAX_SAFE_INTEGER,
  ]
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
    return 0
  }
  const sorted = [...room.players].sort((a, b) => cmp(key(a), key(b)))
  const rows: RankRow[] = []
  sorted.forEach((p, i) => {
    const tied = i > 0 && cmp(key(p), key(sorted[i - 1])) === 0
    rows.push({
      place: tied ? rows[i - 1].place : i + 1,
      userId: p.userId,
      name: p.name,
      cells: correctCells(room, p),
      finishedAt: p.finishedAt,
      mistakes: p.mistakes,
      outReason: p.outReason,
    })
  })
  return rows
}

function finish(room: SudokuRoom, at: number): void {
  room.status = 'finished'
  room.finishedAt = at
  room.winnerId = ranking(room)[0]?.userId ?? null
  room.expiresAt = new Date(at + FINISHED_TTL_MS)
}

/** Times out players whose clock has run out; ends the room once nobody is racing. */
export function settleSudoku(input: SudokuRoom, now: number): { room: SudokuRoom; changed: boolean } {
  if (input.status !== 'playing') return { room: input, changed: false }
  const room = clone(input)
  let changed = false
  for (const p of room.players) {
    if (isRacing(p) && p.deadlineAt! <= now) {
      p.outAt = p.deadlineAt
      p.outReason = 'timeout'
      changed = true
    }
  }
  if (!room.players.some(isRacing)) {
    finish(room, Math.max(...room.players.map((p) => p.finishedAt ?? p.outAt ?? now)))
    changed = true
  }
  return { room: changed ? room : input, changed }
}

// ---- lobby -------------------------------------------------------------------------------------

function inLobby(room: SudokuRoom): void {
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
}

function asHost(room: SudokuRoom, userId: string): void {
  if (room.hostId !== userId) throw new RoomError('not_host')
}

export function joinSudoku(input: SudokuRoom, user: UserInfo, now: number): SudokuRoom {
  if (input.players.some((p) => p.userId === user.userId)) return input
  inLobby(input)
  if (input.players.length >= MAX_PLAYERS) throw new RoomError('full')
  const room = clone(input)
  room.players.push(newPlayer(user, now))
  return room
}

export function leaveSudoku(input: SudokuRoom, userId: string): SudokuRoom {
  if (!input.players.some((p) => p.userId === userId)) return input
  inLobby(input)
  if (input.hostId === userId) throw new RoomError('host_must_cancel')
  const room = clone(input)
  room.players = room.players.filter((p) => p.userId !== userId)
  return room
}

export function cancelSudoku(input: SudokuRoom, userId: string, now: number): SudokuRoom {
  asHost(input, userId)
  inLobby(input)
  const room = clone(input)
  room.status = 'cancelled'
  room.expiresAt = new Date(now + FINISHED_TTL_MS)
  return room
}

export function setDifficulty(input: SudokuRoom, userId: string, difficulty: Difficulty): SudokuRoom {
  asHost(input, userId)
  inLobby(input)
  if (input.difficulty === difficulty) return input
  return { ...clone(input), difficulty }
}

export function startSudoku(input: SudokuRoom, userId: string, now: number, rng: () => number): SudokuRoom {
  asHost(input, userId)
  inLobby(input)
  if (input.players.length < MIN_PLAYERS) throw new RoomError('too_few_players')
  const room = clone(input)
  const { puzzle, solution } = generate(room.difficulty, rng)
  room.status = 'playing'
  room.puzzle = puzzle
  room.solution = solution
  room.startedAt = now
  room.expiresAt = new Date(now + GAME_MS + LOBBY_TTL_MS)
  for (const p of room.players) {
    p.grid = puzzle
    p.deadlineAt = now + GAME_MS
  }
  return room
}

// ---- play --------------------------------------------------------------------------------------

function racer(room: SudokuRoom, userId: string): SudokuPlayer {
  const p = room.players.find((x) => x.userId === userId)
  if (!p) throw new RoomError('not_participant')
  if (room.status !== 'playing' || !isRacing(p)) throw new RoomError('not_playing')
  return p
}

/**
 * Places `digit` in `cell` for `userId`. A correct digit locks in; a wrong one isn't kept and costs
 * PENALTY_MS of that player's clock. `seq` must increase per player: a seq at or below the last
 * one is a retry and returns the room unchanged (never charged twice).
 */
export function enterDigit(
  input: SudokuRoom,
  userId: string,
  cell: number,
  digit: number,
  seq: number,
  now: number,
): SudokuRoom {
  const { room: settled } = settleSudoku(input, now)
  const existing = settled.players.find((x) => x.userId === userId)
  if (existing?.lastEntry && seq <= existing.lastEntry.seq) return settled
  const room = clone(settled)
  const p = racer(room, userId)
  if (p.grid[cell] !== '0') throw new RoomError('occupied')
  const correct = room.solution![cell] === String(digit)
  p.lastEntry = { seq, cell, digit, correct, at: now }
  if (correct) {
    p.grid = p.grid.slice(0, cell) + digit + p.grid.slice(cell + 1)
    p.lastCorrectAt = now
    if (p.grid === room.solution) {
      p.finishedAt = now
      for (const o of room.players) {
        if (isRacing(o)) {
          o.outAt = now
          o.outReason = 'stopped'
        }
      }
      finish(room, now)
    }
    return room
  }
  p.mistakes++
  p.deadlineAt = p.deadlineAt! - PENALTY_MS
  return settleSudoku(room, now).room
}

export function giveUp(input: SudokuRoom, userId: string, now: number): SudokuRoom {
  const { room: settled } = settleSudoku(input, now)
  const room = clone(settled)
  const p = racer(room, userId)
  p.outAt = now
  p.outReason = 'gave_up'
  return settleSudoku(room, now).room
}
