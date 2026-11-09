import { describe, expect, it } from 'vitest'
import {
  cancelBattle,
  createBattleRoom,
  fire,
  isActiveBattle,
  joinBattle,
  leaveBattle,
  markBattleReady,
  resignBattle,
  saveFleet,
  seatOf,
  settleBattle,
  startBattle,
} from '@/src/battleship/room'
import type { BattleMatch, BattleRoom, Seat } from '@/src/battleship/types'
import { RoomError } from '@/src/tournament/types'
import { mulberry, user } from '../tournament/helpers'
import { FLEET_A, SHIP_CELLS, WATER } from './helpers'

const T0 = 1_800_000_000_000

function err(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof RoomError) return e.code
    throw e
  }
  throw new Error('expected RoomError')
}

/** A started cup with n players (u1 hosts). */
function cup(n: number, seed = 1, now = T0): BattleRoom {
  let r = createBattleRoom({ code: 'ABCD', host: user(1), now })
  for (let i = 2; i <= n; i++) r = joinBattle(r, user(i), now)
  return startBattle(r, 'u1', now, mulberry(seed))
}

const match = (r: BattleRoom, id: string) => r.matches.find((m) => m.id === id)!
const playable = (r: BattleRoom) => r.matches.filter((m) => m.status === 'pending')
const idOf = (m: BattleMatch, s: Seat) => m[s]!

/** Both players open the match at t, then both lock FLEET_A at t. */
function toBattle(r: BattleRoom, id: string, t: number, rng = mulberry(5)): BattleRoom {
  const m = match(r, id)
  r = markBattleReady(r, id, idOf(m, 'a'), t, rng, null)
  r = markBattleReady(r, id, idOf(m, 'b'), t, rng, null)
  r = saveFleet(r, id, idOf(m, 'a'), FLEET_A, true, t, rng, null)
  r = saveFleet(r, id, idOf(m, 'b'), FLEET_A, true, t, rng, null)
  return r
}

/** Plays the match to the end: `winner` hits ships, the loser fires at water. Returns the room and the time reached. */
function playOut(r: BattleRoom, id: string, winner: Seat, t: number): { r: BattleRoom; t: number } {
  const rng = mulberry(7)
  const used: Record<Seat, number> = { a: 0, b: 0 }
  for (let i = 0; i < 200 && match(r, id).status === 'playing'; i++) {
    const m = match(r, id)
    const seat = m.turn!
    const cell = seat === winner ? SHIP_CELLS[used[seat]++] : WATER[used[seat]++]
    t += 1000
    r = fire(r, id, idOf(m, seat), cell, m.shots[seat].length + 1, t, rng, null)
  }
  return { r, t }
}

describe('lobby', () => {
  it('names the cup, joins idempotently and caps at 32', () => {
    let r = createBattleRoom({ code: 'ABCD', host: user(1), now: T0 })
    expect(r.name).toBe("User's Battle")
    r = joinBattle(r, user(2), T0)
    expect(joinBattle(r, user(2), T0).players).toHaveLength(2)
    for (let i = 3; i <= 32; i++) r = joinBattle(r, user(i), T0)
    expect(err(() => joinBattle(r, user(33), T0))).toBe('full')
  })
  it('host must cancel; others may leave; only the host cancels', () => {
    const r = joinBattle(createBattleRoom({ code: 'ABCD', host: user(1), now: T0 }), user(2), T0)
    expect(err(() => leaveBattle(r, 'u1'))).toBe('host_must_cancel')
    expect(leaveBattle(r, 'u2').players).toHaveLength(1)
    expect(err(() => cancelBattle(r, 'u2', T0))).toBe('not_host')
    expect(cancelBattle(r, 'u1', T0).status).toBe('cancelled')
  })
  it('needs 2 players and the host to start', () => {
    const solo = createBattleRoom({ code: 'ABCD', host: user(1), now: T0 })
    expect(err(() => startBattle(solo, 'u1', T0, mulberry(1)))).toBe('too_few_players')
    const two = joinBattle(solo, user(2), T0)
    expect(err(() => startBattle(two, 'u2', T0, mulberry(1)))).toBe('not_host')
  })
})

