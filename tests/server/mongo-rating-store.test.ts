import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import type { MongoMemoryServer } from 'mongodb-memory-server'
import { ensureIndexes } from '@/src/server/db'
import { MongoRatingStore } from '@/src/server/battleship-rating-store'

/** Runs against mongodb-memory-server; skipped (with the reason logged) when it is unavailable. */
let server: MongoMemoryServer | null = null
let client: MongoClient | null = null
let db: Db | null = null

beforeAll(async () => {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    server = await MongoMemoryServer.create()
    client = await MongoClient.connect(server.getUri())
    db = client.db('caro_test')
    await ensureIndexes(db)
  } catch (e) {
    console.warn(`[mongo-rating-store.test] mongodb-memory-server unavailable, skipping: ${e instanceof Error ? e.message : e}`)
  }
}, 180_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

const T0 = 1_800_000_000_000
const change = (delta: number, addToLast = false) => ({ delta, wins: delta > 0 ? 1 : 0, losses: delta < 0 ? 1 : 0, cupsWon: 0, addToLast })

describe('MongoRatingStore', () => {
  it('a new player starts at 1000; changes add up; a name starting with $ is stored as text', async (ctx) => {
    if (!db) return ctx.skip()
    const store = new MongoRatingStore(db)
    await store.apply('m1', { name: '$rating', avatarUrl: null }, change(16), T0)
    await store.apply('m1', { name: '$rating', avatarUrl: null }, change(-10), T0 + 1)
    await store.apply('m1', { name: '$rating', avatarUrl: null }, { delta: 4, wins: 0, losses: 0, cupsWon: 1, addToLast: true }, T0 + 2)
    expect(await store.getMany(['m1', 'nobody'])).toEqual([
      { _id: 'm1', name: '$rating', avatarUrl: null, rating: 1010, wins: 1, losses: 1, cupsWon: 1, lastDelta: -6, updatedAt: T0 + 2 },
    ])
  })

  it('top is sorted by rating; countAbove and count match', async (ctx) => {
    if (!db) return ctx.skip()
    await db.collection('battleship_ratings').deleteMany({})
    const store = new MongoRatingStore(db)
    await store.apply('a', { name: 'A', avatarUrl: null }, change(5), T0)
    await store.apply('b', { name: 'B', avatarUrl: null }, change(30), T0)
    await store.apply('c', { name: 'C', avatarUrl: null }, change(-8), T0)
    expect((await store.top(2)).map((d) => d._id)).toEqual(['b', 'a'])
    expect(await store.countAbove(1005)).toBe(1)
    expect(await store.count()).toBe(3)
  })

  it('an event is claimed once; only counted events inside the window are counted', async (ctx) => {
    if (!db) return ctx.skip()
    const store = new MongoRatingStore(db)
    const ev = (id: string, at: number, counted = true) => ({ _id: id, kind: 'match' as const, key: 'a|b', counted, at, expiresAt: new Date(at + 1e9) })
    expect(await store.claim(ev('e1', T0))).toBe(true)
    expect(await store.claim(ev('e1', T0))).toBe(false)
    await store.claim(ev('e2', T0 + 10, false))
    await store.claim(ev('e3', T0 + 20))
    expect(await store.countCounted('match', 'a|b', T0 - 1)).toBe(2)
    expect(await store.countCounted('match', 'a|b', T0)).toBe(1)
    expect(await store.countCounted('bonus', 'a|b', T0 - 1)).toBe(0)
  })

  it('reset removes every rating and every event', async (ctx) => {
    if (!db) return ctx.skip()
    const store = new MongoRatingStore(db)
    await store.apply('r1', { name: 'R', avatarUrl: null }, change(5), T0)
    await store.claim({ _id: 'r-ev', kind: 'match', key: 'x|y', counted: true, at: T0, expiresAt: new Date(T0 + 1e9) })
    await store.reset()
    expect(await store.count()).toBe(0)
    expect(await store.top(10)).toEqual([])
    expect(await store.countCounted('match', 'x|y', T0 - 1)).toBe(0)
    expect(await store.claim({ _id: 'r-ev', kind: 'match', key: 'x|y', counted: true, at: T0, expiresAt: new Date(T0 + 1e9) })).toBe(true)
  })
})
