import { describe, expect, it } from 'vitest'
import type { BattleMatchView } from '@/src/battleship/views'
import { battleshipMatchChannel, battleshipRoomChannel } from '@/src/realtime/channels'
import { BattleshipService } from '@/src/server/battleship-service'
import { MemoryBattleStore } from '@/src/server/battleship-store'
import { MemoryPresenceStore } from '@/src/server/stores'
import type { TelegramUser } from '@/src/server/telegram-auth'
import { RoomError } from '@/src/tournament/types'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const tg = (i: number): TelegramUser => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })
import { FLEET_A as FLEET, SHIP_CELLS, WATER } from '../battleship/helpers'

function setup(elsewhere: string | null = null) {
  const clock = { t: T0 }
  const notes: { channels: string[]; version: number }[] = []
  const svc = new BattleshipService({
    rooms: new MemoryBattleStore(),
    presence: new MemoryPresenceStore(),
    now: () => clock.t,
    rng: mulberry(4),
    inviteUrl: (c) => `https://t.me/b/a?startapp=${c}`,
    activeElsewhere: async () => elsewhere,
    notify: (channels, version) => notes.push({ channels, version }),
  })
  return { svc, clock, notes }
}

async function err(p: Promise<unknown>): Promise<RoomError> {
  try {
    await p
  } catch (e) {
    if (e instanceof RoomError) return e
    throw e
  }
  throw new Error('expected RoomError')
}

/** Creates a 2-player cup, starts it and opens the match for both. Returns code and match id. */
async function twoPlayerMatch(s: ReturnType<typeof setup>) {
  const { code } = await s.svc.create(tg(1))
  await s.svc.join(code, tg(2))
  const room = await s.svc.start(code, tg(1))
  const id = room.yourMatch!.id
  await s.svc.getMatch(code, id, tg(1))
  await s.svc.getMatch(code, id, tg(2))
  return { code, id }
}

