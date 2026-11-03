import { describe, it, expect } from 'vitest'
import {
  createRoom,
  isActive,
  joinRoom,
  markReady,
  playMove,
  resign,
  settleRoom,
  startRoom,
} from '@/src/tournament/room'
import { NO_SHOW_MS, TURN_MS } from '@/src/tournament/constants'
import { RoomError, type Match, type Room } from '@/src/tournament/types'
import type { Cell } from '@/src/game/types'
import { mulberry, user } from './helpers'

const T0 = 1_000_000
const START = T0 + 100
const rng = mulberry(42)

function startedRoom(humans: number, seed = 1): Room {
  let r = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
  for (let i = 1; i < humans; i++) r = joinRoom(r, user(i), T0 + i)
  return startRoom(r, 'u0', START, mulberry(seed))
}

const isBot = (r: Room, id: string | null) => r.players.find((p) => p.userId === id)?.isBot ?? false
const byId = (r: Room, id: string) => r.matches.find((m) => m.id === id)!
const final = (r: Room) => r.matches.find((m) => m.kind === 'normal' && m.round === r.totalRounds - 1)!
const third = (r: Room) => r.matches.find((m) => m.kind === 'third_place')!

/** Marks every human side of the match ready at `at`. */
function ready(r: Room, m: Match = r.matches[0], at = START): Room {
  for (const id of [m.X, m.O]) if (id && !isBot(r, id)) r = markReady(r, m.id, id, at, rng)
  return r
}

/** Plays cells alternately starting with whichever side is to move, one second apart. */
function play(r: Room, matchId: string, cells: Cell[], at: number): Room {
  for (const c of cells) {
    const m = byId(r, matchId)
    const side = m.moves.length % 2 === 0 ? 'X' : 'O'
    r = playMove(r, matchId, m[side]!, c, m.moves.length, at, rng)
    at += 1000
  }
  return r
}

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    if (e instanceof RoomError) return e.code
    throw e
  }
  return undefined
}

// X makes five on row 10 (x = 5..9); O plays harmlessly on column 0.
const FIVE: Cell[] = [
  { x: 5, y: 10 }, { x: 0, y: 0 },
  { x: 6, y: 10 }, { x: 0, y: 1 },
  { x: 7, y: 10 }, { x: 0, y: 2 },
  { x: 8, y: 10 }, { x: 0, y: 3 },
  { x: 9, y: 10 },
]

/** Readies the match and has its O resign, so X wins. */
function resolve(r: Room, m: Match, at: number): Room {
  r = ready(r, byId(r, m.id), at)
  const cur = byId(r, m.id)
  return resign(r, m.id, cur.O!, at, rng)
}

