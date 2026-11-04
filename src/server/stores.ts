import type { Collection, Db } from 'mongodb'
import { normalizeRoom } from '@/src/tournament/room'
import type { ListedRoom, Room } from '@/src/tournament/types'

export interface RoomStore {
  get(code: string): Promise<Room | null>
  /** false on duplicate _id */
  insert(room: Room): Promise<boolean>
  /** CAS on version: succeeds only if the stored version === expectedVersion; stores version = expectedVersion + 1. */
  replace(room: Room, expectedVersion: number): Promise<boolean>
  /** status lobby|running, newest first; `matches[].moves` is omitted (summaries never need it) */
  listOpen(limit: number): Promise<ListedRoom[]>
  /** status lobby|running containing userId */
  findByPlayer(userId: string): Promise<Room[]>
}

export interface PresenceStore {
  touch(code: string, userId: string, now: number): Promise<void>
  get(code: string, userIds: string[]): Promise<Record<string, number>>
}

export const PRESENCE_TTL_MS = 15 * 60 * 1000
const OPEN: Room['status'][] = ['lobby', 'running']

// ---- memory ------------------------------------------------------------------------------------

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>()

  async get(code: string): Promise<Room | null> {
    const r = this.rooms.get(code)
    return r ? structuredClone(r) : null
  }

  async insert(room: Room): Promise<boolean> {
    if (this.rooms.has(room._id)) return false
    this.rooms.set(room._id, structuredClone(room))
    return true
  }

  async replace(room: Room, expectedVersion: number): Promise<boolean> {
    const cur = this.rooms.get(room._id)
    if (!cur || cur.version !== expectedVersion) return false
    this.rooms.set(room._id, { ...structuredClone(room), version: expectedVersion + 1 })
    return true
  }

  async listOpen(limit: number): Promise<ListedRoom[]> {
    return [...this.rooms.values()]
      .filter((r) => OPEN.includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => {
        const { matches, ...rest } = structuredClone(r)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        return { ...rest, matches: matches.map(({ moves, ...m }) => m) }
      })
  }

  async findByPlayer(userId: string): Promise<Room[]> {
    return [...this.rooms.values()]
      .filter((r) => OPEN.includes(r.status) && r.players.some((p) => p.userId === userId))
      .map((r) => structuredClone(r))
  }
}

export class MemoryPresenceStore implements PresenceStore {
  private seen = new Map<string, number>()

  async touch(code: string, userId: string, now: number): Promise<void> {
    const key = `${code}:${userId}`
    this.seen.set(key, Math.max(this.seen.get(key) ?? 0, now))
  }

  async get(code: string, userIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const id of userIds) {
      const at = this.seen.get(`${code}:${id}`)
      if (at !== undefined) out[id] = at
    }
    return out
  }
}

// ---- mongo -------------------------------------------------------------------------------------

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000
}

export class MongoRoomStore implements RoomStore {
  private col: Collection<Room>

  constructor(db: Db) {
    this.col = db.collection<Room>('rooms')
  }

  async get(code: string): Promise<Room | null> {
    const r = await this.col.findOne({ _id: code })
    return r ? normalizeRoom(r) : null
  }

  async insert(room: Room): Promise<boolean> {
    try {
      await this.col.insertOne(room)
      return true
    } catch (e) {
      if (isDuplicateKey(e)) return false
      throw e
    }
  }

  async replace(room: Room, expectedVersion: number): Promise<boolean> {
    const res = await this.col.replaceOne(
      { _id: room._id, version: expectedVersion },
      { ...room, version: expectedVersion + 1 },
    )
    return res.matchedCount === 1
  }

  async listOpen(limit: number): Promise<ListedRoom[]> {
    return this.col
      .find<ListedRoom>({ status: { $in: OPEN } }, { projection: { 'matches.moves': 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }

  async findByPlayer(userId: string): Promise<Room[]> {
    return (await this.col.find({ status: { $in: OPEN }, 'players.userId': userId }).toArray()).map(normalizeRoom)
  }
}

interface PresenceDoc {
  _id: string
  at: number
  expiresAt: Date
}

export class MongoPresenceStore implements PresenceStore {
  private col: Collection<PresenceDoc>

  constructor(db: Db) {
    this.col = db.collection<PresenceDoc>('presence')
  }

  async touch(code: string, userId: string, now: number): Promise<void> {
    await this.col.updateOne(
      { _id: `${code}:${userId}` },
      { $max: { at: now }, $set: { expiresAt: new Date(now + PRESENCE_TTL_MS) } },
      { upsert: true },
    )
  }

  async get(code: string, userIds: string[]): Promise<Record<string, number>> {
    if (userIds.length === 0) return {}
    const docs = await this.col.find({ _id: { $in: userIds.map((id) => `${code}:${id}`) } }).toArray()
    const out: Record<string, number> = {}
    const prefix = `${code}:`
    for (const d of docs) out[d._id.slice(prefix.length)] = d.at
    return out
  }
}
