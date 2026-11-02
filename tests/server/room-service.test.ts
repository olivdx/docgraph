import { describe, expect, it } from 'vitest'
import { MemoryPresenceStore, MemoryRoomStore, type RoomStore } from '@/src/server/stores'
import { RoomService } from '@/src/server/room-service'
import type { TelegramUser } from '@/src/server/telegram-auth'
import { RoomError, type Room } from '@/src/tournament/types'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const tg = (i: number): TelegramUser => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })

function setup(rooms: RoomStore = new MemoryRoomStore(), seed = 7) {
  const clock = { t: T0 }
  const presence = new MemoryPresenceStore()
  const svc = new RoomService({
    rooms,
    presence,
    now: () => clock.t,
    rng: mulberry(seed),
    inviteUrl: (code) => `https://t.me/bot/app?startapp=${code}`,
  })
  return { svc, clock, rooms, presence }
}

class CountingStore extends MemoryRoomStore {
  replaces = 0
  override async replace(room: Room, expectedVersion: number): Promise<boolean> {
    this.replaces++
    return super.replace(room, expectedVersion)
  }
}

async function errCode(p: Promise<unknown>): Promise<RoomError> {
  try {
    await p
  } catch (e) {
    if (e instanceof RoomError) return e
    throw e
  }
  throw new Error('expected RoomError')
}

/** Creates a room hosted by tg(1) with humans 1..n and starts it. */
async function startedRoom(ctx: ReturnType<typeof setup>, n: number): Promise<string> {
  const { svc } = ctx
  const view = await svc.create(tg(1), 'Cup')
  for (let i = 2; i <= n; i++) await svc.join(view.code, tg(i))
  await svc.start(view.code, tg(1))
  return view.code
}

async function loadRoom(ctx: ReturnType<typeof setup>, code: string): Promise<Room> {
  const r = await ctx.rooms.get(code)
  if (!r) throw new Error('room missing')
  return r
}

/** Human X plays a horizontal five at y=10, human O plays at y=20. X wins. */
async function playHumanWin(ctx: ReturnType<typeof setup>, code: string, matchId: string) {
  const { svc, clock } = ctx
  const m = (await loadRoom(ctx, code)).matches.find((x) => x.id === matchId)!
  const X = tg(Number(m.X!.slice(1)))
  const O = tg(Number(m.O!.slice(1)))
  for (let i = 0; i < 5; i++) {
    clock.t += 1000
    let v = await svc.move(code, matchId, X, { x: 10 + i, y: 10 }, 2 * i)
    if (i === 4) {
      expect(v.status).toBe('finished')
      expect(v.winner).toBe('X')
      expect(v.endReason).toBe('five_in_row')
      break
    }
    clock.t += 1000
    v = await svc.move(code, matchId, O, { x: 10 + i, y: 20 }, 2 * i + 1)
    expect(v.moves.length).toBe(2 * i + 2)
  }
}

