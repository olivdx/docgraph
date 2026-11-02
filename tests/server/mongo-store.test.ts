import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import type { MongoMemoryServer } from 'mongodb-memory-server'
import { ensureIndexes } from '@/src/server/db'
import { MongoPresenceStore, MongoRoomStore } from '@/src/server/stores'
import { createRoom, joinRoom } from '@/src/tournament/room'
import type { Room } from '@/src/tournament/types'

/**
 * Runs against mongodb-memory-server. If its binary cannot be downloaded/started in this
 * environment, every test is skipped (with the reason logged) instead of failing the suite.
 */
let server: MongoMemoryServer | null = null
let client: MongoClient | null = null
let db: Db | null = null
let unavailable: string | null = null

beforeAll(async () => {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    server = await MongoMemoryServer.create()
    client = await MongoClient.connect(server.getUri())
    db = client.db('caro_test')
  } catch (e) {
    unavailable = e instanceof Error ? e.message : String(e)
    console.warn(`[mongo-store.test] mongodb-memory-server unavailable, skipping: ${unavailable}`)
  }
}, 180_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

const host = (i: number) => ({ userId: `u${i}`, name: `User ${i}`, avatarUrl: null })
const T0 = 1_800_000_000_000

function room(code: string, hostIdx: number, now = T0): Room {
  return createRoom({ code, host: host(hostIdx), now })
}

describe('Mongo stores', () => {
  it('insert duplicate → false; get round-trips expiresAt as a Date', async (ctx) => {
    if (!db) return ctx.skip()
    const rooms = new MongoRoomStore(db)
    const r = room('DUP001', 1)
    expect(await rooms.insert(r)).toBe(true)
    expect(await rooms.insert(r)).toBe(false)
    const got = await rooms.get('DUP001')
    expect(got).toEqual(r)
    expect(got!.expiresAt).toBeInstanceOf(Date)
    expect(await rooms.get('NOPE00')).toBeNull()
  })

  it('replace with a stale version → false; fresh version bumps it', async (ctx) => {
    if (!db) return ctx.skip()
    const rooms = new MongoRoomStore(db)
    const r = room('CAS001', 1)
    await rooms.insert(r)
    const next = joinRoom(r, host(2), T0 + 1)
    expect(await rooms.replace(next, 0)).toBe(true)
    expect((await rooms.get('CAS001'))!.version).toBe(1)
    expect(await rooms.replace(next, 0)).toBe(false) // stale
    const got = (await rooms.get('CAS001'))!
    expect(got.version).toBe(1)
    expect(got.players.length).toBe(2)
  })

  it('listOpen excludes finished rooms, newest first', async (ctx) => {
    if (!db) return ctx.skip()
    await db.collection('rooms').deleteMany({})
    const rooms = new MongoRoomStore(db)
    await rooms.insert(room('OPEN01', 1, T0))
    await rooms.insert({ ...room('RUN001', 2, T0 + 10), status: 'running' })
    await rooms.insert({ ...room('FIN001', 3, T0 + 20), status: 'finished' })
    await rooms.insert({ ...room('CAN001', 4, T0 + 30), status: 'cancelled' })
    const list = await rooms.listOpen(10)
    expect(list.map((r) => r._id)).toEqual(['RUN001', 'OPEN01'])
    expect((await rooms.listOpen(1)).map((r) => r._id)).toEqual(['RUN001'])
  })

  it('findByPlayer works', async (ctx) => {
    if (!db) return ctx.skip()
    await db.collection('rooms').deleteMany({})
    const rooms = new MongoRoomStore(db)
    await rooms.insert(joinRoom(room('FBP001', 1), host(7), T0))
    await rooms.insert(room('FBP002', 7))
    await rooms.insert({ ...room('FBP003', 7), status: 'finished' })
    await rooms.insert(room('FBP004', 8))
    const found = (await rooms.findByPlayer('u7')).map((r) => r._id).sort()
    expect(found).toEqual(['FBP001', 'FBP002'])
    expect(await rooms.findByPlayer('u99')).toEqual([])
  })

  it('presence touch upserts and get returns last-seen times', async (ctx) => {
    if (!db) return ctx.skip()
    const presence = new MongoPresenceStore(db)
    await presence.touch('PRS001', 'u1', T0)
    await presence.touch('PRS001', 'u1', T0 + 500)
    await presence.touch('PRS001', 'u2', T0 + 100)
    await presence.touch('OTHER1', 'u3', T0)
    expect(await presence.get('PRS001', ['u1', 'u2', 'u3'])).toEqual({ u1: T0 + 500, u2: T0 + 100 })
    expect(await presence.get('PRS001', [])).toEqual({})
    const doc = await db.collection<{ _id: string; at: number; expiresAt: Date }>('presence').findOne({ _id: 'PRS001:u1' })
    expect(doc!.expiresAt).toBeInstanceOf(Date)
    expect(doc!.expiresAt.getTime()).toBe(T0 + 500 + 60 * 60 * 1000)
  })

  it('ensureIndexes creates the TTL index with expireAfterSeconds: 0', async (ctx) => {
    if (!db) return ctx.skip()
    await ensureIndexes(db)
    await ensureIndexes(db) // idempotent
    const roomIdx = await db.collection('rooms').indexes()
    const ttl = roomIdx.find((i) => JSON.stringify(i.key) === JSON.stringify({ expiresAt: 1 }))
    expect(ttl?.expireAfterSeconds).toBe(0)
    expect(roomIdx.some((i) => JSON.stringify(i.key) === JSON.stringify({ status: 1, createdAt: -1 }))).toBe(true)
    expect(roomIdx.some((i) => JSON.stringify(i.key) === JSON.stringify({ 'players.userId': 1 }))).toBe(true)
    const presIdx = await db.collection('presence').indexes()
    const pttl = presIdx.find((i) => JSON.stringify(i.key) === JSON.stringify({ expiresAt: 1 }))
    expect(pttl?.expireAfterSeconds).toBe(0)
  })
})
