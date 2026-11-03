import { describe, expect, it } from 'vitest'
import { MemorySudokuStore } from '@/src/server/sudoku-store'
import { SudokuService } from '@/src/server/sudoku-service'
import type { TelegramUser } from '@/src/server/telegram-auth'
import { GAME_MS } from '@/src/sudoku/constants'
import { RoomError } from '@/src/tournament/types'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const tg = (i: number): TelegramUser => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })

function setup(caroActive: string | null = null) {
  const clock = { t: T0 }
  const rooms = new MemorySudokuStore()
  const svc = new SudokuService({
    rooms,
    now: () => clock.t,
    rng: mulberry(9),
    inviteUrl: (c) => `https://t.me/b/a?startapp=${c}`,
    activeElsewhere: async () => caroActive,
  })
  return { svc, clock, rooms }
}

async function err(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (e instanceof RoomError) return e
    throw e
  }
  throw new Error('expected RoomError')
}

describe('SudokuService', () => {
  it('5-char codes; one active room at a time, across both games', async () => {
    const { svc } = setup()
    const v = await svc.create(tg(1), undefined, 'easy')
    expect(v.code).toHaveLength(5)
    expect(v.difficulty).toBe('easy')
    expect((await err(svc.create(tg(1)))).extra).toEqual({ activeCode: v.code })
    expect(await svc.activeCode('u1')).toBe(v.code)

    const blocked = setup('CAROXX').svc
    expect((await err(blocked.create(tg(1)))).code).toBe('already_active')
  })

  it('full race: reload-safe state, time-out ends the room, player freed afterwards', async () => {
    const { svc, clock } = setup()
    const { code } = await svc.create(tg(1))
    await svc.join(code, tg(2))
    const s = await svc.start(code, tg(1))
    expect(s.status).toBe('playing')
    const cell = [...s.you!.grid].findIndex((c) => c === '0')
    const after = await svc.enter(code, tg(2), cell, 1, 1)
    const again = await svc.get(code, tg(2))
    expect(again.you).toEqual(after.you)
    expect(again.solution).toBeNull()

    clock.t = T0 + GAME_MS + 1
    const done = await svc.get(code, tg(1))
    expect(done.status).toBe('finished')
    expect(done.ranking).toHaveLength(2)
    expect(await svc.activeCode('u1')).toBeNull()
    expect((await svc.list(tg(3))).map((r) => r.code)).not.toContain(code)
  })

  it('a move after the clock ran out is refused, and the time-out is still saved', async () => {
    const { svc, clock, rooms } = setup()
    const { code } = await svc.create(tg(1))
    await svc.join(code, tg(2))
    await svc.start(code, tg(1))
    await svc.giveUp(code, tg(2))
    clock.t = T0 + GAME_MS + 5
    expect((await err(svc.enter(code, tg(1), 0, 1, 1))).code).toBe('not_playing')
    expect((await rooms.get(code))!.status).toBe('finished')
  })
})
