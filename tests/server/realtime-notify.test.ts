import { describe, expect, it } from 'vitest'
import { RoomService } from '@/src/server/room-service'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'
import { MemorySudokuStore } from '@/src/server/sudoku-store'
import { SudokuService } from '@/src/server/sudoku-service'
import type { TelegramUser } from '@/src/server/telegram-auth'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const tg = (i: number): TelegramUser => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })

function caro() {
  const clock = { t: T0 }
  const rooms = new MemoryRoomStore()
  const sent: { channels: string[]; version: number }[] = []
  const svc = new RoomService({
    rooms,
    presence: new MemoryPresenceStore(),
    now: () => clock.t,
    rng: mulberry(7),
    inviteUrl: () => '',
    notify: (channels, version) => sent.push({ channels, version }),
  })
  return { svc, clock, rooms, sent }
}

describe('realtime notifications', () => {
  it('caro: lobby changes hit the room channel; a move hits only its match channel', async () => {
    const { svc, clock, rooms, sent } = caro()
    const { code } = await svc.create(tg(1), 'Cup')
    expect(sent).toEqual([]) // insert, not an update: nobody can be subscribed yet
    await svc.join(code, tg(2))
    expect(sent.pop()).toEqual({ channels: [`caro:${code}`], version: 1 })
    await svc.start(code, tg(1))
    const m = (await rooms.get(code))!.matches[0]
    expect(sent.pop()!.channels).toEqual([`caro:${code}`, `caro:${code}:${m.id}`])

    const X = tg(Number(m.X!.slice(1)))
    const O = tg(Number(m.O!.slice(1)))
    await svc.getMatch(code, m.id, X)
    await svc.getMatch(code, m.id, O) // both ready → playing (bracket shows it live)
    sent.length = 0
    clock.t += 1000
    await svc.move(code, m.id, X, { x: 0, y: 0 }, 0)
    expect(sent).toEqual([{ channels: [`caro:${code}:${m.id}`], version: (await rooms.get(code))!.version }])

    // a read that changes nothing publishes nothing
    sent.length = 0
    await svc.getRoom(code, tg(1))
    expect(sent).toEqual([])
  })

  it('sudoku: every write publishes on the room channel, reads do not', async () => {
    const sent: string[][] = []
    const svc = new SudokuService({
      rooms: new MemorySudokuStore(),
      now: () => T0,
      rng: mulberry(1),
      inviteUrl: () => '',
      notify: (channels) => sent.push(channels),
    })
    const { code } = await svc.create(tg(1))
    await svc.join(code, tg(2))
    await svc.get(code, tg(2))
    await svc.start(code, tg(1))
    expect(sent).toEqual([[`sudoku:${code}`], [`sudoku:${code}`]])
  })
})
