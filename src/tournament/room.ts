import { isInside, sideToMove } from '@/src/game/rules'
import type { Cell } from '@/src/game/types'
import { planBracket } from './bracket'
import { randomCode } from './codes'
import { FINISHED_TTL_MS, LOBBY_TTL_MS, MATCH_ID_LEN, MAX_PLAYERS, MIN_HUMANS } from './constants'
import { applyMove, finishMatch, opposite, promoteIfReady, stepMatch, type Presence } from './match'
import { RoomError, type Match, type Player, type Room } from './types'

/**
 * Room aggregate. Every exported function is pure: it never mutates its input and returns a new
 * Room (or throws RoomError). Time and randomness are always injected.
 *
 * playMove / resign / markReady settle the room first. They accept an optional trailing
 * `presence` map; when it is omitted, disconnect deadlines are not evaluated by that call (the
 * service's settleRoom with real presence handles them).
 */

type Rng = () => number
type UserInfo = { userId: string; name: string; avatarUrl: string | null }

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Player'
}

function human(u: UserInfo, now: number): Player {
  return { userId: u.userId, name: u.name, avatarUrl: u.avatarUrl, isBot: false, seed: null, joinedAt: now }
}

// ---- lobby -------------------------------------------------------------------------------------

export function createRoom(p: { code: string; host: UserInfo; name?: string; now: number }): Room {
  const name = p.name?.trim() || `${firstWord(p.host.name)}'s Cup`
  return {
    _id: p.code,
    name,
    hostId: p.host.userId,
    status: 'lobby',
    players: [human(p.host, p.now)],
    totalRounds: 0,
    matches: [],
    placements: { first: null, second: null, third: null },
    version: 0,
    createdAt: p.now,
    startedAt: null,
    finishedAt: null,
    expiresAt: new Date(p.now + LOBBY_TTL_MS),
  }
}

export function joinRoom(room: Room, user: UserInfo, now: number): Room {
  const r = structuredClone(room)
  if (r.players.some((p) => p.userId === user.userId)) return r
  if (r.status !== 'lobby') throw new RoomError('not_lobby')
  if (r.players.length >= MAX_PLAYERS) throw new RoomError('full')
  r.players.push(human(user, now))
  return r
}

export function leaveRoom(room: Room, userId: string): Room {
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
  if (userId === room.hostId) throw new RoomError('host_must_cancel')
  const r = structuredClone(room)
  r.players = r.players.filter((p) => p.userId !== userId)
  return r
}

export function cancelRoom(room: Room, userId: string, now: number): Room {
  if (userId !== room.hostId) throw new RoomError('not_host')
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
  const r = structuredClone(room)
  r.status = 'cancelled'
  r.finishedAt = now
  r.expiresAt = new Date(now + FINISHED_TTL_MS)
  return r
}

function emptyMatch(id: string, round: number, slot: number, kind: Match['kind']): Match {
  return {
    id,
    round,
    slot,
    kind,
    a: null,
    b: null,
    X: null,
    O: null,
    status: 'waiting',
    pendingSince: null,
    startedAt: null,
    readyAt: { X: null, O: null },
    moves: [],
    turnDeadlineAt: null,
    botMoveDueAt: null,
    winner: null,
    endReason: null,
    winLine: null,
    finishedAt: null,
  }
}

export function startRoom(room: Room, userId: string, now: number, rng: Rng): Room {
  if (userId !== room.hostId) throw new RoomError('not_host')
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
  const humans = room.players.filter((p) => !p.isBot)
  if (humans.length < MIN_HUMANS) throw new RoomError('too_few_players')

  const r = structuredClone(room)
  const { size, totalRounds, order } = planBracket(humans, rng)
  r.players = order
  r.totalRounds = totalRounds
  r.status = 'running'
  r.startedAt = now
  // A running room must not be swept by the lobby TTL mid-tournament.
  r.expiresAt = new Date(now + LOBBY_TTL_MS)

  const used = new Set<string>()
  const newId = () => {
    let id: string
    do id = randomCode(MATCH_ID_LEN, rng)
    while (used.has(id))
    used.add(id)
    return id
  }
  const matches: Match[] = []
  for (let round = 0; round < totalRounds; round++) {
    const count = size >> (round + 1)
    for (let slot = 0; slot < count; slot++) matches.push(emptyMatch(newId(), round, slot, 'normal'))
  }
  if (size >= 4) matches.push(emptyMatch(newId(), totalRounds - 1, 1, 'third_place'))
  r.matches = matches

  for (const m of matches.filter((m) => m.round === 0)) {
    m.a = order[2 * m.slot].userId
    m.b = order[2 * m.slot + 1].userId
    promoteIfReady(r, m, now, rng)
  }
  settleInPlace(r, null, now, rng)
  return r
}

// ---- settle ------------------------------------------------------------------------------------

