import { describe, expect, it, vi } from 'vitest'
import { MemoryGauntletBookStore } from '@/src/server/gauntlet-book-store'
import { createGauntletLearning } from '@/src/server/gauntlet-learning'
import { RoomService } from '@/src/server/room-service'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const tg = (i: number) => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })

describe('RoomService gauntlet wiring', () => {
  it('calls hintsFor on match-scoped requests and afterWrite on successful writes', async () => {
    const store = new MemoryGauntletBookStore()
    const base = createGauntletLearning(store, () => {})
    let hintsForCalls = 0
    const learning = {
      hintsFor: async (...args: Parameters<typeof base.hintsFor>) => {
        hintsForCalls++
        return base.hintsFor(...args)
      },
      learnFromWrite: base.learnFromWrite,
    }
    let afterWriteCalls = 0
    const clock = { t: T0 }
    const rooms = new MemoryRoomStore()
    const svc = new RoomService({
      rooms,
      presence: new MemoryPresenceStore(),
      now: () => clock.t,
      rng: mulberry(42),
      inviteUrl: () => '',
      learning,
      afterWrite: () => {
        afterWriteCalls++
      },
    })

    const created = await svc.create(tg(1), 'Learn')
    await svc.setFormat(created.code, tg(1), 'free')
    expect(afterWriteCalls).toBeGreaterThan(0)
    const nAfterFormat = afterWriteCalls

    await svc.setBotLevel(created.code, tg(1), 'gauntlet')
    expect(afterWriteCalls).toBeGreaterThan(nAfterFormat)

    await svc.start(created.code, tg(1))
    const matchId = (await rooms.get(created.code))!.matches[0].id
    hintsForCalls = 0
    await svc.getMatch(created.code, matchId, tg(1))
    expect(hintsForCalls).toBeGreaterThanOrEqual(1)
  })

  it('schedules learnFromWrite via afterWrite when provided', async () => {
    const store = new MemoryGauntletBookStore()
    const learning = createGauntletLearning(store, () => {})
    const learnSpy = vi.spyOn(learning, 'learnFromWrite')
    const clock = { t: T0 }
    const queued: (() => void)[] = []
    const svc = new RoomService({
      rooms: new MemoryRoomStore(),
      presence: new MemoryPresenceStore(),
      now: () => clock.t,
      rng: mulberry(7),
      inviteUrl: () => '',
      learning,
      afterWrite: (before, after_, now) => {
        queued.push(() => learning.learnFromWrite(before, after_, now))
      },
    })

    const { code } = await svc.create(tg(1), 'Q')
    await svc.setFormat(code, tg(1), 'free') // `create` uses insert only; match commands hit mutate + afterWrite
    expect(queued.length).toBeGreaterThan(0)
    queued.forEach((fn) => fn())
    // No gauntlet game finished — learning should still run without throwing.
    expect(learnSpy).toHaveBeenCalled()
  })
})
