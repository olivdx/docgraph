/**
 * Match-level transitions for Battleship. Every function here mutates the (already cloned) room it
 * is given; the public, non-mutating API lives in room.ts.
 *
 * Time model (as in Caro): an event driven by a deadline happens AT that deadline, not at `now`.
 * `presence === null` means "unknown": disconnect deadlines are not evaluated.
 */
import {
  CELLS,
  DISCONNECT_DETECT_MS,
  MAX_MISSED_TURNS,
  NO_SHOW_MS,
  PLACE_MS,
  RECONNECT_GRACE_MS,
  SHOT_GRACE_MS,
  TURN_MS,
} from './constants'
import { fleetSunk, randomFleet, resolveShot } from './fleet'
import type { BattleEndReason, BattleMatch, BattleRoom, Seat } from './types'

export type Presence = Record<string, number> | null
type Rng = () => number

export const SEATS: Seat[] = ['a', 'b']
export const otherSeat = (s: Seat): Seat => (s === 'a' ? 'b' : 'a')

export function seatOf(m: Pick<BattleMatch, 'a' | 'b'>, userId: string): Seat | null {
  if (m.a === userId) return 'a'
  if (m.b === userId) return 'b'
  return null
}

function seedOf(room: BattleRoom, userId: string | null): number {
  return room.players.find((p) => p.userId === userId)?.seed ?? Number.MAX_SAFE_INTEGER
}

/** waiting → pending once both entrants are known. */
export function promote(m: BattleMatch, at: number): boolean {
  if (m.status !== 'waiting' || !m.a || !m.b) return false
  m.status = 'pending'
  m.pendingSince = at
  return true
}

function advance(room: BattleRoom, m: BattleMatch): void {
  const last = room.totalRounds - 1
  if (m.kind !== 'normal' || m.round >= last || !m.winner) return
  const winnerId = m[m.winner]
  const loserId = m[otherSeat(m.winner)]
  // The next match becomes pending when the LATER of its two feeders finished.
  const sibling = room.matches.find((x) => x.kind === 'normal' && x.round === m.round && x.slot === (m.slot ^ 1))
  const at = Math.max(m.finishedAt ?? 0, sibling?.finishedAt ?? 0)
  const next = room.matches.find((x) => x.kind === 'normal' && x.round === m.round + 1 && x.slot === Math.floor(m.slot / 2))
  if (next) {
    if (m.slot % 2 === 0) next.a = winnerId
    else next.b = winnerId
    promote(next, at)
  }
  if (m.round === last - 1 && loserId) {
    const third = room.matches.find((x) => x.kind === 'third_place')
    if (third) {
      if (m.slot === 0) third.a = loserId
      else third.b = loserId
      promote(third, at)
    }
  }
}

/** Finish a match (once) and advance its entrants. */
export function finishMatch(room: BattleRoom, m: BattleMatch, winner: Seat, reason: BattleEndReason, at: number): void {
  if (m.status === 'finished') return
  m.status = 'finished'
  m.winner = winner
  m.endReason = reason
  m.finishedAt = at
  m.turn = null
  m.turnDeadlineAt = null
  m.placingDeadlineAt = null
  advance(room, m)
}

function startPlacing(m: BattleMatch, at: number): void {
  m.status = 'placing'
  m.placingStartedAt = at
  m.placingDeadlineAt = at + PLACE_MS
}

function beginBattle(m: BattleMatch, at: number, rng: Rng): void {
  m.status = 'playing'
  m.placingDeadlineAt = null
  m.startedAt = at
  m.turn = rng() < 0.5 ? 'a' : 'b'
  m.turnDeadlineAt = at + TURN_MS
}

