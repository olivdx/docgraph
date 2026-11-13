import { describe, expect, it } from 'vitest'
import { boardOf, isNewerView, latestView, newShots } from '@/src/client/battleship/sync'
import type { BattleMatchView, ShotView } from '@/src/battleship/views'

const shot = (cell: number, result: ShotView['result'] = 'miss', shipKey: ShotView['shipKey'] = null): ShotView => ({
  cell,
  result,
  shipKey,
  auto: false,
})

function view(you: 'a' | 'b' | null, a: ShotView[], b: ShotView[], fleets: BattleMatchView['fleets'] = { a: [], b: [] }): BattleMatchView {
  return {
    id: 'M1',
    roundName: 'Final',
    status: 'playing',
    you,
    players: { a: { name: 'A', avatarUrl: null }, b: { name: 'B', avatarUrl: null } },
    fleets,
    ready: { a: true, b: true },
    locked: { a: true, b: true },
    shots: { a, b },
    turn: 'a',
    turnRemainingMs: 20_000,
    placingRemainingMs: null,
    pendingRemainingMs: null,
    missedTurns: { a: 0, b: 0 },
    opponentDisconnected: false,
    opponentReconnectRemainingMs: null,
    winner: null,
    endReason: null,
    nextStep: 'wait',
    nextMatchId: null,
    serverNow: 0,
    version: 0,
  }
}

describe('boardOf', () => {
  it('maps a seat to the viewer-relative board; watchers see seat a as "me"', () => {
    expect(boardOf('a', 'a')).toBe('me')
    expect(boardOf('a', 'b')).toBe('enemy')
    expect(boardOf('b', 'b')).toBe('me')
    expect(boardOf(null, 'a')).toBe('me')
    expect(boardOf(null, 'b')).toBe('enemy')
  })
})

describe('newShots', () => {
  it('returns every shot on first sight, on the board being shot at', () => {
    const v = view('a', [shot(1)], [shot(2)])
    expect(newShots(null, v).map((x) => [x.board, x.shot.cell])).toEqual([
      ['enemy', 1],
      ['me', 2],
    ])
  })
  it('returns only shots beyond the previous counts', () => {
    const prev = view('a', [shot(1), shot(2)], [])
    const next = view('a', [shot(1), shot(2), shot(3)], [shot(9)])
    expect(newShots(prev, next).map((x) => [x.board, x.shot.cell])).toEqual([
      ['enemy', 3],
      ['me', 9],
    ])
  })
  it('attaches the sunk ship from the next view', () => {
    const sloop = { key: 'sloop' as const, cells: [34, 35] }
    const prev = view('a', [shot(34, 'hit')], [])
    const next = view('a', [shot(34, 'hit'), shot(35, 'sunk', 'sloop')], [], { a: [], b: [sloop] })
    const [s] = newShots(prev, next)
    expect(s.sunkShip).toEqual(sloop)
    expect(newShots(null, prev)[0].sunkShip).toBeNull()
  })
})

describe('view order', () => {
  const at = (version: number, serverNow: number, a: ShotView[] = []) => ({ ...view('a', a, []), version, serverNow })

  // The fire request stamps its time before the write lands; a poll that read the room just before
  // that write carries a later time but the older state.
  it('a stale poll with a later clock never replaces the answer to your shot', () => {
    const fired = at(8, 1_000, [shot(5)])
    const stalePoll = at(7, 1_020)
    expect(latestView(fired, stalePoll)).toBe(fired)
    expect(isNewerView(fired, stalePoll)).toBe(false)
  })
  it('a poll with a newer room version replaces the override', () => {
    const fired = at(8, 1_000, [shot(5)])
    const poll = at(9, 1_500, [shot(5)])
    expect(latestView(fired, poll)).toBe(poll)
    expect(isNewerView(fired, poll)).toBe(true)
  })
  it('at the same version the later clock wins (fresher countdowns); the same view is not newer', () => {
    const early = at(8, 1_000)
    const late = at(8, 2_000)
    expect(latestView(early, late)).toBe(late)
    expect(latestView(late, early)).toBe(late)
    expect(isNewerView(early, late)).toBe(true)
    expect(isNewerView(late, late)).toBe(false)
  })
  it('uses whichever view exists', () => {
    const v = at(1, 1)
    expect(latestView(null, v)).toBe(v)
    expect(latestView(v, null)).toBe(v)
    expect(latestView(null, null)).toBeNull()
  })
})