describe('match lifecycle (2-human room → one final)', () => {
  it('pending → playing when both ready; X to move with 25s deadline', () => {
    let r = startedRoom(2)
    const m0 = r.matches[0]
    expect(r.matches).toHaveLength(1)
    expect(m0.status).toBe('pending')
    r = markReady(r, m0.id, m0.X!, START + 1000, rng)
    expect(byId(r, m0.id).status).toBe('pending')
    expect(byId(r, m0.id).readyAt.X).toBe(START + 1000)
    r = markReady(r, m0.id, m0.O!, START + 2000, rng)
    const m = byId(r, m0.id)
    expect(m.status).toBe('playing')
    expect(m.startedAt).toBe(START + 2000)
    expect(m.turnDeadlineAt).toBe(START + 2000 + TURN_MS)
    expect(m.botMoveDueAt).toBeNull()
  })

  it('no-show: only X ready, now = pendingSince+60_001 → O loses no_show', () => {
    let r = startedRoom(2)
    const m0 = r.matches[0]
    r = markReady(r, m0.id, m0.X!, START + 1000, rng)
    const before = settleRoom(r, {}, START + NO_SHOW_MS, rng)
    expect(before.changed).toBe(false)
    const { room, changed } = settleRoom(r, {}, START + 60_001, rng)
    expect(changed).toBe(true)
    const m = byId(room, m0.id)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('no_show')
    expect(m.winner).toBe('X')
    expect(m.finishedAt).toBe(START + NO_SHOW_MS)
  })

  it('no-show with neither ready → lower seed wins', () => {
    const r = startedRoom(2)
    const m = byId(settleRoom(r, {}, START + 60_001, rng).room, r.matches[0].id)
    const seed = (id: string | null) => r.players.find((p) => p.userId === id)!.seed!
    expect(m.endReason).toBe('no_show')
    expect(m.winner).toBe(seed(m.X) < seed(m.O) ? 'X' : 'O')
  })

  it('turn timeout: X does nothing for 25_001ms → X loses turn_timeout', () => {
    const r = ready(startedRoom(2))
    const id = r.matches[0].id
    const p = { u0: START + 25_001, u1: START + 25_001 }
    expect(settleRoom(r, p, START + 20_000, rng).changed).toBe(false)
    const m = byId(settleRoom(r, p, START + 25_001, rng).room, id)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('turn_timeout')
    expect(m.winner).toBe('O')
    expect(m.finishedAt).toBe(START + TURN_MS)
  })

  it('late move loses by timeout', () => {
    const r = ready(startedRoom(2))
    const m0 = r.matches[0]
    const after = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START + TURN_MS + 1, rng)
    const m = byId(after, m0.id)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('turn_timeout')
    expect(m.winner).toBe('O')
    expect(m.moves).toHaveLength(0)
    // once the match is settled, any further move is rejected
    expect(code(() => playMove(after, m0.id, m0.X!, { x: 15, y: 15 }, 0, START + TURN_MS + 2, rng))).toBe('not_playing')
  })

  it('presence gap of 20s does not forfeit', () => {
    let r = ready(startedRoom(2))
    const m0 = r.matches[0]
    r = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START, rng) // now O to move
    const before = byId(r, m0.id)
    const { room, changed } = settleRoom(r, { [m0.X!]: START, [m0.O!]: START + 20_000 }, START + 20_000, rng)
    expect(changed).toBe(false)
    const m = byId(room, m0.id)
    expect(m.status).toBe('playing')
    expect(m.moves).toEqual(before.moves)
    expect(m.turnDeadlineAt).toBe(before.turnDeadlineAt)
  })

  it('presence gap of 35_001ms forfeits disconnect_timeout', () => {
    let r = ready(startedRoom(2))
    const m0 = r.matches[0]
    r = play(r, m0.id, [{ x: 15, y: 15 }], START) // X moved at START, O to move until START+25s
    r = playMove(r, m0.id, m0.O!, { x: 16, y: 16 }, 1, START + 20_000, rng) // X to move until START+45s
    const p = { [m0.X!]: START, [m0.O!]: START + 35_001 }
    expect(settleRoom(r, p, START + 35_000, rng).changed).toBe(false)
    const m = byId(settleRoom(r, p, START + 35_001, rng).room, m0.id)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('disconnect_timeout')
    expect(m.winner).toBe('O')
    expect(m.finishedAt).toBe(START + 35_000)
  })

  it('earliest deadline wins when two expired', () => {
    const r = ready(startedRoom(2)) // X to move, deadline START+25s
    const m0 = r.matches[0]
    // O vanished at START → O's disconnect deadline START+35s; X is online.
    const m = byId(settleRoom(r, { [m0.X!]: START + 40_000, [m0.O!]: START }, START + 40_000, rng).room, m0.id)
    expect(m.endReason).toBe('turn_timeout')
    expect(m.winner).toBe('O')
    expect(m.finishedAt).toBe(START + TURN_MS)
  })

  it('earliest deadline wins when two expired (disconnect before turn)', () => {
    let r = ready(startedRoom(2))
    const m0 = r.matches[0]
    r = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START, rng)
    r = playMove(r, m0.id, m0.O!, { x: 16, y: 16 }, 1, START + 20_000, rng) // X to move until START+45s
    // X last seen at START → X's disconnect deadline START+35s, earlier than the turn deadline.
    const p = { [m0.X!]: START, [m0.O!]: START + 50_000 }
    const m = byId(settleRoom(r, p, START + 50_000, rng).room, m0.id)
    expect(m.endReason).toBe('disconnect_timeout')
    expect(m.winner).toBe('O')
    expect(m.finishedAt).toBe(START + 35_000)
  })

  it('duplicate clientMoveNo is a no-op', () => {
    let r = ready(startedRoom(2))
    const m0 = r.matches[0]
    r = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START + 1000, rng)
    const again = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START + 1500, rng)
    const m = byId(again, m0.id)
    expect(m.moves).toHaveLength(1)
    expect(m.moves.length % 2 === 0 ? 'X' : 'O').toBe('O')
    expect(m.turnDeadlineAt).toBe(START + 1000 + TURN_MS)
  })

  it('wrong turn → not_your_turn; occupied → occupied; outside → out_of_bounds', () => {
    let r = ready(startedRoom(2))
    const m0 = r.matches[0]
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 1, y: 1 }, 0, START + 10, rng))).toBe('not_your_turn')
    r = playMove(r, m0.id, m0.X!, { x: 1, y: 1 }, 0, START + 10, rng)
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 1, y: 1 }, 1, START + 20, rng))).toBe('occupied')
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 50, y: 1 }, 1, START + 20, rng))).toBe('out_of_bounds')
    expect(code(() => playMove(r, m0.id, m0.O!, { x: -51, y: 1 }, 1, START + 20, rng))).toBe('out_of_bounds')
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 1, y: 50 }, 1, START + 20, rng))).toBe('out_of_bounds')
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 1, y: -51 }, 1, START + 20, rng))).toBe('out_of_bounds')
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 1.5, y: 1 }, 1, START + 20, rng))).toBe('out_of_bounds')
    expect(code(() => playMove(r, m0.id, 'stranger', { x: 2, y: 2 }, 1, START + 20, rng))).toBe('not_participant')
  })

  it('accepts negative coordinates and both board edges (-50 and 49)', () => {
    let r = ready(startedRoom(2))
    const id = r.matches[0].id
    r = play(r, id, [{ x: -50, y: -50 }, { x: 49, y: 49 }, { x: -1, y: -1 }, { x: 49, y: -50 }], START + 10)
    const m = byId(r, id)
    expect(m.moves.map((mv) => [mv.x, mv.y])).toEqual([[-50, -50], [49, 49], [-1, -1], [49, -50]])
    expect(m.status).toBe('playing')
  })

  it('both-blocked five does not finish', () => {
    let r = ready(startedRoom(2))
    const id = r.matches[0].id
    r = play(r, id, [
      { x: 5, y: 10 }, { x: 4, y: 10 },
      { x: 6, y: 10 }, { x: 10, y: 10 },
      { x: 7, y: 10 }, { x: 0, y: 0 },
      { x: 8, y: 10 }, { x: 0, y: 1 },
      { x: 9, y: 10 },
    ], START)
    const m = byId(r, id)
    expect(m.status).toBe('playing')
    expect(m.moves).toHaveLength(9)
  })

  it('resign → opponent wins resign', () => {
    const r = ready(startedRoom(2))
    const m0 = r.matches[0]
    const m = byId(resign(r, m0.id, m0.X!, START + 500, rng), m0.id)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('resign')
    expect(m.winner).toBe('O')
    expect(m.finishedAt).toBe(START + 500)
  })

  it('size-2 bracket finishes with third=null', () => {
    let r = ready(startedRoom(2))
    const m0 = r.matches[0]
    r = play(r, m0.id, FIVE, START)
    const at = START + 8000
    expect(r.status).toBe('finished')
    expect(r.placements).toEqual({ first: m0.X, second: m0.O, third: null })
    expect(r.finishedAt).toBe(at)
    expect(r.expiresAt.getTime()).toBe(at + 10 * 60 * 1000)
    expect(settleRoom(r, {}, at + 99_999, rng).changed).toBe(false)
  })
})