describe('RoomService', () => {
  it('full tournament 3 humans + 1 bot reaches finished with placements', async () => {
    const ctx = setup()
    const { svc, clock } = ctx
    const code = await startedRoom(ctx, 3)

    for (let guard = 0; guard < 20; guard++) {
      const room = await loadRoom(ctx, code)
      if (room.status === 'finished') break
      const open = room.matches.filter((m) => m.status === 'pending' || m.status === 'playing')
      expect(open.length).toBeGreaterThan(0)
      for (const m of open) {
        const ids = [m.a!, m.b!].filter((id) => !room.players.find((p) => p.userId === id)!.isBot)
        // every human opens the match (marks ready)
        for (const id of ids) await svc.getMatch(code, m.id, tg(Number(id.slice(1))))
        if (ids.length === 2) {
          await playHumanWin(ctx, code, m.id)
        } else {
          // human (X) vs bot: play one move, let the clock run so the bot answers, then resign
          const human = tg(Number(ids[0].slice(1)))
          clock.t += 500
          let v = await svc.move(code, m.id, human, { x: 15, y: 15 }, 0)
          expect(v.you).toBe('X')
          clock.t += 1500
          v = await svc.getMatch(code, m.id, human)
          expect(v.moves.length).toBe(2)
          expect(v.moves[1].side).toBe('O')
          v = await svc.resign(code, m.id, human)
          expect(v.status).toBe('finished')
          expect(v.endReason).toBe('resign')
        }
      }
    }

    const room = await loadRoom(ctx, code)
    expect(room.status).toBe('finished')
    const { first, second, third } = room.placements
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(third).not.toBeNull()
    expect(new Set([first, second, third]).size).toBe(3)
    expect(room.expiresAt).toBeInstanceOf(Date)
    expect(room.matches.every((m) => m.status === 'finished')).toBe(true)
    const view = await svc.getRoom(code, tg(1))
    expect(view.status).toBe('finished')
    expect(view.placements.first).not.toBeNull()
  })

  it('reload mid-match returns identical MatchView (moves, turn, remaining)', async () => {
    const ctx = setup()
    const { svc, clock } = ctx
    const code = await startedRoom(ctx, 2)
    const m = (await loadRoom(ctx, code)).matches[0]
    const X = tg(Number(m.X!.slice(1)))
    const O = tg(Number(m.O!.slice(1)))
    await svc.getMatch(code, m.id, X)
    await svc.getMatch(code, m.id, O)
    clock.t += 1000
    await svc.move(code, m.id, X, { x: 5, y: 5 }, 0)
    clock.t += 1000
    await svc.move(code, m.id, O, { x: 6, y: 6 }, 1)
    clock.t += 3000

    const before = await svc.getMatch(code, m.id, X)
    const again = await svc.getMatch(code, m.id, X) // reload at the same instant
    expect(again).toEqual(before)
    expect(before.moves.length).toBe(2)
    expect(before.turn).toBe('X')
    expect(before.turnRemainingMs).toBe(22_000)

    // gone ~20 s during the opponent's turn: still in the game, board unchanged
    clock.t += 1000
    await svc.move(code, m.id, X, { x: 7, y: 7 }, 2)
    clock.t += 20_000
    await svc.getMatch(code, m.id, O)
    const back = await svc.getMatch(code, m.id, X)
    expect(back.status).toBe('playing')
    expect(back.moves.length).toBe(3)
    expect(back.turn).toBe('O')
    expect(back.turnRemainingMs).toBe(5_000)
  })

  it('concurrent settles produce one result', async () => {
    // replace() waits until both callers reached it, so both read the same version first
    class GatedStore extends MemoryRoomStore {
      gate: { waiting: (() => void)[]; enabled: boolean } = { waiting: [], enabled: false }
      okReplaces = 0
      failedReplaces = 0
      override async replace(room: Room, expectedVersion: number): Promise<boolean> {
        if (this.gate.enabled) {
          await new Promise<void>((resolve) => {
            this.gate.waiting.push(resolve)
            if (this.gate.waiting.length >= 2) {
              this.gate.enabled = false
              this.gate.waiting.splice(0).forEach((f) => f())
            }
            setTimeout(resolve, 200)
          })
        }
        const ok = await super.replace(room, expectedVersion)
        if (ok) this.okReplaces++
        else this.failedReplaces++
        return ok
      }
    }
    const store = new GatedStore()
    const ctx = setup(store)
    const { svc, clock } = ctx
    const code = await startedRoom(ctx, 4) // 4 humans: two semifinals, final, 3rd place
    let room = await loadRoom(ctx, code)
    const semi = room.matches.find((m) => m.round === 0 && m.slot === 0)!
    for (const id of [semi.X!, semi.O!]) await svc.getMatch(code, semi.id, tg(Number(id.slice(1))))
    clock.t += 1000
    await svc.move(code, semi.id, tg(Number(semi.X!.slice(1))), { x: 3, y: 3 }, 0)
    room = await loadRoom(ctx, code)
    const v0 = room.version
    const finalBefore = room.matches.find((m) => m.kind === 'normal' && m.round === 1)!
    expect(finalBefore.a).toBeNull()

    // O never moves: its turn deadline expires. Both pollers settle it at once.
    clock.t += 26_000
    store.okReplaces = 0
    store.failedReplaces = 0
    store.gate.enabled = true
    const [a, b] = await Promise.all([svc.getRoom(code, tg(1)), svc.getRoom(code, tg(2))])

    room = await loadRoom(ctx, code)
    expect(store.okReplaces).toBe(1)
    expect(store.failedReplaces).toBe(1)
    expect(room.version).toBe(v0 + 1)
    const s = room.matches.find((m) => m.id === semi.id)!
    expect(s.status).toBe('finished')
    expect(s.endReason).toBe('turn_timeout')
    expect(s.winner).toBe('X')
    const final = room.matches.find((m) => m.kind === 'normal' && m.round === 1)!
    expect(final.a).toBe(semi.X)
    expect(final.b).toBeNull()
    const third = room.matches.find((m) => m.kind === 'third_place')!
    expect(third.a).toBe(semi.O)
    expect(third.b).toBeNull()
    expect(a.rounds).toEqual(b.rounds)
  })

  it('join while active elsewhere is rejected with activeCode', async () => {
    const ctx = setup()
    const { svc } = ctx
    const a = await svc.create(tg(1), 'A')
    const b = await svc.create(tg(2), 'B')
    const err = await errCode(svc.join(b.code, tg(1)))
    expect(err.code).toBe('already_active')
    expect(err.extra).toEqual({ activeCode: a.code })
    const roomB = await loadRoom(ctx, b.code)
    expect(roomB.players.map((p) => p.userId)).toEqual(['u2'])
    // creating another room is rejected the same way
    const err2 = await errCode(svc.create(tg(1), 'C'))
    expect(err2.code).toBe('already_active')
    expect(err2.extra).toEqual({ activeCode: a.code })
    // re-joining your own room is fine
    const again = await svc.join(a.code, tg(1))
    expect(again.code).toBe(a.code)
  })

  it('eliminated player can join another room', async () => {
    const ctx = setup()
    const { svc } = ctx
    const code = await startedRoom(ctx, 5) // 8-slot bracket: round-1 losers are out
    const room = await loadRoom(ctx, code)
    const hvh = room.matches.find(
      (m) => m.round === 0 && [m.a, m.b].every((id) => !room.players.find((p) => p.userId === id)!.isBot),
    )!
    for (const id of [hvh.X!, hvh.O!]) await svc.getMatch(code, hvh.id, tg(Number(id.slice(1))))
    const loser = tg(Number(hvh.O!.slice(1)))
    await svc.resign(code, hvh.id, loser)

    const other = await svc.create(tg(9), 'Other')
    const joined = await svc.join(other.code, loser)
    expect(joined.players.map((p) => p.name)).toContain(loser.name)

    // the winner is still active in the first room
    const winner = tg(Number(hvh.X!.slice(1)))
    const err = await errCode(svc.join(other.code, winner))
    expect(err.code).toBe('already_active')
    expect(err.extra).toEqual({ activeCode: code })
  })

  it('getRoom with nothing to settle does not write', async () => {
    const store = new CountingStore()
    const ctx = setup(store)
    const { svc, clock } = ctx
    const lobby = await svc.create(tg(5), 'Lobby')
    store.replaces = 0
    await svc.getRoom(lobby.code, tg(5))
    await svc.getRoom(lobby.code, tg(6))
    expect(store.replaces).toBe(0)

    const code = await startedRoom(ctx, 2)
    store.replaces = 0
    clock.t += 1000
    await svc.getRoom(code, tg(1))
    await svc.getRoom(code, tg(3))
    expect(store.replaces).toBe(0)
    // a spectator looking at a match does not write either
    const m = (await loadRoom(ctx, code)).matches[0]
    const spectated = await svc.getMatch(code, m.id, tg(3))
    expect(spectated.you).toBeNull()
    expect(store.replaces).toBe(0)
    expect(await ctx.presence.get(code, ['u3'])).toEqual({})
  })

  it('me routes to pending match after start', async () => {
    const ctx = setup()
    const { svc } = ctx
    expect((await svc.me(tg(1))).active).toBeNull()
    const lobby = await svc.create(tg(1), 'Cup')
    expect((await svc.me(tg(1))).active).toEqual({ code: lobby.code, matchId: null })
    await svc.join(lobby.code, tg(2))
    await svc.start(lobby.code, tg(1))
    const room = await loadRoom(ctx, lobby.code)
    const m = room.matches[0]
    expect(m.status).toBe('pending')
    const me1 = await svc.me(tg(1))
    expect(me1.user).toEqual(tg(1))
    expect(me1.active).toEqual({ code: lobby.code, matchId: m.id })
    expect((await svc.me(tg(2))).active).toEqual({ code: lobby.code, matchId: m.id })
  })

  it('running room writes refresh expiresAt; unknown room is not_found', async () => {
    const ctx = setup()
    const { svc, clock } = ctx
    const code = await startedRoom(ctx, 2)
    const m = (await loadRoom(ctx, code)).matches[0]
    clock.t += 30_000
    await svc.getMatch(code, m.id, tg(1))
    const r = await loadRoom(ctx, code)
    expect(r.status).toBe('running')
    expect(r.expiresAt.getTime()).toBe(clock.t + 2 * 60 * 60 * 1000)
    expect((await errCode(svc.getRoom('ZZZZZZ', tg(1)))).code).toBe('not_found')
  })

  it('list returns open-room summaries', async () => {
    const ctx = setup()
    const { svc, clock } = ctx
    const a = await svc.create(tg(1), 'A')
    clock.t += 10
    const b = await svc.create(tg(2), 'B')
    clock.t += 10
    const c = await svc.create(tg(3), 'C')
    await svc.cancel(c.code, tg(3))
    const list = await svc.list(tg(1))
    expect(list.map((s) => s.code)).toEqual([b.code, a.code])
    expect(list[1].youAreIn).toBe(true)
  })
})
