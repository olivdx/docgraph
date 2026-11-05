import { describe, expect, it } from 'vitest'
import {
  acceptRematch,
  createRoom,
  joinRoom,
  leaveMatch,
  markReady,
  normalizeRoom,
  playMove,
  resign,
  setFormat,
  settleRoom,
  startRoom,
} from '@/src/tournament/room'
import { REMATCH_WAIT_MS, TURN_MS } from '@/src/tournament/constants'
import { RoomError, type Match, type Room } from '@/src/tournament/types'
import type { Cell } from '@/src/game/types'
import { mulberry, user } from './helpers'

const T0 = 1_000_000
const START = T0 + 100
const rng = mulberry(42)

function lobby(humans: number): Room {
  let r = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
  for (let i = 1; i < humans; i++) r = joinRoom(r, user(i), T0 + i)
  return r
}

/** A started free-play room (1 human → vs a bot, 2 humans → vs each other), match ready and playing. */
function freeRoom(humans: 1 | 2, seed = 1): Room {
  let r = startRoom(setFormat(lobby(humans), 'u0', 'free'), 'u0', START, mulberry(seed))
  const m = r.matches[0]
  for (const id of [m.X, m.O]) if (id && !isBot(r, id)) r = markReady(r, m.id, id, START, rng)
  return r
}

const isBot = (r: Room, id: string | null) => r.players.find((p) => p.userId === id)?.isBot ?? false
const match = (r: Room): Match => r.matches[0]

/** Every human seen online at `at` (no disconnect forfeits). */
const seen = (r: Room, at: number) => Object.fromEntries(r.players.filter((p) => !p.isBot).map((p) => [p.userId, at]))
const settleAt = (r: Room, at: number) => settleRoom(r, seen(r, at), at, rng).room

const FIVE: Cell[] = [
  { x: 5, y: 10 }, { x: 0, y: 0 },
  { x: 6, y: 10 }, { x: 0, y: 1 },
  { x: 7, y: 10 }, { x: 0, y: 2 },
  { x: 8, y: 10 }, { x: 0, y: 3 },
  { x: 9, y: 10 },
]

