import { describe, expect, it } from 'vitest'
import { applyMoveSignal, isBehindSignal, SIGNAL_GRACE_MS } from '@/src/client/match-signal'
import type { MoveSignal } from '@/src/realtime/channels'
import type { MatchView } from '@/src/tournament/views'

const view = (over: Partial<MatchView> = {}): MatchView => ({
  id: 'AB12',
  roundName: 'Final',
  status: 'playing',
  you: 'O',
  players: { X: { name: 'A', isBot: false }, O: { name: 'B', isBot: false } },
  moves: [{ x: 0, y: 0, side: 'X', at: 1 }],
  bestOf: 3,
  gameNo: 2,
  score: { X: 1, O: 0 },
  lastGame: null,
  nextGameRemainingMs: null,
  turn: 'O',
  turnRemainingMs: 40_000,
  pendingRemainingMs: null,
  opponentDisconnected: false,
  opponentReconnectRemainingMs: null,
  winner: null,
  endReason: null,
  winLine: null,
  nextStep: 'wait',
  nextMatchId: null,
  serverNow: 1,
  ...over,
})

const signal = (over: Partial<MoveSignal> = {}): MoveSignal => ({
  matchId: 'AB12',
  game: 2,
  from: 1,
  moves: [{ x: 1, y: 0, side: 'O', at: 2 }],
  turnRemainingMs: 85_000,
  ...over,
})

describe('applyMoveSignal', () => {
  it('appends the next move, hands the turn over and resets the clock', () => {
    const v = view({ you: 'X', turn: 'O', opponentDisconnected: true, opponentReconnectRemainingMs: 9_000 })
    expect(applyMoveSignal(v, signal())).toEqual({
      ...v,
      moves: [...v.moves, { x: 1, y: 0, side: 'O', at: 2 }],
      turn: 'X',
      turnRemainingMs: 85_000,
      opponentDisconnected: false, // they just moved
      opponentReconnectRemainingMs: null,
    })
  })

  it('ignores signals that do not continue the shown move list', () => {
    const v = view()
    expect(applyMoveSignal(v, signal({ from: 0 }))).toBeNull() // already shown
    expect(applyMoveSignal(v, signal({ from: 2 }))).toBeNull() // a move is missing in between
    expect(applyMoveSignal(v, signal({ matchId: 'ZZ99' }))).toBeNull()
    expect(applyMoveSignal(v, signal({ game: 1 }))).toBeNull() // another game of the series
    expect(applyMoveSignal(view({ turn: null }), signal())).toBeNull() // break between games
    expect(applyMoveSignal(view({ status: 'finished' }), signal())).toBeNull()
  })

  it('a game-ending move leaves no one to move until the server says what comes next', () => {
    expect(applyMoveSignal(view(), signal({ turnRemainingMs: null }))?.turn).toBeNull()
  })
})

describe('isBehindSignal', () => {
  const pending = { game: 2, count: 2, until: 10_000 }

  it('holds back a fetched view that lacks the signalled move during the grace period', () => {
    expect(isBehindSignal(view(), pending, 10_000 - 1)).toBe(true)
    expect(isBehindSignal(view({ gameNo: 1, moves: [] }), pending, 0)).toBe(true) // still the previous game
  })

  it('a view of a later game is never behind', () => {
    expect(isBehindSignal(view({ gameNo: 3, moves: [] }), pending, 0)).toBe(false)
  })

  it('accepts the stored truth once it has the move, or once the grace period is over', () => {
    expect(isBehindSignal(view({ moves: [...view().moves, signal().moves[0]] }), pending, 0)).toBe(false)
    expect(isBehindSignal(view(), pending, 10_000)).toBe(false)
    expect(isBehindSignal(view(), null, 0)).toBe(false)
  })

  it('uses a 3 s grace period', () => {
    expect(SIGNAL_GRACE_MS).toBe(3_000)
  })
})
