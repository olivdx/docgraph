import { describe, it, expect } from 'vitest'
import { cancelRoom, createRoom, joinRoom, leaveRoom, startRoom } from '@/src/tournament/room'
import { FINISHED_TTL_MS, LOBBY_TTL_MS } from '@/src/tournament/constants'
import { RoomError, type Room } from '@/src/tournament/types'
import { mulberry, user } from './helpers'

const T0 = 1_000_000

function lobby(humans: number): Room {
  let r = createRoom({ code: 'ABCDEF', host: { userId: 'u0', name: 'Son Duong', avatarUrl: null }, now: T0 })
  for (let i = 1; i < humans; i++) r = joinRoom(r, user(i), T0 + i)
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

describe('lobby commands', () => {
  it('create defaults', () => {
    const r = createRoom({ code: 'ABCDEF', host: { userId: 'u0', name: 'Son Duong', avatarUrl: null }, now: T0 })
    expect(r._id).toBe('ABCDEF')
    expect(r.name).toBe("Son's Cup")
    expect(r.status).toBe('lobby')
    expect(r.hostId).toBe('u0')
    expect(r.version).toBe(0)
    expect(r.players).toHaveLength(1)
    expect(r.expiresAt).toBeInstanceOf(Date)
    expect(r.expiresAt.getTime()).toBe(T0 + LOBBY_TTL_MS)
    expect(T0 + LOBBY_TTL_MS - T0).toBe(2 * 60 * 60 * 1000)
  })

  it('custom name is kept', () => {
    const r = createRoom({ code: 'ABCDEF', host: user(0), name: 'Friday Night', now: T0 })
    expect(r.name).toBe('Friday Night')
  })

  it('join is idempotent and does not mutate the input', () => {
    const r0 = lobby(1)
    const r1 = joinRoom(r0, user(1), T0 + 5)
    expect(r0.players).toHaveLength(1)
    const r2 = joinRoom(r1, user(1), T0 + 6)
    expect(r2.players).toHaveLength(2)
    expect(r2.players.filter((p) => p.userId === 'u1')).toHaveLength(1)
  })

  it('join 33rd → full', () => {
    const r = lobby(32)
    expect(r.players).toHaveLength(32)
    expect(code(() => joinRoom(r, user(99), T0 + 100))).toBe('full')
  })

  it('join running → not_lobby', () => {
    const r = startRoom(lobby(2), 'u0', T0 + 10, mulberry(1))
    expect(code(() => joinRoom(r, user(5), T0 + 20))).toBe('not_lobby')
  })

  it('non-host start → not_host', () => {
    expect(code(() => startRoom(lobby(3), 'u1', T0 + 10, mulberry(1)))).toBe('not_host')
  })

  it('1 human start → 2-slot final vs 1 bot (human X, bot O)', () => {
    const now = T0 + 10
    const r = startRoom(lobby(1), 'u0', now, mulberry(1))
    expect(r.status).toBe('running')
    expect(r.totalRounds).toBe(1)
    expect(r.players).toHaveLength(2)
    expect(r.players.filter((p) => p.isBot)).toHaveLength(1)
    expect(r.matches.filter((m) => m.kind === 'normal')).toHaveLength(1)
    const m = r.matches[0]
    expect(m.status).toBe('pending')
    expect(m.round).toBe(0)
    const isBot = (id: string | null) => r.players.find((p) => p.userId === id)!.isBot
    expect(isBot(m.X)).toBe(false)
    expect(isBot(m.O)).toBe(true)
    expect(m.X).toBe('u0')
  })

  it('0 humans start → too_few_players', () => {
    const empty = structuredClone(lobby(1))
    empty.players = []
    expect(code(() => startRoom(empty, 'u0', T0 + 10, mulberry(1)))).toBe('too_few_players')
  })

  it('5 humans start → 8 slots, 3 bots, 7 normal + 1 third_place, round 0 pending, bots are O', () => {
    const now = T0 + 10
    const r = startRoom(lobby(5), 'u0', now, mulberry(7))
    expect(r.status).toBe('running')
    expect(r.startedAt).toBe(now)
    expect(r.totalRounds).toBe(3)
    expect(r.players).toHaveLength(8)
    expect(r.players.filter((p) => p.isBot)).toHaveLength(3)
    expect(r.players.map((p) => p.seed).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(r.matches.filter((m) => m.kind === 'normal')).toHaveLength(7)
    expect(r.matches.filter((m) => m.kind === 'third_place')).toHaveLength(1)
    const third = r.matches.find((m) => m.kind === 'third_place')!
    expect([third.round, third.slot, third.status]).toEqual([2, 1, 'waiting'])
    const final = r.matches.find((m) => m.kind === 'normal' && m.round === 2)!
    expect(final.slot).toBe(0)
    const ids = new Set(r.matches.map((m) => m.id))
    expect(ids.size).toBe(8)
    for (const id of ids) expect(id).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/)

    const r0 = r.matches.filter((m) => m.round === 0)
    expect(r0).toHaveLength(4)
    const isBot = (id: string | null) => r.players.find((p) => p.userId === id)!.isBot
    let botMatches = 0
    for (const m of r0) {
      expect(m.status).toBe('pending')
      expect(m.pendingSince).toBe(now)
      expect(m.a).not.toBeNull()
      expect(m.b).not.toBeNull()
      if (isBot(m.a) || isBot(m.b)) {
        botMatches++
        expect(isBot(m.O)).toBe(true)
        expect(isBot(m.X)).toBe(false)
        expect(m.readyAt.O).toBe(now)
        expect(m.readyAt.X).toBeNull()
      }
    }
    expect(botMatches).toBe(3)
    for (const m of r.matches.filter((m) => m.round > 0)) expect(m.status).toBe('waiting')
  })

  it('leave: member leaves, host → host_must_cancel', () => {
    const r = lobby(3)
    expect(leaveRoom(r, 'u2').players.map((p) => p.userId)).toEqual(['u0', 'u1'])
    expect(code(() => leaveRoom(r, 'u0'))).toBe('host_must_cancel')
  })

  it('cancel: host only, sets cancelled, finishedAt and expiresAt +10 min', () => {
    const r = lobby(2)
    expect(code(() => cancelRoom(r, 'u1', T0 + 50))).toBe('not_host')
    const c = cancelRoom(r, 'u0', T0 + 50)
    expect(c.status).toBe('cancelled')
    expect(c.finishedAt).toBe(T0 + 50)
    expect(c.expiresAt.getTime()).toBe(T0 + 50 + FINISHED_TTL_MS)
    expect(FINISHED_TTL_MS).toBe(10 * 60 * 1000)
    expect(code(() => cancelRoom(c, 'u0', T0 + 60))).toBe('not_lobby')
  })
})