/** The current X makes five, one second apart from `at`. Returns the room and the time of the last move. */
function xWinsGame(r: Room, at: number): { r: Room; at: number } {
  for (const c of FIVE) {
    const m = match(r)
    const side = m.moves.length % 2 === 0 ? 'X' : 'O'
    r = playMove(r, m.id, m[side]!, c, m.moves.length, at, rng)
    at += 1000
  }
  return { r, at: at - 1000 }
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

describe('choosing free play', () => {
  it('host only, lobby only, at most 2 players; it sets mode free', () => {
    const two = lobby(2)
    expect(two.mode).toBe('cup')
    const free = setFormat(two, 'u0', 'free')
    expect(free.mode).toBe('free')
    expect(two.mode).toBe('cup') // pure
    expect(setFormat(free, 'u0', 'bo3')).toMatchObject({ mode: 'cup', bestOf: 3 })
    expect(code(() => setFormat(two, 'u1', 'free'))).toBe('not_host')
    expect(code(() => setFormat(lobby(3), 'u0', 'free'))).toBe('too_many_players')
    expect(code(() => setFormat(freeRoom(2), 'u0', 'bo1'))).toBe('not_lobby')
  })

  it('a free room takes no third player', () => {
    expect(code(() => joinRoom(setFormat(lobby(2), 'u0', 'free'), user(2), T0 + 5))).toBe('full')
  })

  it('alone, the host plays a bot; with two, they play each other', () => {
    expect(isBot(freeRoom(1), match(freeRoom(1)).O)).toBe(true)
    const r = freeRoom(2)
    expect(r.matches).toHaveLength(1)
    expect([match(r).X, match(r).O].every((id) => !isBot(r, id))).toBe(true)
    expect(match(r).status).toBe('playing')
  })
})

describe('free play games', () => {
  it('a finished game waits for a rematch: no clock, moves rejected, room still running', () => {
    const r0 = freeRoom(2)
    const m0 = match(r0)
    const { r, at } = xWinsGame(r0, START)
    const m = match(r)
    expect(m.status).toBe('playing')
    expect(m.games).toEqual([{ winner: m0.X, endReason: 'five_in_row', finishedAt: at }])
    expect(m.rematch).toEqual({ since: at, ready: [] })
    expect(m.winLine).toHaveLength(5)
    expect(m.turnDeadlineAt).toBeNull()
    expect(m.nextGameAt).toBeNull()
    expect(r.status).toBe('running')
    expect(code(() => playMove(r, m.id, m0.O!, { x: 20, y: 20 }, 9, at + 10, rng))).toBe('not_playing')
    expect(settleAt(r, at + REMATCH_WAIT_MS - 1)).toBe(r) // nothing due before the wait runs out
  })

  it('both accept → the next game starts at once with sides swapped and a fresh clock', () => {
    const r0 = freeRoom(2)
    const m0 = match(r0)
    let { r, at } = xWinsGame(r0, START)
    r = acceptRematch(r, m0.id, m0.O!, at + 1000, rng)
    r = acceptRematch(r, m0.id, m0.O!, at + 1500, rng) // idempotent
    expect(match(r).rematch).toEqual({ since: at, ready: [m0.O] })
    at += 2000
    r = acceptRematch(r, m0.id, m0.X!, at, rng)
    const m = match(r)
    expect(m.rematch).toBeNull()
    expect(m.X).toBe(m0.O)
    expect(m.O).toBe(m0.X)
    expect(m.moves).toEqual([])
    expect(m.winLine).toBeNull()
    expect(m.turnDeadlineAt).toBe(at + TURN_MS)
    expect(m.games).toHaveLength(1)
  })

  it('vs a bot: the bot accepts by itself, so one tap starts the next game (bot moves first)', () => {
    let r = settleAt(freeRoom(1), START + TURN_MS + 1) // the human (X) times out game 1
    const m0 = match(r)
    expect(m0.rematch?.ready).toEqual([m0.O]) // the bot
    expect(m0.games[0]).toMatchObject({ endReason: 'turn_timeout', winner: m0.O })
    const at = START + TURN_MS + 5000
    r = acceptRematch(r, m0.id, m0.X!, at, rng)
    const m = match(r)
    expect(isBot(r, m.X)).toBe(true)
    expect(m.botMoveDueAt).toBeGreaterThanOrEqual(at + 500)
  })

  it('resign gives up only the current game', () => {
    const r0 = freeRoom(2)
    const m0 = match(r0)
    const r = resign(r0, m0.id, m0.X!, START + 500, rng)
    const m = match(r)
    expect(m.status).toBe('playing')
    expect(m.games).toEqual([{ winner: m0.O, endReason: 'resign', finishedAt: START + 500 }])
    expect(m.rematch).toEqual({ since: START + 500, ready: [] })
    expect(code(() => resign(r, m0.id, m0.X!, START + 600, rng))).toBe('not_playing') // nothing to resign while waiting
  })

  it('cup rooms are unchanged: a finished game ends the match', () => {
    const r0 = startRoom(lobby(2), 'u0', START, mulberry(1))
    let r = r0
    for (const id of [match(r0).X!, match(r0).O!]) r = markReady(r, match(r0).id, id, START, rng)
    ;({ r } = xWinsGame(r, START))
    expect(match(r).status).toBe('finished')
    expect(match(r).rematch).toBeNull()
  })
})

describe('ending free play', () => {
  it('leave ends the room; the higher score wins, a tie goes to whoever stayed', () => {
    const r0 = freeRoom(2)
    const m0 = match(r0)
    const { r, at } = xWinsGame(r0, START) // m0.X leads 1–0
    const leftByLeader = leaveMatch(r, m0.id, m0.X!, at + 1000, rng)
    const m = match(leftByLeader)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('left')
    expect(m[m.winner!]).toBe(m0.X) // still ahead on score
    expect(leftByLeader.status).toBe('finished')
    expect(leftByLeader.placements).toMatchObject({ first: m0.X, second: m0.O })

    const tied = leaveMatch(r0, m0.id, m0.X!, START + 500, rng) // 0–0, mid-game
    expect(match(tied)[match(tied).winner!]).toBe(m0.O)
  })

  it('no rematch within the wait ends the room', () => {
    const r0 = freeRoom(2)
    const m0 = match(r0)
    const g1 = xWinsGame(r0, START) // m0.X leads 1–0
    const at = g1.at
    let r = acceptRematch(g1.r, m0.id, m0.O!, at + 1000, rng) // only O wants more
    r = settleAt(r, at + REMATCH_WAIT_MS + 1)
    const m = match(r)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('left')
    expect(m.finishedAt).toBe(at + REMATCH_WAIT_MS)
    expect(m[m.winner!]).toBe(m0.X) // score decides
    expect(r.status).toBe('finished')
  })

  it('a disconnect ends the room (score decides, tie → the one still here)', () => {
    const r0 = freeRoom(2)
    const m0 = match(r0)
    const late = START + 40_000
    const r = settleRoom(r0, { [m0.X!]: late, [m0.O!]: START }, late, rng).room // O went silent at START
    const m = match(r)
    expect(m.status).toBe('finished')
    expect(m.endReason).toBe('disconnect_timeout')
    expect(m[m.winner!]).toBe(m0.X)
  })

  it('leave is free-play only', () => {
    const r = startRoom(lobby(2), 'u0', START, mulberry(1))
    expect(code(() => leaveMatch(r, match(r).id, 'u0', START + 1, rng))).toBe('not_playing')
  })
})

describe('rooms stored before free play existed', () => {
  it('read as cup rooms with no rematch pending', () => {
    const r = freeRoom(2) as unknown as Record<string, unknown> & { matches: Record<string, unknown>[] }
    delete r.mode
    for (const m of r.matches) delete m.rematch
    const n = normalizeRoom(r as unknown as Room)
    expect(n.mode).toBe('cup')
    expect(n.matches[0].rematch).toBeNull()
  })
})
