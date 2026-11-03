import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as bot from '@/src/game/bot'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'
import { RoomService } from '@/src/server/room-service'
import type { TelegramUser } from '@/src/server/telegram-auth'
import type { Match, Room } from '@/src/tournament/types'
import { mulberry } from '../tournament/helpers'

// Count full-strength searches without changing what the bot plays.
vi.mock('@/src/game/bot', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/src/game/bot')>()
  return { ...real, chooseBotMove: vi.fn(real.chooseBotMove) }
})
const choose = vi.mocked(bot.chooseBotMove)
const fullSearches = () => choose.mock.calls.filter(([, , o]) => o.mode === 'full').length

const T0 = 1_800_000_000_000
const tg = (id: string): TelegramUser => ({ id, name: `User ${id}`, avatarUrl: null })

async function setup() {
  const clock = { t: T0 }
  const rooms = new MemoryRoomStore()
  const svc = new RoomService({
    rooms,
    presence: new MemoryPresenceStore(),
    now: () => clock.t,
    rng: mulberry(11),
    inviteUrl: () => '',
  })
  // 6 humans → 8-slot bracket with 2 bots → two human-vs-bot round-1 matches
  const view = await svc.create(tg('u1'), 'Cup')
  for (let i = 2; i <= 6; i++) await svc.join(view.code, tg(`u${i}`))
  await svc.start(view.code, tg('u1'))
  const code = view.code
  const load = async () => (await rooms.get(code)) as Room
  const room = await load()
  const isBot = (id: string | null) => room.players.find((p) => p.userId === id)!.isBot
  const hvb = room.matches.filter((m) => m.round === 0 && (isBot(m.a) || isBot(m.b)))
  expect(hvb).toHaveLength(2)
  return { svc, clock, code, load, hvb }
}

/** Human (X) opens the match and plays the first stone; the bot's answer is then due 0.5–1 s later. */
async function openAndMove(ctx: Awaited<ReturnType<typeof setup>>, m: Match, x: number) {
  const human = tg(m.X!)
  await ctx.svc.getMatch(ctx.code, m.id, human)
  await ctx.svc.move(ctx.code, m.id, human, { x, y: 15 }, 0)
}

const movesOf = async (ctx: Awaited<ReturnType<typeof setup>>, id: string) =>
  (await ctx.load()).matches.find((m) => m.id === id)!

describe('bot scope', () => {
  // braces: a function returned from beforeEach would be run as a teardown hook
  beforeEach(() => {
    choose.mockClear()
  })

  it('a single match request computes a due full bot move at most once', async () => {
    const ctx = await setup()
    const [a] = ctx.hvb
    await openAndMove(ctx, a, 15)
    ctx.clock.t += 1_500
    choose.mockClear()
    const v = await ctx.svc.getMatch(ctx.code, a.id, tg(a.X!))
    expect(v.moves).toHaveLength(2)
    expect(fullSearches()).toBe(1)
  })

  it("a match request applies only its own match's due bot move; the other waits for its own human", async () => {
    const ctx = await setup()
    const [a, b] = ctx.hvb
    await openAndMove(ctx, a, 10)
    await openAndMove(ctx, b, 20)
    ctx.clock.t += 1_500 // both bot moves are due
    choose.mockClear()

    const va = await ctx.svc.getMatch(ctx.code, a.id, tg(a.X!))
    expect(va.moves).toHaveLength(2)
    const mb = await movesOf(ctx, b.id)
    expect(mb.moves).toHaveLength(1)
    expect(mb.botMoveDueAt).not.toBeNull()
    expect(fullSearches()).toBe(1)

    const vb = await ctx.svc.getMatch(ctx.code, b.id, tg(b.X!))
    expect(vb.moves).toHaveLength(2)
    expect(vb.moves[1].side).toBe('O')
    expect(fullSearches()).toBe(2)
  })

  it('room-level requests leave a fresh bot move pending but settle one its human abandoned', async () => {
    const ctx = await setup()
    const [a] = ctx.hvb
    await openAndMove(ctx, a, 15)
    ctx.clock.t += 1_500
    choose.mockClear()
    await ctx.svc.getRoom(ctx.code, tg('u1'))
    expect((await movesOf(ctx, a.id)).moves).toHaveLength(1)
    expect(fullSearches()).toBe(0)

    // nobody polled the match for a long while: anyone's settle plays the bot move (no stall)
    ctx.clock.t += 10_000
    await ctx.svc.getRoom(ctx.code, tg('u1'))
    const m = await movesOf(ctx, a.id)
    expect(m.moves).toHaveLength(2)
    expect(m.moves[1].at).toBeLessThan(ctx.clock.t - 10_000)
    expect(fullSearches()).toBe(1)
  })
})
