import { describe, it, expect } from 'vitest'
import { createRoom, joinRoom, startRoom } from '@/src/tournament/room'
import { toMatchView, toRoomSummary, toRoomView } from '@/src/tournament/views'
import { DISCONNECT_DETECT_MS, NO_SHOW_MS, TURN_MS } from '@/src/tournament/constants'
import type { Match, Room } from '@/src/tournament/types'
import { mulberry, user } from './helpers'

const T0 = 1_000_000

function lobby(humans: number): Room {
  let r = createRoom({ code: 'ABCDEF', host: { userId: 'u0', name: 'Host Person', avatarUrl: null }, now: T0 })
  for (let i = 1; i < humans; i++) r = joinRoom(r, user(i), T0 + i)
  return r
}
const started = (n: number) => startRoom(lobby(n), 'u0', T0 + 100, mulberry(3))
const INV = 'https://t.me/b/app?startapp=ABCDEF'

describe('RoomView', () => {
  it('never exposes moves', () => {
    const r = started(4)
    r.matches[0].moves.push({ x: 1, y: 1, side: 'X', at: 1 })
    expect(JSON.stringify(toRoomView(r, 'u0', T0, INV))).not.toContain('"moves"')
  })

  it('isYours only on the viewer match; yourMatch set', () => {
    const r = started(4)
    const v = toRoomView(r, 'u0', T0 + 200, INV)
    const mine = v.rounds.flatMap((x) => x.matches).filter((m) => m.isYours)
    expect(mine).toHaveLength(1)
    expect(v.yourMatch?.id).toBe(mine[0].id)
    expect(v.yourMatch?.opponentName).toBeTruthy()
    expect(['X', 'O']).toContain(v.yourMatch!.youAre)
    expect(v.isHost).toBe(true)
    expect(v.serverNow).toBe(T0 + 200)
    expect(toRoomView(r, 'u1', T0, INV).isHost).toBe(false)
    expect(v.inviteUrl).toBe(INV)
  })

  it('3rd place is a trailing column', () => {
    const v = toRoomView(started(4), 'u0', T0, INV)
    expect(v.rounds.map((r) => r.name)).toEqual(['Semifinal', 'Final', '3rd Place'])
  })

  it('5-human lobby: 8 slots / 3 bots', () => {
    const v = toRoomView(lobby(5), 'u0', T0, INV)
    expect(v.slotsIfStartedNow).toBe(8)
    expect(v.botsIfStartedNow).toBe(3)
    expect(v.rounds).toEqual([])
    expect(v.players).toHaveLength(5)
  })

  it('summary', () => {
    const l = lobby(3)
    expect(toRoomSummary(l, 'u1')).toMatchObject({ code: 'ABCDEF', hostName: 'Host Person', status: 'lobby', playerCount: 3, youAreIn: true, liveLabel: null })
    expect(toRoomSummary(l, 'zz').youAreIn).toBe(false)
    expect(toRoomSummary(started(8), 'u0').liveLabel).toBe('Quarterfinal live')
  })
})

describe('MatchView', () => {
  function setup() {
    const r = started(2)
    return { r, m: r.matches[0] }
  }
  function play(m: Match, at: number) {
    m.readyAt = { X: at, O: at }
    m.status = 'playing'
    m.startedAt = at
    m.turnDeadlineAt = at + TURN_MS
  }

  it('pendingRemainingMs', () => {
    const { r, m } = setup()
    expect(m.status).toBe('pending')
    const v = toMatchView(r, m.id, m.X!, m.pendingSince! + 10_000, {})
    expect(v.pendingRemainingMs).toBe(NO_SHOW_MS - 10_000)
    expect(v.turnRemainingMs).toBeNull()
  })

  it('turnRemainingMs = deadline - now; spectator has you null', () => {
    const { r, m } = setup()
    play(m, T0)
    const v = toMatchView(r, m.id, m.X!, T0 + 4000, { [m.X!]: T0, [m.O!]: T0 + 4000 })
    expect(v.turnRemainingMs).toBe(TURN_MS - 4000)
    expect(v.you).toBe('X')
    expect(v.turn).toBe('X')
    const s = toMatchView(r, m.id, 'spectator', T0 + 4000, {})
    expect(s.you).toBeNull()
    expect(s.opponentDisconnected).toBe(false)
    expect(s.roundName).toBe('Final')
  })

  it('opponentDisconnected toggles at 5s', () => {
    const { r, m } = setup()
    play(m, T0)
    const pres = { [m.X!]: T0, [m.O!]: T0 }
    const a = toMatchView(r, m.id, m.X!, T0 + DISCONNECT_DETECT_MS, pres)
    expect(a.opponentDisconnected).toBe(false)
    expect(a.opponentReconnectRemainingMs).toBeNull()
    const b = toMatchView(r, m.id, m.X!, T0 + DISCONNECT_DETECT_MS + 1, pres)
    expect(b.opponentDisconnected).toBe(true)
    expect(b.opponentReconnectRemainingMs).toBe(29_999)
  })

  it('bots are never disconnected', () => {
    const r = started(3)
    const isBot = (id: string | null) => r.players.find((p) => p.userId === id)!.isBot
    const m = r.matches.find((x) => x.round === 0 && (isBot(x.a) || isBot(x.b)))!
    const v = toMatchView(r, m.id, m.X!, T0 + 10 * 60_000, {})
    expect(v.you).toBe('X')
    expect(v.players.O!.isBot).toBe(true)
    expect(v.opponentDisconnected).toBe(false)
    expect(v.opponentReconnectRemainingMs).toBeNull()
  })

  describe('nextStep', () => {
    function fin(m: Match, winner: 'X' | 'O') {
      m.status = 'finished'
      m.winner = winner
      m.endReason = 'resign'
      m.finishedAt = T0
    }
    const step = (r: Room, m: Match, uid: string) => toMatchView(r, m.id, uid, T0 + 1, {}).nextStep

    it('wait while unfinished', () => {
      const { r, m } = setup()
      expect(step(r, m, m.X!)).toBe('wait')
    })
    it('final: champion / podium', () => {
      const { r, m } = setup()
      fin(m, 'X')
      expect(step(r, m, m.X!)).toBe('champion')
      expect(step(r, m, m.O!)).toBe('podium')
    })
    it('semi winner and loser -> next_match; 3rd winner podium, 3rd loser eliminated', () => {
      const r = started(4)
      const semi = r.matches.find((m) => m.round === 0 && m.slot === 0)!
      fin(semi, 'X')
      expect(step(r, semi, semi.X!)).toBe('next_match')
      expect(step(r, semi, semi.O!)).toBe('next_match')
      const third = r.matches.find((m) => m.kind === 'third_place')!
      third.a = 'p1'
      third.b = 'p2'
      third.X = 'p1'
      third.O = 'p2'
      fin(third, 'X')
      expect(step(r, third, 'p1')).toBe('podium')
      expect(step(r, third, 'p2')).toBe('eliminated')
    })
    it('quarterfinal loser eliminated', () => {
      const r = started(8)
      const q = r.matches.find((m) => m.round === 0)!
      fin(q, 'X')
      expect(step(r, q, q.X!)).toBe('next_match')
      expect(step(r, q, q.O!)).toBe('eliminated')
    })
  })
})
