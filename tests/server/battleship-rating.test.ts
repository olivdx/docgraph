import { describe, expect, it } from 'vitest'
import type { RatingEvent } from '@/src/battleship/rating'
import type { BattleMatchView } from '@/src/battleship/views'
import { BattleshipRatingService } from '@/src/server/battleship-rating'
import { MemoryRatingStore } from '@/src/server/battleship-rating-store'
import { BattleshipService } from '@/src/server/battleship-service'
import { MemoryBattleStore } from '@/src/server/battleship-store'
import { MemoryPresenceStore } from '@/src/server/stores'
import type { TelegramUser } from '@/src/server/telegram-auth'
import { FLEET_A as FLEET, SHIP_CELLS, WATER } from '../battleship/helpers'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const tg = (i: number): TelegramUser => ({ id: `u${i}`, name: `User ${i}`, avatarUrl: null })
const idx = (u: TelegramUser) => Number(u.id.slice(1))

function setup() {
  const clock = { t: T0 }
  const ratings = new BattleshipRatingService({ store: new MemoryRatingStore() })
  // rating writes run one after another, in the order the room writes happened
  let chain: Promise<void> = Promise.resolve()
  const svc = new BattleshipService({
    rooms: new MemoryBattleStore(),
    presence: new MemoryPresenceStore(),
    now: () => clock.t,
    rng: mulberry(4),
    inviteUrl: () => '',
    afterWrite: (before, after) => {
      chain = chain.then(() => ratings.recordWrite(before, after))
    },
  })
  return { svc, clock, ratings, settled: () => chain }
}
type S = ReturnType<typeof setup>

async function startCup(s: S, users: TelegramUser[]): Promise<string> {
  const { code } = await s.svc.create(users[0])
  for (const u of users.slice(1)) await s.svc.join(code, u)
  await s.svc.start(code, users[0])
  return code
}

/** Both open the match, lock fleets, and `winner` sinks everything while the other only hits water. */
async function playMatch(s: S, code: string, id: string, p: TelegramUser, q: TelegramUser, winner: TelegramUser) {
  await s.svc.getMatch(code, id, p)
  await s.svc.getMatch(code, id, q)
  const seatP = (await s.svc.saveFleet(code, id, p, FLEET, true)).you!
  let v: BattleMatchView = await s.svc.saveFleet(code, id, q, FLEET, true)
  const used = { a: 0, b: 0 }
  for (let i = 0; i < 300 && v.status === 'playing'; i++) {
    s.clock.t += 1000
    const seat = v.turn!
    const user = seat === seatP ? p : q
    const cell = user.id === winner.id ? SHIP_CELLS[used[seat]++] : WATER[used[seat]++]
    v = await s.svc.fire(code, id, user, cell, v.shots[seat].length + 1)
  }
  expect(v.status).toBe('finished')
}

/** The live matches of the cup right now, as [matchId, player, player]. */
async function liveMatches(s: S, code: string, users: TelegramUser[]) {
  const byId = new Map<string, TelegramUser[]>()
  for (const u of users) {
    const id = (await s.svc.getRoom(code, u)).yourMatch?.id
    if (id) byId.set(id, [...(byId.get(id) ?? []), u])
  }
  return [...byId.entries()].filter(([, us]) => us.length === 2)
}

/** Plays a whole cup; in every match the player with the lower number wins. */
async function playCup(s: S, users: TelegramUser[]): Promise<string> {
  const code = await startCup(s, users)
  for (let round = 0; round < 8; round++) {
    const live = await liveMatches(s, code, users)
    if (live.length === 0) break
    for (const [id, [p, q]] of live) await playMatch(s, code, id, p, q, idx(p) < idx(q) ? p : q)
  }
  expect((await s.svc.getRoom(code, users[0])).status).toBe('finished')
  await s.settled()
  return code
}

const four = [tg(1), tg(2), tg(3), tg(4)]
const matchEvent = (id: string, winnerId: string, loserId: string, at: number): RatingEvent => ({
  kind: 'match',
  id,
  winnerId,
  loserId,
  at,
})
const profiles = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`u${i}`, { name: `User ${i}`, avatarUrl: null }]))

