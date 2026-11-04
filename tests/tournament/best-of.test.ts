import { describe, expect, it } from 'vitest'
import {
  createRoom,
  joinRoom,
  markReady,
  normalizeRoom,
  playMove,
  resign,
  setBestOf,
  settleRoom,
  startRoom,
} from '@/src/tournament/room'
import { GAME_BREAK_MS, TURN_MS } from '@/src/tournament/constants'
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

function started(humans: number, bestOf: 1 | 3, seed = 1): Room {
  return startRoom(setBestOf(lobby(humans), 'u0', bestOf), 'u0', START, mulberry(seed))
}

const isBot = (r: Room, id: string | null) => r.players.find((p) => p.userId === id)?.isBot ?? false
const byId = (r: Room, id: string) => r.matches.find((m) => m.id === id)!

function ready(r: Room, m: Match = r.matches[0], at = START): Room {
  for (const id of [m.X, m.O]) if (id && !isBot(r, id)) r = markReady(r, m.id, id, at, rng)
  return r
}

/** The side to move makes five on row 10 while the other side plays harmlessly on column 0. */
const FIVE: Cell[] = [
  { x: 5, y: 10 }, { x: 0, y: 0 },
  { x: 6, y: 10 }, { x: 0, y: 1 },
  { x: 7, y: 10 }, { x: 0, y: 2 },
  { x: 8, y: 10 }, { x: 0, y: 3 },
  { x: 9, y: 10 },
]

/** Plays FIVE from `at`, one second apart, so the current X wins the game. Returns the room and the time after. */
function xWinsGame(r: Room, matchId: string, at: number): { r: Room; at: number } {
  for (const c of FIVE) {
    const m = byId(r, matchId)
    const side = m.moves.length % 2 === 0 ? 'X' : 'O'
    r = playMove(r, matchId, m[side]!, c, m.moves.length, at, rng)
    at += 1000
  }
  return { r, at: at - 1000 }
}

/** Every human seen online at `at` (no disconnect forfeits). */
const seen = (r: Room, at: number) => Object.fromEntries(r.players.filter((p) => !p.isBot).map((p) => [p.userId, at]))

/** Settles at `at` with everyone online. */
const settleAt = (r: Room, at: number) => settleRoom(r, seen(r, at), at, rng)