describe('BattleshipService', () => {
  it('4-char codes and invite url', async () => {
    const { svc } = setup()
    const v = await svc.create(tg(1), 'Sea Dogs')
    expect(v.code).toHaveLength(4)
    expect(v.name).toBe('Sea Dogs')
    expect(v.inviteUrl).toBe(`https://t.me/b/a?startapp=${v.code}`)
  })

  it('one active room across three games', async () => {
    const blocked = setup('CAROXX').svc
    const e1 = await err(blocked.create(tg(1)))
    expect(e1.code).toBe('already_active')
    expect(e1.extra).toEqual({ activeCode: 'CAROXX' })

    const s = setup()
    const { code } = await s.svc.create(tg(1))
    expect((await err(s.svc.create(tg(1)))).extra).toEqual({ activeCode: code })
    expect(await s.svc.activeCode('u1')).toBe(code)
    const other = await s.svc.create(tg(3))
    expect((await err(s.svc.join(other.code, tg(1)))).code).toBe('already_active')
  })

  it('full 2-player cup through the service', async () => {
    const s = setup()
    const { code, id } = await twoPlayerMatch(s)
    expect((await s.svc.me(tg(1)))?.matchId).toBe(id)
    const seat1 = (await s.svc.saveFleet(code, id, tg(1), FLEET, true)).you
    let v: BattleMatchView = await s.svc.saveFleet(code, id, tg(2), FLEET, true)
    expect(v.status).toBe('playing')
    const winner = v.turn!
    const used = { a: 0, b: 0 }
    for (let i = 0; i < 200 && v.status === 'playing'; i++) {
      s.clock.t += 1000
      const seat = v.turn!
      const user = seat === seat1 ? tg(1) : tg(2)
      const cell = seat === winner ? SHIP_CELLS[used[seat]++] : WATER[used[seat]++]
      v = await s.svc.fire(code, id, user, cell, v.shots[seat].length + 1)
    }
    expect(v.status).toBe('finished')
    expect(v.endReason).toBe('fleet_sunk')
    const room = await s.svc.getRoom(code, tg(1))
    expect(room.status).toBe('finished')
    expect(room.placements.first).toBe(v.players[winner]!.name)
    expect(await s.svc.activeCode('u1')).toBeNull()
  })

  it('reload mid-placement returns the saved ships', async () => {
    const s = setup()
    const { code, id } = await twoPlayerMatch(s)
    s.clock.t += 2000
    await s.svc.saveFleet(code, id, tg(1), [FLEET[0]], false)
    s.clock.t += 1000
    const v = await s.svc.getMatch(code, id, tg(1))
    expect(v.fleets[v.you!]).toEqual([FLEET[0]])
    expect(v.placingRemainingMs).toBeLessThanOrEqual(45_000)
    expect(v.placingRemainingMs).toBeGreaterThan(0)
  })

  it('opponent view never contains the other fleet before a sink', async () => {
    const s = setup()
    const { code, id } = await twoPlayerMatch(s)
    await s.svc.saveFleet(code, id, tg(1), FLEET, true)
    await s.svc.saveFleet(code, id, tg(2), FLEET, true)
    const v = await s.svc.getMatch(code, id, tg(1))
    const opp = v.you === 'a' ? 'b' : 'a'
    expect(v.fleets[opp]).toEqual([])
    expect(v.fleets[v.you!]).toHaveLength(6)
  })

  it('notify: a shot rings the match channel only; finishing rings the room too', async () => {
    const s = setup()
    const { code, id } = await twoPlayerMatch(s)
    await s.svc.saveFleet(code, id, tg(1), FLEET, true)
    let v = await s.svc.saveFleet(code, id, tg(2), FLEET, true)
    const shooterUser = v.turn === v.you ? tg(2) : tg(1)
    s.notes.length = 0
    s.clock.t += 1000
    v = await s.svc.fire(code, id, shooterUser, WATER[0], 1)
    expect(s.notes).toHaveLength(1)
    expect(s.notes[0].channels).toEqual([battleshipMatchChannel(code, id)])

    s.notes.length = 0
    s.clock.t += 1000
    await s.svc.resign(code, id, tg(1))
    expect(s.notes[0].channels).toContain(battleshipRoomChannel(code))
    expect(s.notes[0].channels).toContain(battleshipMatchChannel(code, id))
  })

  it('parallel FIRE requests record exactly one shot', async () => {
    const s = setup()
    const { code, id } = await twoPlayerMatch(s)
    const seat1 = (await s.svc.saveFleet(code, id, tg(1), FLEET, true)).you
    const v = await s.svc.saveFleet(code, id, tg(2), FLEET, true)
    const shooter = v.turn === seat1 ? tg(1) : tg(2)
    s.clock.t += 1000
    // Same seq twice (double tap) and a different cell with the same seq (two quick taps).
    await Promise.all([
      s.svc.fire(code, id, shooter, WATER[0], 1),
      s.svc.fire(code, id, shooter, WATER[0], 1),
      s.svc.fire(code, id, shooter, WATER[1], 1),
    ])
    const after = await s.svc.getMatch(code, id, shooter)
    expect(after.shots[v.turn!]).toHaveLength(1)
    expect(after.turn).not.toBe(v.turn)
  })

  it('creating a cup with leaveCurrent leaves the old cup (lobby: host handed over)', async () => {
    const s = setup()
    const old = await s.svc.create(tg(1))
    await s.svc.join(old.code, tg(2))
    expect((await err(s.svc.create(tg(1)))).extra).toEqual({ activeCode: old.code })
    const fresh = await s.svc.create(tg(1), undefined, { leaveCurrent: true })
    expect(fresh.code).not.toBe(old.code)
    expect(await s.svc.activeCode('u1')).toBe(fresh.code)
    const oldView = await s.svc.getRoom(old.code, tg(2))
    expect(oldView.status).toBe('lobby')
    expect(oldView.isHost).toBe(true)
    expect(oldView.players.map((p) => p.name)).toEqual(['User 2'])
  })

  it('joining another cup with leaveCurrent forfeits the live match in the old one', async () => {
    const s = setup()
    const { code, id } = await twoPlayerMatch(s)
    const other = await s.svc.create(tg(3))
    expect((await err(s.svc.join(other.code, tg(1)))).code).toBe('already_active')
    await s.svc.join(other.code, tg(1), { leaveCurrent: true })
    const v = await s.svc.getMatch(code, id, tg(2))
    expect(v.status).toBe('finished')
    expect(v.endReason).toBe('left')
    expect(v.winner).toBe(v.you)
    expect(await s.svc.activeCode('u1')).toBe(other.code)
  })

  it('leaveCurrent never leaves a Caro or Sudoku room', async () => {
    const blocked = setup('CAROXX').svc
    expect((await err(blocked.create(tg(1), undefined, { leaveCurrent: true }))).extra).toEqual({ activeCode: 'CAROXX' })
  })

  it('leave from a running cup is reported to the room view', async () => {
    const s = setup()
    const { code } = await twoPlayerMatch(s)
    const v = await s.svc.leave(code, tg(1))
    expect(v.youAreIn).toBe(false)
    expect(v.status).toBe('finished')
  })

  it('list shows open cups', async () => {
    const s = setup()
    const { code } = await s.svc.create(tg(1))
    const list = await s.svc.list(tg(2))
    expect(list.map((x) => x.code)).toEqual([code])
    expect(list[0].youAreIn).toBe(false)
  })
})