function finishRoomIfDone(r: Room, now: number): boolean {
  const final = r.matches.find((m) => m.kind === 'normal' && m.round === r.totalRounds - 1)
  const third = r.matches.find((m) => m.kind === 'third_place')
  if (!final || final.status !== 'finished' || !final.winner) return false
  if (third && third.status !== 'finished') return false
  r.placements = {
    first: final[final.winner],
    second: final[opposite(final.winner)],
    third: third?.winner ? third[third.winner] : null,
  }
  r.status = 'finished'
  r.finishedAt = now
  r.expiresAt = new Date(now + FINISHED_TTL_MS)
  return true
}

/** Mutates `r` (a private clone) until no deadline ≤ now remains. Returns whether anything changed. */
function settleInPlace(r: Room, presence: Presence, now: number, rng: Rng): boolean {
  if (r.status !== 'running') return false
  let changed = false
  for (;;) {
    let progress = false
    for (const m of r.matches) {
      while (stepMatch(r, m, presence, now, rng)) progress = true
    }
    if (!progress) break
    changed = true
  }
  if (finishRoomIfDone(r, now)) changed = true
  return changed
}

export function settleRoom(
  room: Room,
  presence: Record<string, number>,
  now: number,
  rng: Rng,
): { room: Room; changed: boolean } {
  if (room.status !== 'running') return { room, changed: false }
  const r = structuredClone(room)
  const changed = settleInPlace(r, presence, now, rng)
  return changed ? { room: r, changed } : { room, changed }
}

// ---- match commands ----------------------------------------------------------------------------

function loadMatch(r: Room, matchId: string, userId: string): Match {
  const m = r.matches.find((x) => x.id === matchId)
  if (!m) throw new RoomError('not_found')
  if (m.a !== userId && m.b !== userId) throw new RoomError('not_participant')
  return m
}

function wasPlaying(room: Room, matchId: string): boolean {
  return room.matches.find((x) => x.id === matchId)?.status === 'playing'
}

export function markReady(
  room: Room,
  matchId: string,
  userId: string,
  now: number,
  rng: Rng,
  presence?: Record<string, number>,
): Room {
  const r = structuredClone(room)
  settleInPlace(r, presence ?? null, now, rng)
  const m = loadMatch(r, matchId, userId)
  if (m.status !== 'pending') return r
  const side = m.X === userId ? 'X' : 'O'
  if (m.readyAt[side] !== null) return r
  m.readyAt[side] = now
  settleInPlace(r, presence ?? null, now, rng)
  return r
}

export function playMove(
  room: Room,
  matchId: string,
  userId: string,
  cell: Cell,
  clientMoveNo: number,
  now: number,
  rng: Rng,
  presence?: Record<string, number>,
): Room {
  const r = structuredClone(room)
  settleInPlace(r, presence ?? null, now, rng)
  const m = loadMatch(r, matchId, userId)
  const side = m.X === userId ? 'X' : m.O === userId ? 'O' : null

  // Retry of a move that is already recorded (double tap / network retry) → no-op.
  const prev = clientMoveNo >= 0 ? m.moves[clientMoveNo] : undefined
  if (prev && side && prev.side === side && prev.x === cell.x && prev.y === cell.y) return r

  if (m.status !== 'playing') {
    // The deadline passed before anyone settled: report the settled result instead of failing.
    if (m.status === 'finished' && wasPlaying(room, matchId)) return r
    throw new RoomError('not_playing')
  }
  if (!side || sideToMove(m.moves) !== side) throw new RoomError('not_your_turn')
  if (!isInside(cell.x, cell.y)) throw new RoomError('out_of_bounds')
  if (m.moves.some((mv) => mv.x === cell.x && mv.y === cell.y)) throw new RoomError('occupied')

  applyMove(r, m, cell, side, now, rng)
  settleInPlace(r, presence ?? null, now, rng)
  return r
}

export function resign(
  room: Room,
  matchId: string,
  userId: string,
  now: number,
  rng: Rng,
  presence?: Record<string, number>,
): Room {
  const r = structuredClone(room)
  settleInPlace(r, presence ?? null, now, rng)
  const m = loadMatch(r, matchId, userId)
  if (m.status !== 'playing') {
    if (m.status === 'finished' && wasPlaying(room, matchId)) return r
    throw new RoomError('not_playing')
  }
  const side = m.X === userId ? 'X' : 'O'
  finishMatch(r, m, opposite(side), 'resign', now, rng)
  settleInPlace(r, presence ?? null, now, rng)
  return r
}

// ---- queries -----------------------------------------------------------------------------------

export function isActive(room: Room, userId: string): boolean {
  if (!room.players.some((p) => p.userId === userId)) return false
  if (room.status === 'lobby') return true
  if (room.status !== 'running') return false
  const mine = room.matches.filter((m) => m.a === userId || m.b === userId)
  if (mine.some((m) => m.status !== 'finished')) return true
  const lost = mine.some((m) => m.winner && m[m.winner] !== userId)
  return !lost
}
