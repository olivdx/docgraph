import { describe, expect, it } from 'vitest'
import { createBattleRoom, fire, joinBattle, markBattleReady, saveFleet, startBattle } from '@/src/battleship/room'
import type { BattleRoom, Seat } from '@/src/battleship/types'
import { toBattleMatchView, toBattleRoomView, toBattleSummary } from '@/src/battleship/views'
import { mulberry, user } from '../tournament/helpers'
import { FLEET_A as FLEET, SHIP_CELLS, WATER } from './helpers'

const T0 = 1_800_000_000_000

function cup(n: number): BattleRoom {
  let r = createBattleRoom({ code: 'ABCD', host: user(1), now: T0 })
  for (let i = 2; i <= n; i++) r = joinBattle(r, user(i), T0)
  return startBattle(r, 'u1', T0, mulberry(1))
}

function toBattle(r: BattleRoom, id: string, t: number): BattleRoom {
  const m = r.matches.find((x) => x.id === id)!
  for (const uid of [m.a!, m.b!]) r = markBattleReady(r, id, uid, t, mulberry(5), null)
  for (const uid of [m.a!, m.b!]) r = saveFleet(r, id, uid, FLEET, true, t, mulberry(5), null)
  return r
}

/** shooter (who moves first, and keeps the turn while hitting): brig hit once, sloop sunk. */
function midBattle() {
  let r = cup(2)
  const id = r.matches[0].id
  r = toBattle(r, id, T0)
  const m0 = r.matches[0]
  const shooter = m0.turn!
  const other: Seat = shooter === 'a' ? 'b' : 'a'
  const plan: Record<Seat, number[]> = { [shooter]: [62, 98, 99], [other]: WATER } as Record<Seat, number[]>
  const used: Record<Seat, number> = { a: 0, b: 0 }
  let t = T0
  for (let i = 0; i < 3; i++) {
    const m = r.matches[0]
    const seat = m.turn!
    t += 1000
    r = fire(r, id, m[seat]!, plan[seat][used[seat]++], m.shots[seat].length + 1, t, mulberry(1), null)
  }
  return { r, id, shooter, other, t }
}

describe('toBattleMatchView', () => {
  it('hit shots never carry shipKey; watcher sees only sunk ships', () => {
    const { r, id, shooter, other, t } = midBattle()
    const m = r.matches[0]
    const asOther = toBattleMatchView(r, id, m[other]!, t, null)
    // The shooter fired at `other`'s fleet: other sees its own fleet in full.
    expect(asOther.fleets[other]).toHaveLength(6)
    // The shooter's own view of the other fleet: only the sunk sloop.
    const asShooter = toBattleMatchView(r, id, m[shooter]!, t, null)
    expect(asShooter.fleets[other]).toEqual([{ key: 'sloop', cells: [98, 99] }])
    const shots = asShooter.shots[shooter]
    expect(shots.map((s) => [s.result, s.shipKey])).toEqual([
      ['hit', null],
      ['hit', null],
      ['sunk', 'sloop'],
    ])
    const watcher = toBattleMatchView(r, id, 'u9', t, null)
    expect(watcher.you).toBeNull()
    expect(watcher.fleets[other]).toEqual([{ key: 'sloop', cells: [98, 99] }])
    expect(watcher.fleets[shooter]).toEqual([])
    expect(JSON.stringify(asShooter.fleets[other])).not.toContain('"brig"')
    expect(JSON.stringify(watcher)).not.toContain('"brig"')
  })

  it('finished match reveals both fleets to everyone', () => {
    let r = cup(2)
    const id = r.matches[0].id
    r = toBattle(r, id, T0)
    const shooter = r.matches[0].turn!
    const order = SHIP_CELLS
    let k = 0
    let w = 0
    for (let t = T0 + 1000; r.matches[0].status === 'playing'; t += 1000) {
      const m = r.matches[0]
      const seat = m.turn!
      const cell = seat === shooter ? order[k++] : WATER[w++]
      r = fire(r, id, m[seat]!, cell, m.shots[seat].length + 1, t, mulberry(1), null)
    }
    const v = toBattleMatchView(r, id, 'u9', T0 + 99_000, null)
    expect(v.fleets.a).toHaveLength(6)
    expect(v.fleets.b).toHaveLength(6)
    expect(v.winner).toBe(shooter)
  })

  it('own fleet is always visible to its owner during placing', () => {
    let r = cup(2)
    const m = r.matches[0]
    r = markBattleReady(r, m.id, m.a!, T0, mulberry(1), null)
    r = markBattleReady(r, m.id, m.b!, T0, mulberry(1), null)
    r = saveFleet(r, m.id, m.a!, [FLEET[0]], false, T0 + 500, mulberry(1), null)
    const v = toBattleMatchView(r, m.id, m.a!, T0 + 1000, null)
    expect(v.status).toBe('placing')
    expect(v.fleets.a).toEqual([FLEET[0]])
    expect(v.locked).toEqual({ a: false, b: false })
    expect(v.placingRemainingMs).toBe(44_000)
    expect(toBattleMatchView(r, m.id, m.b!, T0 + 1000, null).fleets.a).toEqual([])
  })

  it('turnRemainingMs hides the grace', () => {
    let r = cup(2)
    const id = r.matches[0].id
    r = toBattle(r, id, T0)
    const m = r.matches[0]
    const seat = m.turn!
    r = fire(r, id, m[seat]!, 5, 1, T0 + 1000, mulberry(1), null)
    expect(toBattleMatchView(r, id, m.a!, T0 + 1000, null).turnRemainingMs).toBe(20_000)
    expect(toBattleMatchView(r, id, m.a!, T0 + 14_000, null).turnRemainingMs).toBe(10_000)
  })

  it('reports an opponent who stopped polling', () => {
    let r = cup(2)
    const id = r.matches[0].id
    r = toBattle(r, id, T0)
    const m = r.matches[0]
    const v = toBattleMatchView(r, id, m.a!, T0 + 10_000, { [m.a!]: T0 + 10_000, [m.b!]: T0 + 2_000 })
    expect(v.opponentDisconnected).toBe(true)
    expect(v.opponentReconnectRemainingMs).toBe(27_000)
  })
})