describe('bracket progression', () => {
  it('five_in_row finishes with winLine and advances winner', () => {
    let r = startedRoom(4)
    const semi = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    r = ready(r, semi)
    r = play(r, semi.id, FIVE, START)
    const m = byId(r, semi.id)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('five_in_row')
    expect(m.winner).toBe('X')
    expect(m.winLine).toEqual([5, 6, 7, 8, 9].map((x) => ({ x, y: 10 })))
    expect(final(r).b).toBe(semi.X) // slot 1 → field b
    expect(final(r).a).toBeNull()
    expect(third(r).b).toBe(semi.O) // semifinal loser → 3rd place, b for slot 1
    expect(final(r).status).toBe('waiting')
  })

  it('human vs bot: bot move appears only after botMoveDueAt', () => {
    let r = startedRoom(3, 5)
    const m0 = r.matches.find((m) => isBot(r, m.a) || isBot(r, m.b))!
    expect(isBot(r, m0.O)).toBe(true)
    r = ready(r, m0)
    expect(byId(r, m0.id).status).toBe('playing')
    r = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START + 1000, rng)
    const due = byId(r, m0.id).botMoveDueAt!
    expect(byId(r, m0.id).turnDeadlineAt).toBeNull()
    expect(due).toBeGreaterThanOrEqual(START + 1000 + 500)
    expect(due).toBeLessThanOrEqual(START + 1000 + 1000)
    const p = { [m0.X!]: due }
    const early = settleRoom(r, p, due - 1, rng)
    expect(early.changed).toBe(false)
    expect(byId(early.room, m0.id).moves).toHaveLength(1)
    const onTime = byId(settleRoom(r, p, due, rng).room, m0.id)
    expect(onTime.moves).toHaveLength(2)
    expect(onTime.moves[1].side).toBe('O')
    expect(onTime.moves[1].at).toBe(due)
    expect(onTime.botMoveDueAt).toBeNull()
    expect(onTime.turnDeadlineAt).toBe(due + TURN_MS)
  })

  it('bot scope: an out-of-scope due bot move is deferred, and so is everything after it in that match', () => {
    let r = startedRoom(3, 5)
    const m0 = r.matches.find((m) => isBot(r, m.a) || isBot(r, m.b))!
    r = ready(r, m0)
    r = playMove(r, m0.id, m0.X!, { x: 15, y: 15 }, 0, START + 1000, rng)
    const due = byId(r, m0.id).botMoveDueAt!
    byId(r, m0.id).startedAt = due - 60_000 // long-running game, so presence alone sets the deadline
    // the human was last seen so that their disconnect deadline falls 1 ms after the bot's move
    const p = { [m0.X!]: due + 1 - 35_000 }
    const now = due + 2
    const other = settleRoom(r, p, now, rng, { fullBotMatchId: 'ZZZZ' })
    expect(byId(other.room, m0.id).moves).toHaveLength(1)
    expect(byId(other.room, m0.id).status).toBe('playing') // the later disconnect is not applied either
    expect(settleRoom(r, p, now, rng, { fullBotMatchId: null }).changed).toBe(false)
    // in scope (or unscoped): the bot moves at its due time, then the disconnect applies
    for (const opts of [{ fullBotMatchId: m0.id }, undefined]) {
      const m = byId(settleRoom(r, p, now, rng, opts).room, m0.id)
      expect(m.moves).toHaveLength(2)
      expect(m.status).toBe('finished')
      expect(m.endReason).toBe('disconnect_timeout')
    }
    // deferred for longer than BOT_DEFER_MAX_MS: any settle plays it (no stall)
    const late = byId(settleRoom(r, { [m0.X!]: due + 10_000 }, due + 5_001, rng, { fullBotMatchId: null }).room, m0.id)
    expect(late.moves).toHaveLength(2)
    expect(late.moves[1].at).toBe(due)
  })

  it('bot vs bot later-round match resolves inside one settle', () => {
    // 5 humans → 8 slots, 3 bot pairs (with seed 3, slots 0 and 1 among them); those humans resign → bots meet.
    let r = startedRoom(5, 3)
    const s0 = r.matches.find((m) => m.round === 0 && m.slot === 0)!
    const s1 = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    expect(isBot(r, s0.O) && isBot(r, s1.O)).toBe(true)
    r = ready(r, s0)
    r = resign(r, s0.id, s0.X!, START + 100, rng)
    r = ready(r, s1, START + 200)
    r = resign(r, s1.id, s1.X!, START + 300, rng)
    const bb = r.matches.find((m) => m.round === 1 && m.slot === 0)!
    expect(isBot(r, bb.X) && isBot(r, bb.O)).toBe(true)
    expect(bb.X).toBe(bb.a) // both bots → a is X
    expect(bb.status).toBe('finished')
    expect(['five_in_row', 'board_full']).toContain(bb.endReason)
    expect(bb.startedAt).toBe(START + 300)
    expect(bb.moves.length).toBeGreaterThan(0)
    // the winning bot advanced into the final, field a (slot 0)
    expect(final(r).a).toBe(bb[bb.winner!])
  }, 30_000)

  it('next match becomes pending when the LATER feeder finished, even if settled out of order', () => {
    let r = startedRoom(4, 2)
    const s0 = r.matches.find((m) => m.round === 0 && m.slot === 0)!
    const s1 = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    r = ready(r, s1, START) // slot 1 times out at START+25s
    r = ready(r, s0, START + 20_000) // slot 0 times out at START+45s
    const everyone = Object.fromEntries(r.players.map((p) => [p.userId, START + 100_000]))
    const { room } = settleRoom(r, everyone, START + 100_000, rng)
    expect(byId(room, s1.id).finishedAt).toBe(START + 25_000)
    expect(byId(room, s0.id).finishedAt).toBe(START + 45_000)
    for (const m of [final(room), third(room)]) {
      expect(m.status).toBe('pending') // 55s ≤ NO_SHOW_MS: no no-show yet
      expect(m.pendingSince).toBe(START + 45_000)
    }
    expect(room.status).toBe('running')
    // ...and the no-show is measured from the correct moment.
    const later = settleRoom(room, everyone, START + 105_001, rng).room
    expect(final(later).endReason).toBe('no_show')
    expect(final(later).finishedAt).toBe(START + 105_000)
  })

  it('4-player bracket: semis losers meet in 3rd place; room finishes with placements', () => {
    let r = startedRoom(4, 2)
    const s0 = r.matches.find((m) => m.round === 0 && m.slot === 0)!
    const s1 = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    r = resolve(r, s0, START + 1000) // O resigns → X wins
    r = resolve(r, s1, START + 2000)
    expect(third(r).a).toBe(s0.O)
    expect(third(r).b).toBe(s1.O)
    expect(third(r).status).toBe('pending')
    expect(third(r).pendingSince).toBe(START + 2000)
    expect(final(r).a).toBe(s0.X)
    expect(final(r).b).toBe(s1.X)
    expect(final(r).status).toBe('pending')

    const f = final(r)
    r = resolve(r, f, START + 3000)
    expect(r.status).toBe('running') // 3rd place still open
    const t = third(r)
    r = resolve(r, t, START + 4000)
    expect(r.status).toBe('finished')
    expect(r.placements).toEqual({ first: final(r).X, second: final(r).O, third: third(r).X })
    expect(r.finishedAt).toBe(START + 4000)
  })

  it('isActive: eliminated player false, remaining player true, finished room false', () => {
    let lobby = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
    expect(isActive(lobby, 'u0')).toBe(true)
    expect(isActive(lobby, 'u9')).toBe(false)
    for (let i = 1; i < 4; i++) lobby = joinRoom(lobby, user(i), T0 + i)
    let r = startRoom(lobby, 'u0', START, mulberry(2))
    const s0 = r.matches.find((m) => m.round === 0 && m.slot === 0)!
    const s1 = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    r = resolve(r, s0, START + 1000)
    expect(isActive(r, s0.X!)).toBe(true) // waiting for the final
    expect(isActive(r, s0.O!)).toBe(true) // semifinal loser still has the 3rd-place match
    r = resolve(r, s1, START + 2000)
    r = resolve(r, final(r), START + 3000)
    const loserOfFinal = final(r).O!
    expect(isActive(r, loserOfFinal)).toBe(false) // eliminated
    expect(isActive(r, third(r).X!)).toBe(true)
    r = resolve(r, third(r), START + 4000)
    expect(r.status).toBe('finished')
    for (const p of r.players) expect(isActive(r, p.userId)).toBe(false)
  })

  it('commands never mutate their input', () => {
    const r = ready(startedRoom(2))
    const snapshot = structuredClone(r)
    const m0 = r.matches[0]
    playMove(r, m0.id, m0.X!, { x: 3, y: 3 }, 0, START + 10, rng)
    resign(r, m0.id, m0.X!, START + 10, rng)
    settleRoom(r, {}, START + 999_999, rng)
    expect(r).toEqual(snapshot)
  })
})
