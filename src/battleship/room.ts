/**
 * Battleship cup aggregate. Every exported function is pure: it never mutates its input and returns a
 * new room (or throws RoomError). Time and randomness are injected. Match commands settle the room
 * first (with the given presence; null = disconnects not evaluated) and again after acting.
 */
import { planByeBracket } from '@/src/tournament/bracket'
import { randomCode } from '@/src/tournament/codes'
import { RoomError } from '@/src/tournament/types'
import { CELLS, FINISHED_TTL_MS, LOBBY_TTL_MS, MATCH_ID_LEN, MAX_PLAYERS, MIN_PLAYERS } from './constants'
import { validateFleet } from './fleet'
import { applyShot, finishMatch, otherSeat, promote, seatOf, stepMatch, type Presence } from './match'
import type { BattleMatch, BattlePlayer, BattleRoom, Ship } from './types'

export { seatOf } from './match'

type Rng = () => number
export type UserInfo = { userId: string; name: string; avatarUrl: string | null }

const clone = (r: BattleRoom): BattleRoom => structuredClone(r)

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Player'
}

function player(u: UserInfo, now: number): BattlePlayer {
  return { userId: u.userId, name: u.name, avatarUrl: u.avatarUrl, seed: null, joinedAt: now }
}

// ---- lobby -------------------------------------------------------------------------------------

