import { describe, expect, it } from 'vitest'
import { RoomService } from '@/src/server/room-service'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'
import type { TelegramUser } from '@/src/server/telegram-auth'
import { TURN_MS } from '@/src/tournament/constants'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const tg = (i: number): TelegramUser => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })

function setup() {
  const clock = { t: T0 }
  const rooms = new MemoryRoomStore()
  const sent: string[][] = []
  const svc = new RoomService({
    rooms,
    presence: new MemoryPresenceStore(),
    now: () => clock.t,
    rng: mulberry(7),
    inviteUrl: () => '',
    notify: (channels) => sent.push(channels),
  })
  return { svc, clock, rooms, sent }
}

describe('RoomService free play', () => {
  it('alone vs a bot: lose a game, rematch once, the next game starts with the bot as X', async () => {
    const { svc, clock, rooms } = setup()
    const { code } = await svc.create(tg(1), 'Duel')
    expect((await svc.setFormat(code, tg(1), 'free')).mode).toBe('free')
    await svc.start(code, tg(1))
    const matchId = (await rooms.get(code))!.matches[0].id
    let v = await svc.getMatch(code, matchId, tg(1)) // ready → playing
    expect(v).toMatchObject({ mode: 'free', you: 'X', status: 'playing' })

    // let the turn run out while staying online (polls keep presence fresh)
    for (let t = 0; t < TURN_MS + 1000; t += 4000) {
      clock.t += 4000
      v = await svc.getMatch(code, matchId, tg(1))
    }
    expect(v.turn).toBeNull()
    expect(v.rematch).toMatchObject({ you: false, opponent: true }) // the bot already accepted
    expect(v.score).toEqual({ X: 0, O: 1 })

    clock.t += 1000
    v = await svc.acceptRematch(code, matchId, tg(1))
    expect(v).toMatchObject({ rematch: null, you: 'O', gameNo: 2, moves: [] })
  })

  it('two humans: a third is turned away; leaving ends the room for both', async () => {
    const { svc, clock, rooms, sent } = setup()
    const { code } = await svc.create(tg(1), 'Duel')
    await svc.join(code, tg(2))
    await svc.setFormat(code, tg(1), 'free')
    await expect(svc.join(code, tg(3))).rejects.toMatchObject({ code: 'full' })
    await svc.start(code, tg(1))
    const matchId = (await rooms.get(code))!.matches[0].id
    await svc.getMatch(code, matchId, tg(1))
    await svc.getMatch(code, matchId, tg(2))
    clock.t += 1000
    sent.length = 0
    const v = await svc.leaveMatch(code, matchId, tg(2))
    expect(v).toMatchObject({ status: 'finished', endReason: 'left' })
    expect((await rooms.get(code))!.status).toBe('finished')
    expect(sent.flat()).toContain(`caro:${code}`) // the room channel hears the room ended
    expect((await svc.me(tg(1))).active).toBeNull() // both are free to join other rooms
    expect((await svc.me(tg(2))).active).toBeNull()
  })
})
