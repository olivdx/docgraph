import { describe, expect, it } from 'vitest'
import { boardOf, newShots } from '@/src/client/battleship/sync'
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