/** Settles the room at the end of the break so the next game starts. */
function nextGame(r: Room, matchId: string): Room {
  return settleAt(r, byId(r, matchId).nextGameAt!).room
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

describe('format choice', () => {
  it('defaults to Bo1; the host can switch it in the lobby only', () => {
    const l = lobby(2)
    expect(l.bestOf).toBe(1)
    expect(setBestOf(l, 'u0', 3).bestOf).toBe(3)
    expect(l.bestOf).toBe(1) // pure
    expect(code(() => setBestOf(l, 'u1', 3))).toBe('not_host')
    expect(code(() => setBestOf(started(2, 1), 'u0', 3))).toBe('not_lobby')
  })
})

describe('Bo1', () => {
  it('one game decides the match, recorded as a game', () => {
    let r = ready(started(2, 1))
    const m0 = r.matches[0]
    ;({ r } = xWinsGame(r, m0.id, START))
    const m = byId(r, m0.id)
    expect(m.status).toBe('finished')
    expect(m.winner).toBe('X')
    expect(m.games).toEqual([{ winner: m0.X, endReason: 'five_in_row', finishedAt: START + 8000 }])
    expect(m.nextGameAt).toBeNull()
  })
})

describe('Bo3', () => {
  it('a won game opens a break: board and win line stay, no clock, moves rejected', () => {
    const m0 = started(2, 3).matches[0]
    const { r, at } = xWinsGame(ready(started(2, 3)), m0.id, START)
    const m = byId(r, m0.id)
    expect(m.status).toBe('playing')
    expect(m.winner).toBeNull()
    expect(m.games).toEqual([{ winner: m0.X, endReason: 'five_in_row', finishedAt: at }])
    expect(m.winLine).toHaveLength(5)
    expect(m.moves).toHaveLength(9)
    expect(m.turnDeadlineAt).toBeNull()
    expect(m.nextGameAt).toBe(at + GAME_BREAK_MS)
    expect(code(() => playMove(r, m0.id, m0.O!, { x: 20, y: 20 }, 9, at + 500, rng))).toBe('not_playing')
    expect(settleAt(r, at + GAME_BREAK_MS - 1).changed).toBe(false)
  })

  it('the next game starts at the end of the break with sides swapped and a fresh clock', () => {
    let r = ready(started(2, 3))
    const m0 = r.matches[0]
    ;({ r } = xWinsGame(r, m0.id, START))
    const due = byId(r, m0.id).nextGameAt!
    r = nextGame(r, m0.id)
    const m = byId(r, m0.id)
    expect(m.X).toBe(m0.O)
    expect(m.O).toBe(m0.X)
    expect(m.moves).toEqual([])
    expect(m.winLine).toBeNull()
    expect(m.nextGameAt).toBeNull()
    expect(m.turnDeadlineAt).toBe(due + TURN_MS)
  })

  it('2–0 ends the match after game 2; the winner id is m[m.winner]', () => {
    let r = ready(started(2, 3))
    const m0 = r.matches[0]
    let at: number
    ;({ r, at } = xWinsGame(r, m0.id, START)) // m0.X wins game 1
    r = nextGame(r, m0.id)
    // game 2: m0.X is now O; let the new X (m0.O) time out
    const g2 = byId(r, m0.id)
    at = g2.turnDeadlineAt!
    r = settleAt(r, at + 1).room
    const m = byId(r, m0.id)
    expect(m.status).toBe('finished')
    expect(m[m.winner!]).toBe(m0.X)
    expect(m.endReason).toBe('turn_timeout')
    expect(m.games.map((g) => g.winner)).toEqual([m0.X, m0.X])
    expect(r.status).toBe('finished')
    expect(r.placements.first).toBe(m0.X)
    expect(r.placements.second).toBe(m0.O)
  })

  it('1–1 goes to a third game with sides swapped again', () => {
    let r = ready(started(2, 3))
    const m0 = r.matches[0]
    let at: number
    ;({ r } = xWinsGame(r, m0.id, START)) // game 1: m0.X
    r = nextGame(r, m0.id)
    ;({ r, at } = xWinsGame(r, m0.id, byId(r, m0.id).turnDeadlineAt! - TURN_MS + 1000)) // game 2: m0.O (now X)
    expect(byId(r, m0.id).status).toBe('playing')
    r = nextGame(r, m0.id)
    expect(byId(r, m0.id).X).toBe(m0.X)
    ;({ r, at } = xWinsGame(r, m0.id, at + GAME_BREAK_MS + 1000)) // game 3: m0.X
    const m = byId(r, m0.id)
    expect(m.status).toBe('finished')
    expect(m[m.winner!]).toBe(m0.X)
    expect(m.endReason).toBe('five_in_row')
    expect(m.winLine).toHaveLength(5)
    expect(m.games.map((g) => g.winner)).toEqual([m0.X, m0.O, m0.X])
  })

  it('a turn timeout loses only that game', () => {
    const r = ready(started(2, 3))
    const m0 = r.matches[0]
    const m = byId(settleAt(r, START + TURN_MS + 1).room, m0.id)
    expect(m.status).toBe('playing')
    expect(m.games).toEqual([{ winner: m0.O, endReason: 'turn_timeout', finishedAt: START + TURN_MS }])
    expect(m.nextGameAt).toBe(START + TURN_MS + GAME_BREAK_MS)
  })

  it('resign loses the whole match, also during a break', () => {
    const m0 = started(2, 3).matches[0]
    const g1 = xWinsGame(ready(started(2, 3)), m0.id, START)
    const r = resign(g1.r, m0.id, m0.X!, g1.at + 500, rng) // the leader resigns during the break
    const m = byId(r, m0.id)
    expect(m.status).toBe('finished')
    expect(m[m.winner!]).toBe(m0.O)
    expect(m.endReason).toBe('resign')
    expect(m.nextGameAt).toBeNull()
  })

  it('vs a bot: the bot plays X in game 2 and moves first after the break', () => {
    let r = started(3, 3, 5)
    const m0 = r.matches.find((m) => isBot(r, m.a) || isBot(r, m.b))!
    r = ready(r, m0)
    r = settleAt(r, START + TURN_MS + 1).room // the human (X) times out game 1
    const due = byId(r, m0.id).nextGameAt!
    const m = byId(settleAt(r, due).room, m0.id)
    expect(isBot(r, m.X)).toBe(true)
    expect(m.turnDeadlineAt).toBeNull()
    expect(m.botMoveDueAt).toBeGreaterThanOrEqual(due + 500)
  })

  it('a bot-vs-bot series resolves inside one settle, alternating X', () => {
    let r = started(5, 3, 3)
    const s0 = r.matches.find((m) => m.round === 0 && m.slot === 0)!
    const s1 = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    r = ready(r, s0)
    r = resign(r, s0.id, s0.X!, START + 100, rng)
    r = ready(r, s1, START + 200)
    r = resign(r, s1.id, s1.X!, START + 300, rng)
    const bb = r.matches.find((m) => m.round === 1 && m.slot === 0)!
    expect(isBot(r, bb.X) && isBot(r, bb.O)).toBe(true)
    expect(bb.status).toBe('finished')
    expect(bb.games.length).toBeGreaterThanOrEqual(2)
    const wins = bb.games.filter((g) => g.winner === bb[bb.winner!]).length
    expect(wins).toBe(2)
    expect(bb.nextGameAt).toBeNull()
  }, 60_000)
})

describe('rooms stored before Bo3 existed', () => {
  it('read as Bo1 with no recorded games and no break', () => {
    const r = started(2, 1) as unknown as Record<string, unknown> & { matches: Record<string, unknown>[] }
    delete r.bestOf
    for (const m of r.matches) {
      delete m.games
      delete m.nextGameAt
    }
    const n = normalizeRoom(r as unknown as Room)
    expect(n.bestOf).toBe(1)
    expect(n.matches.every((m) => Array.isArray(m.games) && m.games.length === 0 && m.nextGameAt === null)).toBe(true)
  })
})