describe('Battleship ratings', () => {
  it('a 4-player cup rates every played match and pays the finalists a bonus', async () => {
    const s = setup()
    await playCup(s, four)
    const r = await s.ratings.ranking('u1')
    // semi +16, final +16 (both finalists at 1016), champion bonus +4
    expect(r.me).toMatchObject({ rank: 1, rating: 1036, wins: 2, losses: 0, cupsWon: 1 })
    expect(r.total).toBe(4)
    expect(r.top.map((x) => x.rating)).toEqual([...r.top.map((x) => x.rating)].sort((a, b) => b - a))
    expect(r.top[0]).toMatchObject({ rank: 1, name: 'User 1', isYou: true })
    // rating points only move between players, plus the 4 + 2 bonus
    expect(r.top.reduce((sum, x) => sum + x.rating, 0)).toBe(4000 + 6)
    const loserOfFinal = r.top.find((x) => x.wins === 1 && x.losses === 1 && x.rating === 1002)
    expect(loserOfFinal).toBeTruthy()
  })

  it('cups with fewer than 4 players are not rated', async () => {
    const s = setup()
    await playCup(s, [tg(1), tg(2), tg(3)])
    const r = await s.ratings.ranking('u1')
    expect(r.total).toBe(0)
    expect(r.me).toBeNull()
  })

  it('a no-show win moves no points', async () => {
    const s = setup()
    const code = await startCup(s, four)
    const live = await liveMatches(s, code, four)
    // nobody opens any match: both semis end by no-show, then the final and 3rd place too
    for (let i = 0; i < 4; i++) {
      s.clock.t += 61_000
      await s.svc.getRoom(code, tg(1))
    }
    expect(live).toHaveLength(2)
    expect((await s.svc.getRoom(code, tg(1))).status).toBe('finished')
    await s.settled()
    expect((await s.ratings.ranking('u1')).total).toBe(0)
  })

  it('resigning once the battle has started counts as a rated loss', async () => {
    const s = setup()
    const code = await startCup(s, four)
    const [[id, [p, q]]] = await liveMatches(s, code, four)
    await s.svc.getMatch(code, id, p)
    await s.svc.getMatch(code, id, q)
    await s.svc.saveFleet(code, id, p, FLEET, true)
    await s.svc.saveFleet(code, id, q, FLEET, true)
    await s.svc.resign(code, id, q)
    await s.settled()
    expect((await s.ratings.ranking(p.id)).me).toMatchObject({ rating: 1016, wins: 1, losses: 0 })
    expect((await s.ratings.ranking(q.id)).me).toMatchObject({ rating: 984, wins: 0, losses: 1, lastDelta: -16 })
  })

  it('the same event is applied only once', async () => {
    const { ratings } = setup()
    const ev = matchEvent('ABCD:m1', 'u1', 'u2', T0)
    await ratings.applyEvents([ev], profiles)
    await ratings.applyEvents([ev], profiles)
    expect((await ratings.ranking('u1')).me).toMatchObject({ rating: 1016, wins: 1 })
  })

  it('only the first 3 matches of the same pair within 24 hours are rated', async () => {
    const { ratings } = setup()
    for (let i = 0; i < 4; i++) {
      // either player may be the winner: the limit is per pair
      const [w, l] = i % 2 ? ['u2', 'u1'] : ['u1', 'u2']
      await ratings.applyEvents([matchEvent(`C${i}:m`, w, l, T0 + i * HOUR)], profiles)
    }
    const me = (await ratings.ranking('u1')).me!
    expect(me.wins + me.losses).toBe(3)
    // a day later the pair is rated again
    await ratings.applyEvents([matchEvent('C9:m', 'u1', 'u2', T0 + 25 * HOUR)], profiles)
    const later = (await ratings.ranking('u1')).me!
    expect(later.wins + later.losses).toBe(4)
  })

  it('a player collects at most 3 cup bonuses within 24 hours', async () => {
    const { ratings } = setup()
    for (let i = 0; i < 4; i++) {
      await ratings.applyEvents(
        [{ kind: 'bonus', id: `C${i}:first`, userId: 'u1', amount: 4, cupWon: true, at: T0 + i * HOUR }],
        profiles,
      )
    }
    expect((await ratings.ranking('u1')).me).toMatchObject({ rating: 1012, cupsWon: 3 })
  })

  it('reset wipes every rating; play starts again from 1000 and old matches can be rated anew', async () => {
    const { ratings } = setup()
    const ev = matchEvent('ABCD:m1', 'u1', 'u2', T0)
    await ratings.applyEvents([ev], profiles)
    await ratings.applyEvents([matchEvent('ABCE:m1', 'u1', 'u3', T0)], profiles)
    await ratings.reset()
    const r = await ratings.ranking('u1')
    expect(r).toEqual({ top: [], total: 0, me: null })
    // the event ledger is gone too: limits and ids start fresh
    await ratings.applyEvents([ev], profiles)
    expect((await ratings.ranking('u1')).me).toMatchObject({ rating: 1016, wins: 1, losses: 0 })
  })

  it('someone without a rated match has no rank', async () => {
    const s = setup()
    await playCup(s, four)
    const r = await s.ratings.ranking('u9')
    expect(r.me).toBeNull()
    expect(r.top.every((x) => !x.isYou)).toBe(true)
  })
})