/** Records `seat`'s shot at `cell`, then ends the match or passes the turn (with the animation grace). */
export function applyShot(room: BattleRoom, m: BattleMatch, seat: Seat, cell: number, at: number, auto: boolean): void {
  const target = otherSeat(seat)
  const { result, shipKey } = resolveShot(m.fleets[target], m.shots[seat], cell)
  m.shots[seat].push({ seq: m.shots[seat].length + 1, cell, result, shipKey, at, auto })
  if (fleetSunk(m.fleets[target], m.shots[seat])) {
    finishMatch(room, m, seat, 'fleet_sunk', at)
    return
  }
  m.turn = target
  m.turnDeadlineAt = at + SHOT_GRACE_MS + TURN_MS
}

function disconnectDeadline(m: BattleMatch, presence: Record<string, number>, userId: string): number {
  const base = m.placingStartedAt ?? 0
  return Math.max(presence[userId] ?? base, base) + DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS
}

type Due =
  | { at: number; kind: 'locked' }
  | { at: number; kind: 'place_deadline' }
  | { at: number; kind: 'turn' }
  | { at: number; kind: 'disconnect'; seat: Seat }

/** Applies at most one transition / event to the match. Returns true if something changed. */
export function stepMatch(room: BattleRoom, m: BattleMatch, presence: Presence, now: number, rng: Rng): boolean {
  switch (m.status) {
    case 'waiting':
      return promote(m, now)

    case 'pending': {
      const { a, b } = m.readyAt
      if (a !== null && b !== null) {
        startPlacing(m, Math.max(a, b))
        return true
      }
      const since = m.pendingSince ?? now
      if (now - since > NO_SHOW_MS) {
        let winner: Seat
        if (a !== null) winner = 'a'
        else if (b !== null) winner = 'b'
        else winner = seedOf(room, m.a) < seedOf(room, m.b) ? 'a' : 'b'
        finishMatch(room, m, winner, 'no_show', since + NO_SHOW_MS)
        return true
      }
      return false
    }

    case 'placing':
    case 'playing': {
      const due: Due[] = []
      if (m.status === 'placing') {
        const { a, b } = m.lockedAt
        if (a !== null && b !== null) due.push({ at: Math.max(a, b), kind: 'locked' })
        if (m.placingDeadlineAt !== null && m.placingDeadlineAt <= now) {
          due.push({ at: m.placingDeadlineAt, kind: 'place_deadline' })
        }
      } else if (m.turnDeadlineAt !== null && m.turnDeadlineAt <= now) {
        due.push({ at: m.turnDeadlineAt, kind: 'turn' })
      }
      if (presence) {
        for (const seat of SEATS) {
          const id = m[seat]
          if (!id) continue
          const at = disconnectDeadline(m, presence, id)
          if (at < now) due.push({ at, kind: 'disconnect', seat })
        }
      }
      if (due.length === 0) return false
      const ev = due.reduce((best, d) => (d.at < best.at ? d : best))
      if (ev.kind === 'locked') {
        beginBattle(m, ev.at, rng)
      } else if (ev.kind === 'place_deadline') {
        for (const seat of SEATS) {
          if (m.lockedAt[seat] !== null) continue
          m.fleets[seat] = randomFleet(rng, m.fleets[seat])
          m.lockedAt[seat] = ev.at
        }
        beginBattle(m, ev.at, rng)
      } else if (ev.kind === 'turn') {
        const seat = m.turn!
        m.missedTurns[seat]++
        if (m.missedTurns[seat] >= MAX_MISSED_TURNS) {
          finishMatch(room, m, otherSeat(seat), 'afk', ev.at)
        } else {
          const fired = new Set(m.shots[seat].map((s) => s.cell))
          const open = Array.from({ length: CELLS }, (_, i) => i).filter((c) => !fired.has(c))
          applyShot(room, m, seat, open[Math.floor(rng() * open.length)], ev.at, true)
        }
      } else {
        finishMatch(room, m, otherSeat(ev.seat), 'disconnect_timeout', ev.at)
      }
      return true
    }

    default:
      return false
  }
}