export function createBattleRoom(p: { code: string; host: UserInfo; name?: string; now: number }): BattleRoom {
  return {
    _id: p.code,
    name: p.name?.trim() || `${firstWord(p.host.name)}'s Battle`,
    hostId: p.host.userId,
    status: 'lobby',
    players: [player(p.host, p.now)],
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

export function joinBattle(room: BattleRoom, user: UserInfo, now: number): BattleRoom {
  if (room.players.some((p) => p.userId === user.userId)) return room
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
  if (room.players.length >= MAX_PLAYERS) throw new RoomError('full')
  const r = clone(room)
  r.players.push(player(user, now))
  return r
}

/**
 * Leaves the cup. In the lobby the player is removed; a leaving host hands the cup to a random
 * remaining player (alone: the cup is cancelled). In a running cup the player loses their live match
 * at once (`left`) and any later match as soon as it is set up. A knocked-out player, or a finished
 * cup, is left unchanged.
 */
export function leaveBattle(room: BattleRoom, userId: string, now: number, rng: Rng): BattleRoom {
  if (!room.players.some((p) => p.userId === userId)) return room
  if (room.status === 'lobby') {
    const r = clone(room)
    r.players = r.players.filter((p) => p.userId !== userId)
    if (userId === r.hostId) {
      if (r.players.length === 0) {
        r.status = 'cancelled'
        r.finishedAt = now
        r.expiresAt = new Date(now + FINISHED_TTL_MS)
      } else {
        r.hostId = r.players[Math.floor(rng() * r.players.length)].userId
      }
    }
    return r
  }
  if (room.status !== 'running') return room
  const r = clone(room)
  settleInPlace(r, null, now, rng)
  if (!isActiveBattle(r, userId)) return room // already knocked out: nothing to leave
  r.players.find((p) => p.userId === userId)!.leftAt = now
  for (const m of r.matches) {
    const seat = seatOf(m, userId)
    if (seat && (m.status === 'placing' || m.status === 'playing')) finishMatch(r, m, otherSeat(seat), 'left', now)
  }
  settleInPlace(r, null, now, rng) // pending matches (now or later) resolve through stepMatch
  return r
}

export function cancelBattle(room: BattleRoom, userId: string, now: number): BattleRoom {
  if (userId !== room.hostId) throw new RoomError('not_host')
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
  const r = clone(room)
  r.status = 'cancelled'
  r.finishedAt = now
  r.expiresAt = new Date(now + FINISHED_TTL_MS)
  return r
}

function emptyMatch(id: string, round: number, slot: number, kind: BattleMatch['kind']): BattleMatch {
  return {
    id,
    round,
    slot,
    kind,
    a: null,
    b: null,
    status: 'waiting',
    pendingSince: null,
    readyAt: { a: null, b: null },
    placingStartedAt: null,
    placingDeadlineAt: null,
    fleets: { a: [], b: [] },
    lockedAt: { a: null, b: null },
    startedAt: null,
    turn: null,
    turnDeadlineAt: null,
    missedTurns: { a: 0, b: 0 },
    shots: { a: [], b: [] },
    winner: null,
    endReason: null,
    finishedAt: null,
  }
}

export function startBattle(room: BattleRoom, userId: string, now: number, rng: Rng): BattleRoom {
  if (userId !== room.hostId) throw new RoomError('not_host')
  if (room.status !== 'lobby') throw new RoomError('not_lobby')
  if (room.players.length < MIN_PLAYERS) throw new RoomError('too_few_players')

  const r = clone(room)
  const { size, totalRounds, order } = planByeBracket(r.players, rng)
  const seeded: (BattlePlayer | null)[] = order.map((p, i) => (p ? { ...p, seed: i + 1 } : null))
  r.players = seeded.filter((p): p is BattlePlayer => p !== null)
  r.totalRounds = totalRounds
  r.status = 'running'
  r.startedAt = now
  // A running room must not be swept by the lobby TTL mid-cup (the service refreshes it on writes).
  r.expiresAt = new Date(now + LOBBY_TTL_MS)

  const used = new Set<string>()
  const newId = () => {
    let id: string
    do id = randomCode(MATCH_ID_LEN, rng)
    while (used.has(id))
    used.add(id)
    return id
  }
  const matches: BattleMatch[] = []
  for (let round = 0; round < totalRounds; round++) {
    const count = size >> (round + 1)
    for (let slot = 0; slot < count; slot++) matches.push(emptyMatch(newId(), round, slot, 'normal'))
  }
  // Byes only sit in round 1, so a semifinal can hold one only when round 1 is the semifinal.
  const byeInSemis = totalRounds === 2 && seeded.some((p) => p === null)
  if (size >= 4 && !byeInSemis) matches.push(emptyMatch(newId(), totalRounds - 1, 1, 'third_place'))
  r.matches = matches

  for (const m of matches.filter((x) => x.round === 0)) {
    m.a = seeded[2 * m.slot]!.userId
    m.b = seeded[2 * m.slot + 1]?.userId ?? null
    if (m.b === null) finishMatch(r, m, 'a', 'bye', now)
    else promote(m, now)
  }
  settleInPlace(r, null, now, rng)
  return r
}

// ---- settle ------------------------------------------------------------------------------------

function finishRoomIfDone(r: BattleRoom, now: number): boolean {
  const final = r.matches.find((m) => m.kind === 'normal' && m.round === r.totalRounds - 1)
  const third = r.matches.find((m) => m.kind === 'third_place')
  if (!final || final.status !== 'finished' || !final.winner) return false
  if (third && third.status !== 'finished') return false
  r.placements = {
    first: final[final.winner],
    second: final[otherSeat(final.winner)],
    third: third?.winner ? third[third.winner] : null,
  }
  r.status = 'finished'
  r.finishedAt = now
  r.expiresAt = new Date(now + FINISHED_TTL_MS)
  return true
}

/** Mutates `r` (a private clone) until no deadline ≤ now remains. Returns whether anything changed. */
function settleInPlace(r: BattleRoom, presence: Presence, now: number, rng: Rng): boolean {
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

export function settleBattle(
  room: BattleRoom,
  presence: Presence,
  now: number,
  rng: Rng,
): { room: BattleRoom; changed: boolean } {
  if (room.status !== 'running') return { room, changed: false }
  const r = clone(room)
  return settleInPlace(r, presence, now, rng) ? { room: r, changed: true } : { room, changed: false }
}

// ---- match commands ----------------------------------------------------------------------------

function loadMatch(r: BattleRoom, matchId: string, userId: string): { m: BattleMatch; seat: 'a' | 'b' } {
  const m = r.matches.find((x) => x.id === matchId)
  if (!m) throw new RoomError('not_found')
  const seat = seatOf(m, userId)
  if (!seat) throw new RoomError('not_participant')
  return { m, seat }
}

const wasLive = (room: BattleRoom, matchId: string) => {
  const s = room.matches.find((x) => x.id === matchId)?.status
  return s === 'placing' || s === 'playing'
}

export function markBattleReady(
  room: BattleRoom,
  matchId: string,
  userId: string,
  now: number,
  rng: Rng,
  presence: Presence,
): BattleRoom {
  const r = clone(room)
  settleInPlace(r, presence, now, rng)
  const { m, seat } = loadMatch(r, matchId, userId)
  if (m.status !== 'pending' || m.readyAt[seat] !== null) return r
  m.readyAt[seat] = now
  settleInPlace(r, presence, now, rng)
  return r
}

/** Saves (and with `lock`, confirms) the caller's fleet during placement. */
export function saveFleet(
  room: BattleRoom,
  matchId: string,
  userId: string,
  ships: Ship[],
  lock: boolean,
  now: number,
  rng: Rng,
  presence: Presence,
): BattleRoom {
  const r = clone(room)
  settleInPlace(r, presence, now, rng)
  const { m, seat } = loadMatch(r, matchId, userId)
  if (m.lockedAt[seat] !== null) throw new RoomError('locked')
  if (m.status !== 'placing') throw new RoomError('not_placing')
  validateFleet(ships, lock)
  m.fleets[seat] = ships.map((s) => ({ key: s.key, cells: [...s.cells] }))
  if (lock) m.lockedAt[seat] = now
  settleInPlace(r, presence, now, rng)
  return r
}

/**
 * The caller fires at `cell`. `seq` is the caller's 1-based shot number: a seq already used (a
 * retry, or a turn the server auto-fired) returns the settled room unchanged.
 */
export function fire(
  room: BattleRoom,
  matchId: string,
  userId: string,
  cell: number,
  seq: number,
  now: number,
  rng: Rng,
  presence: Presence,
): BattleRoom {
  const r = clone(room)
  settleInPlace(r, presence, now, rng)
  const { m, seat } = loadMatch(r, matchId, userId)
  if (seq <= m.shots[seat].length) return r
  if (m.status !== 'playing') throw new RoomError('not_playing')
  if (m.turn !== seat) throw new RoomError('not_your_turn')
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) throw new RoomError('out_of_bounds')
  if (m.shots[seat].some((s) => s.cell === cell)) throw new RoomError('occupied')
  m.missedTurns[seat] = 0
  applyShot(r, m, seat, cell, now, false)
  settleInPlace(r, presence, now, rng)
  return r
}

export function resignBattle(
  room: BattleRoom,
  matchId: string,
  userId: string,
  now: number,
  rng: Rng,
  presence: Presence,
): BattleRoom {
  const r = clone(room)
  settleInPlace(r, presence, now, rng)
  const { m, seat } = loadMatch(r, matchId, userId)
  if (m.status === 'placing' || m.status === 'playing') {
    finishMatch(r, m, otherSeat(seat), 'resign', now)
    settleInPlace(r, presence, now, rng)
    return r
  }
  if (m.status === 'finished' && wasLive(room, matchId)) return r // ended while the request was in flight
  throw new RoomError('not_playing')
}

// ---- queries -----------------------------------------------------------------------------------

/** In the lobby, or not yet knocked out of a running cup. */
export function isActiveBattle(room: Pick<BattleRoom, 'players' | 'status' | 'matches'>, userId: string): boolean {
  const me = room.players.find((p) => p.userId === userId)
  if (!me || me.leftAt != null) return false
  if (room.status === 'lobby') return true
  if (room.status !== 'running') return false
  const mine = room.matches.filter((m) => m.a === userId || m.b === userId)
  if (mine.some((m) => m.status !== 'finished')) return true
  return !mine.some((m) => m.winner && m[m.winner] !== userId)
}