describe('bracket', () => {
  it('2 players: one match, no bye, no third place', () => {
    const r = cup(2)
    expect(r.status).toBe('running')
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0].status).toBe('pending')
  })
  it('3 players: one bye match finished, its winner already in the final, no third place', () => {
    const r = cup(3)
    const bye = r.matches.filter((m) => m.endReason === 'bye')
    expect(bye).toHaveLength(1)
    expect(bye[0].status).toBe('finished')
    const winnerId = bye[0][bye[0].winner!]
    const final = r.matches.find((m) => m.round === 1 && m.kind === 'normal')!
    expect([final.a, final.b]).toContain(winnerId)
    expect(r.matches.some((m) => m.kind === 'third_place')).toBe(false)
  })
  it('5 players: three byes and a third-place match', () => {
    const r = cup(5)
    expect(r.matches.filter((m) => m.endReason === 'bye')).toHaveLength(3)
    expect(r.matches.some((m) => m.kind === 'third_place')).toBe(true)
  })
  it('4 players: semifinals feed the final and the 3rd-place match; the cup then finishes', () => {
    let r = cup(4)
    let t = T0
    for (const m of playable(r)) {
      r = toBattle(r, m.id, t)
      ;({ r, t } = playOut(r, m.id, 'a', t))
    }
    const final = r.matches.find((m) => m.kind === 'normal' && m.round === 1)!
    const third = r.matches.find((m) => m.kind === 'third_place')!
    expect(final.status).toBe('pending')
    expect(third.status).toBe('pending')
    for (const id of [final.id, third.id]) {
      r = toBattle(r, id, t)
      ;({ r, t } = playOut(r, id, 'b', t))
    }
    expect(r.status).toBe('finished')
    const f = match(r, final.id)
    expect(r.placements.first).toBe(f.b)
    expect(r.placements.second).toBe(f.a)
    expect(r.placements.third).toBe(match(r, third.id).b)
  })
})

describe('ready and placement', () => {
  it('second ready opens placement with a 45 s deadline', () => {
    let r = cup(2)
    const m = r.matches[0]
    r = markBattleReady(r, m.id, m.a!, T0 + 1000, mulberry(1), null)
    expect(match(r, m.id).status).toBe('pending')
    r = markBattleReady(r, m.id, m.b!, T0 + 2000, mulberry(1), null)
    expect(match(r, m.id).status).toBe('placing')
    expect(match(r, m.id).placingDeadlineAt).toBe(T0 + 2000 + 45_000)
  })
  it('no-show: the ready player wins; with nobody ready the lower seed wins', () => {
    let r = cup(2)
    const m = r.matches[0]
    const one = markBattleReady(r, m.id, m.a!, T0, mulberry(1), null)
    const settled = settleBattle(one, null, T0 + 60_001, mulberry(1)).room
    expect(match(settled, m.id).winner).toBe('a')
    expect(match(settled, m.id).endReason).toBe('no_show')

    r = settleBattle(r, null, T0 + 60_001, mulberry(1)).room
    const seed = (id: string) => r.players.find((p) => p.userId === id)!.seed!
    const w = match(r, m.id)
    expect(seed(w[w.winner!]!)).toBeLessThan(seed(w[w.winner === 'a' ? 'b' : 'a']!))
  })
  it('both lock: battle starts at the later lock with a 20 s turn', () => {
    let r = cup(2)
    const m = r.matches[0]
    r = markBattleReady(r, m.id, m.a!, T0, mulberry(1), null)
    r = markBattleReady(r, m.id, m.b!, T0, mulberry(1), null)
    r = saveFleet(r, m.id, m.a!, FLEET_A, true, T0 + 3000, mulberry(1), null)
    expect(match(r, m.id).status).toBe('placing')
    r = saveFleet(r, m.id, m.b!, FLEET_A, true, T0 + 9000, mulberry(1), null)
    const p = match(r, m.id)
    expect(p.status).toBe('playing')
    expect(p.startedAt).toBe(T0 + 9000)
    expect(p.turnDeadlineAt).toBe(T0 + 9000 + 20_000)
  })
  it('deadline auto-places only the missing ships', () => {
    let r = cup(2)
    const m = r.matches[0]
    r = markBattleReady(r, m.id, m.a!, T0, mulberry(1), null)
    r = markBattleReady(r, m.id, m.b!, T0, mulberry(1), null)
    r = saveFleet(r, m.id, m.a!, [{ key: 'galleon', cells: [44, 45, 46, 47] }], false, T0 + 1000, mulberry(1), null)
    r = settleBattle(r, null, T0 + 45_001, mulberry(1)).room
    const p = match(r, m.id)
    expect(p.status).toBe('playing')
    expect(p.fleets.a).toHaveLength(5)
    expect(p.fleets.a.find((s) => s.key === 'galleon')!.cells).toEqual([44, 45, 46, 47])
    expect(p.fleets.b).toHaveLength(5)
    expect(p.startedAt).toBe(T0 + 45_000)
  })
  it('saveFleet errors: bad_fleet, locked, not_placing', () => {
    let r = cup(2)
    const m = r.matches[0]
    expect(err(() => saveFleet(r, m.id, m.a!, FLEET_A, false, T0, mulberry(1), null))).toBe('not_placing')
    r = markBattleReady(r, m.id, m.a!, T0, mulberry(1), null)
    r = markBattleReady(r, m.id, m.b!, T0, mulberry(1), null)
    expect(err(() => saveFleet(r, m.id, m.a!, FLEET_A.slice(0, 2), true, T0, mulberry(1), null))).toBe('bad_fleet')
    r = saveFleet(r, m.id, m.a!, FLEET_A, true, T0, mulberry(1), null)
    expect(err(() => saveFleet(r, m.id, m.a!, FLEET_A, false, T0, mulberry(1), null))).toBe('locked')
  })
  it('resign during placing', () => {
    let r = cup(2)
    const m = r.matches[0]
    r = markBattleReady(r, m.id, m.a!, T0, mulberry(1), null)
    r = markBattleReady(r, m.id, m.b!, T0, mulberry(1), null)
    r = resignBattle(r, m.id, m.a!, T0 + 500, mulberry(1), null)
    expect(match(r, m.id).winner).toBe('b')
    expect(match(r, m.id).endReason).toBe('resign')
  })
})

