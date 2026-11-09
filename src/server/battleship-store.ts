import type { Collection, Db } from 'mongodb'
import type { BattleRoom } from '@/src/battleship/types'

export interface BattleStore {
  get(code: string): Promise<BattleRoom | null>
  /** false on duplicate _id */
  insert(room: BattleRoom): Promise<boolean>
  /** CAS on version; stores version = expectedVersion + 1. */
  replace(room: BattleRoom, expectedVersion: number): Promise<boolean>
  /** status lobby|running, newest first */
  listOpen(limit: number): Promise<BattleRoom[]>
  /** status lobby|running containing userId */
  findByPlayer(userId: string): Promise<BattleRoom[]>
}

const OPEN: BattleRoom['status'][] = ['lobby', 'running']

export class MemoryBattleStore implements BattleStore {
  private rooms = new Map<string, BattleRoom>()

  async get(code: string) {
    const r = this.rooms.get(code)
    return r ? structuredClone(r) : null
  }

  async insert(room: BattleRoom) {
    if (this.rooms.has(room._id)) return false
    this.rooms.set(room._id, structuredClone(room))
    return true
  }

  async replace(room: BattleRoom, expectedVersion: number) {
    const cur = this.rooms.get(room._id)
    if (!cur || cur.version !== expectedVersion) return false
    this.rooms.set(room._id, { ...structuredClone(room), version: expectedVersion + 1 })
    return true
  }

  async listOpen(limit: number) {
    return [...this.rooms.values()]
      .filter((r) => OPEN.includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => structuredClone(r))
  }

  async findByPlayer(userId: string) {
    return [...this.rooms.values()]
      .filter((r) => OPEN.includes(r.status) && r.players.some((p) => p.userId === userId))
      .map((r) => structuredClone(r))
  }
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000
}

export class MongoBattleStore implements BattleStore {
  private col: Collection<BattleRoom>

  constructor(db: Db) {
    this.col = db.collection<BattleRoom>('battleship_rooms')
  }

  get(code: string) {
    return this.col.findOne({ _id: code })
  }

  async insert(room: BattleRoom) {
    try {
      await this.col.insertOne(room)
      return true
    } catch (e) {
      if (isDuplicateKey(e)) return false
      throw e
    }
  }

  async replace(room: BattleRoom, expectedVersion: number) {
    const res = await this.col.replaceOne({ _id: room._id, version: expectedVersion }, { ...room, version: expectedVersion + 1 })
    return res.matchedCount === 1
  }

  listOpen(limit: number) {
    return this.col.find({ status: { $in: OPEN } }).sort({ createdAt: -1 }).limit(limit).toArray()
  }

  findByPlayer(userId: string) {
    return this.col.find({ status: { $in: OPEN }, 'players.userId': userId }).toArray()
  }
}