describe('room view and nextStep', () => {
  it('3-player cup: bye shown, your match and minPlayers', () => {
    const r = cup(3)
    const playable = r.matches.find((m) => m.status === 'pending')!
    const v = toBattleRoomView(r, playable.a!, T0, 'https://t.me/x')
    const bye = v.rounds[0].matches.find((m) => m.endReason === 'bye')!
    expect(bye.b).toBeNull()
    expect(v.yourMatch?.id).toBe(playable.id)
    expect(v.minPlayers).toBe(2)
    expect(v.rounds.map((x) => x.name)).toEqual(['Semifinal', 'Final'])
  })

  it('nextStep: next_match, eliminated, champion', () => {
    let r = cup(3)
    const semi = r.matches.find((m) => m.status === 'pending')!
    r = toBattle(r, semi.id, T0)
    const play = (id: string, winner: Seat, t0: number) => {
      let k = 0
      let w = 0
      for (let t = t0; r.matches.find((x) => x.id === id)!.status === 'playing'; t += 1000) {
        const m = r.matches.find((x) => x.id === id)!
        const seat = m.turn!
        const cell = seat === winner ? SHIP_CELLS[k++] : WATER[w++]
        r = fire(r, id, m[seat]!, cell, m.shots[seat].length + 1, t, mulberry(1), null)
      }
    }
    play(semi.id, 'a', T0 + 1000)
    const s = r.matches.find((x) => x.id === semi.id)!
    expect(toBattleMatchView(r, semi.id, s.a!, T0 + 60_000, null).nextStep).toBe('next_match')
    expect(toBattleMatchView(r, semi.id, s.b!, T0 + 60_000, null).nextStep).toBe('eliminated')
    expect(toBattleMatchView(r, semi.id, s.a!, T0 + 60_000, null).nextMatchId).not.toBeNull()

    const final = r.matches.find((x) => x.round === 1)!
    r = toBattle(r, final.id, T0 + 70_000)
    play(final.id, 'a', T0 + 71_000)
    const f = r.matches.find((x) => x.id === final.id)!
    expect(r.status).toBe('finished')
    expect(toBattleMatchView(r, final.id, f.a!, T0 + 200_000, null).nextStep).toBe('champion')
    expect(toBattleRoomView(r, 'u9', T0, '').placements.first).toBe(r.players.find((p) => p.userId === f.a)!.name)
  })

  it('summary: live label and youAreIn', () => {
    const r = cup(4)
    const s = toBattleSummary(r, 'u1')
    expect(s.youAreIn).toBe(true)
    expect(s.liveLabel).toBe('Semifinal live')
    expect(s.playerCount).toBe(4)
  })
})