describe('battle', () => {
  function started() {
    const r0 = cup(2)
    const id = r0.matches[0].id
    const r = toBattle(r0, id, T0)
    const m = match(r, id)
    return { r, id, shooter: m.turn!, other: (m.turn === 'a' ? 'b' : 'a') as Seat }
  }

  it('a miss passes the turn with the 3 s grace', () => {
    const { r, id, shooter, other } = started()
    const m = match(r, id)
    const next = fire(r, id, idOf(m, shooter), WATER[0], 1, T0 + 2000, mulberry(1), null)
    const n = match(next, id)
    expect(n.shots[shooter][0]).toMatchObject({ cell: WATER[0], result: 'miss', seq: 1, auto: false })
    expect(n.turn).toBe(other)
    expect(n.turnDeadlineAt).toBe(T0 + 2000 + 23_000)
  })
  it('a hit keeps the turn, with a fresh clock and the 3 s grace', () => {
    const { r, id, shooter } = started()
    const m = match(r, id)
    const next = fire(r, id, idOf(m, shooter), SHIP_CELLS[0], 1, T0 + 2000, mulberry(1), null)
    const n = match(next, id)
    expect(n.shots[shooter][0].result).toBe('hit')
    expect(n.turn).toBe(shooter)
    expect(n.turnDeadlineAt).toBe(T0 + 2000 + 23_000)
    // and again after the next hit, until a miss passes the turn
    const again = fire(next, id, idOf(m, shooter), SHIP_CELLS[1], 2, T0 + 3000, mulberry(1), null)
    expect(match(again, id).turn).toBe(shooter)
    const miss = fire(again, id, idOf(m, shooter), WATER[0], 3, T0 + 4000, mulberry(1), null)
    expect(match(miss, id).turn).not.toBe(shooter)
  })
  it('hit, then sunk; sinking every ship in one streak wins with fleet_sunk and finishes a 2-player cup', () => {
    const { r, id, shooter } = started()
    const { r: done } = playOut(r, id, shooter, T0)
    const m = match(done, id)
    expect(m.shots[shooter].map((s) => s.result)).toEqual([
      'hit', 'hit', 'hit', 'hit', 'sunk',
      'hit', 'hit', 'hit', 'sunk',
      'hit', 'hit', 'sunk',
      'hit', 'hit', 'sunk',
      'hit', 'sunk',
    ])
    const other: Seat = shooter === 'a' ? 'b' : 'a'
    expect(m.shots[other]).toHaveLength(0) // never got a turn
    expect(m.winner).toBe(shooter)
    expect(m.endReason).toBe('fleet_sunk')
    expect(done.status).toBe('finished')
    expect(done.placements.first).toBe(m[shooter])
  })
  it('fire is idempotent per seq', () => {
    const { r, id, shooter } = started()
    const uid = idOf(match(r, id), shooter)
    const once = fire(r, id, uid, WATER[0], 1, T0 + 1000, mulberry(1), null)
    const twice = fire(once, id, uid, WATER[1], 1, T0 + 1100, mulberry(1), null)
    expect(match(twice, id).shots[shooter]).toHaveLength(1)
    expect(twice).toEqual(once)
  })
  it('fire errors: not_your_turn, out_of_bounds, occupied, not_participant', () => {
    const { r, id, shooter, other } = started()
    const m = match(r, id)
    expect(err(() => fire(r, id, idOf(m, other), 0, 1, T0 + 1, mulberry(1), null))).toBe('not_your_turn')
    for (const cell of [100, -1, 2.5]) {
      expect(err(() => fire(r, id, idOf(m, shooter), cell, 1, T0 + 1, mulberry(1), null))).toBe('out_of_bounds')
    }
    expect(err(() => fire(r, id, 'u9', 0, 1, T0 + 1, mulberry(1), null))).toBe('not_participant')
    let r2 = fire(r, id, idOf(m, shooter), WATER[0], 1, T0 + 1, mulberry(1), null)
    r2 = fire(r2, id, idOf(m, other), WATER[0], 1, T0 + 2, mulberry(1), null)
    expect(err(() => fire(r2, id, idOf(m, shooter), WATER[0], 2, T0 + 3, mulberry(1), null))).toBe('occupied')
  })
  it('turn timeout auto-fires and counts a missed turn (a lucky hit keeps the turn)', () => {
    const { r, id, shooter, other } = started()
    const s = settleBattle(r, null, T0 + 20_001, mulberry(3)).room
    const m = match(s, id)
    expect(m.shots[shooter]).toHaveLength(1)
    expect(m.shots[shooter][0]).toMatchObject({ auto: true, seq: 1, at: T0 + 20_000 })
    expect(m.missedTurns[shooter]).toBe(1)
    expect(m.turn).toBe(m.shots[shooter][0].result === 'miss' ? other : shooter)
  })
  it('three missed turns in a row lose with afk; a manual shot resets the count', () => {
    const { r, id, shooter, other } = started()
    let t = T0
    let room = r
    const handFire = (seat: Seat) => {
      const m = match(room, id)
      const used = new Set(m.shots[seat].map((x) => x.cell))
      const cell = WATER.find((c) => !used.has(c))!
      room = fire(room, id, idOf(m, seat), cell, m.shots[seat].length + 1, t + 1, mulberry(1), null)
    }
    /** Lets the shooter's clock run out once (the other side misses by hand first if it's their turn). */
    const timeout = () => {
      if (match(room, id).turn === other) handFire(other)
      t = match(room, id).turnDeadlineAt!
      room = settleBattle(room, null, t + 1, mulberry(3)).room
    }
    timeout()
    timeout()
    expect(match(room, id).missedTurns[shooter]).toBe(2)
    if (match(room, id).turn === other) handFire(other)
    handFire(shooter) // a real shot resets the streak
    expect(match(room, id).missedTurns[shooter]).toBe(0)
    for (let k = 0; k < 3 && match(room, id).status === 'playing'; k++) timeout()
    const m = match(room, id)
    expect(m.winner).toBe(other)
    expect(m.endReason).toBe('afk')
  })
  it('late fire after auto-shot is refused, not doubled', () => {
    const { r, id, shooter } = started()
    const m = match(r, id)
    const late = fire(r, id, idOf(m, shooter), WATER[5], 1, T0 + 20_001, mulberry(3), null)
    const n = match(late, id)
    expect(n.shots[shooter]).toHaveLength(1)
    expect(n.shots[shooter][0].auto).toBe(true)
  })
  it('disconnect during battle loses the match', () => {
    const { r, id } = started()
    const m = match(r, id)
    const start = m.startedAt!
    const presence = { [m.a!]: start, [m.b!]: start + 35_000 }
    const s = settleBattle(r, presence, start + 35_001, mulberry(3)).room
    expect(match(s, id).winner).toBe('b')
    expect(match(s, id).endReason).toBe('disconnect_timeout')
  })
})

describe('seatOf and isActiveBattle', () => {
  it('tracks who is still in the cup', () => {
    const lobby = joinBattle(createBattleRoom({ code: 'ABCD', host: user(1), now: T0 }), user(2), T0)
    expect(isActiveBattle(lobby, 'u2')).toBe(true)
    expect(isActiveBattle(lobby, 'u9')).toBe(false)

    let r = cup(8)
    const qf = playable(r)[0]
    expect(seatOf(qf, qf.a!)).toBe('a')
    expect(seatOf(qf, 'u9')).toBeNull()
    expect(isActiveBattle(r, qf.a!)).toBe(true)
    r = toBattle(r, qf.id, T0)
    ;({ r } = playOut(r, qf.id, 'a', T0))
    expect(isActiveBattle(r, qf.b!)).toBe(false) // knocked out in the quarterfinal
    expect(isActiveBattle(r, qf.a!)).toBe(true) // semifinal still waiting for its other entrant
  })
})
