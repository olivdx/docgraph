import { describe, expect, it } from 'vitest'
import { RoomService } from '@/src/server/room-service'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'
import { MemorySudokuStore } from '@/src/server/sudoku-store'
import { SudokuService } from '@/src/server/sudoku-service'
import type { TelegramUser } from '@/src/server/telegram-auth'
import type { MoveSignal } from '@/src/realtime/channels'
import { TURN_MS } from '@/src/tournament/constants'
import type { Room } from '@/src/tournament/types'
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
    await svc.setFormat(code, tg(1), 'bo3')
    expect(sent.pop()).toEqual({ channels: [`caro:${code}`], version: 2 })
    expect((await svc.getRoom(code, tg(2))).bestOf).toBe(3)
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

  describe('caro move signal (sent before the write)', () => {
    /** Records the order of move signals and room writes in one shared log. */
    async function playingMatch(humans: number) {
      const log: string[] = []
      const moves: { channel: string; signal: MoveSignal }[] = []
      class LoggingStore extends MemoryRoomStore {
        override async replace(room: Room, expectedVersion: number): Promise<boolean> {
          log.push('write')
          return super.replace(room, expectedVersion)
        }
      }
      const clock = { t: T0 }
      const rooms = new LoggingStore()
      const svc = new RoomService({
        rooms,
        presence: new MemoryPresenceStore(),
        now: () => clock.t,
        rng: mulberry(7),
        inviteUrl: () => '',
        notifyMove: (channel, signal) => {
          log.push('move')
          moves.push({ channel, signal })
        },
      })
      const { code } = await svc.create(tg(1), 'Cup')
      for (let i = 2; i <= humans; i++) await svc.join(code, tg(i))
      await svc.start(code, tg(1))
      const room = (await rooms.get(code))!
      const isBot = (id: string | null) => room.players.find((p) => p.userId === id)?.isBot ?? false
      const m = room.matches.find((x) => x.round === 0 && (humans === 2 || isBot(x.X) || isBot(x.O)))!
      const user = (id: string | null) => tg(Number(id!.slice(1)))
      for (const id of [m.X, m.O]) if (!isBot(id)) await svc.getMatch(code, m.id, user(id))
      log.length = 0
      return { svc, clock, code, m, X: user(m.X), O: isBot(m.O) ? null : user(m.O), log, moves }
    }

    it('publishes the move with the next turn clock, before the room is written', async () => {
      const { svc, clock, code, m, X, log, moves } = await playingMatch(2)
      clock.t += 1000
      await svc.move(code, m.id, X, { x: 3, y: -2 }, 0)
      expect(log).toEqual(['move', 'write'])
      expect(moves).toEqual([
        {
          channel: `caro:${code}:${m.id}`,
          signal: { matchId: m.id, game: 1, from: 0, moves: [{ x: 3, y: -2, side: 'X', at: clock.t }], turnRemainingMs: TURN_MS },
        },
      ])
    })

    it('sends nothing for a retried move or a rejected one', async () => {
      const { svc, clock, code, m, X, O, moves } = await playingMatch(2)
      clock.t += 1000
      await svc.move(code, m.id, X, { x: 0, y: 0 }, 0)
      moves.length = 0
      await svc.move(code, m.id, X, { x: 0, y: 0 }, 0) // double tap: already recorded
      await expect(svc.move(code, m.id, O!, { x: 0, y: 0 }, 1)).rejects.toMatchObject({ code: 'occupied' })
      expect(moves).toEqual([])
    })

    it('sends nothing in a match against a bot', async () => {
      const { svc, clock, code, m, X, moves } = await playingMatch(3)
      clock.t += 1000
      await svc.move(code, m.id, X, { x: 0, y: 0 }, 0)
      expect(moves).toEqual([])
    })
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
