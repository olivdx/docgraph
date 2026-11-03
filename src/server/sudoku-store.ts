import type { Collection, Db } from 'mongodb'
import type { SudokuRoom } from '@/src/sudoku/types'

export interface SudokuStore {
  get(code: string): Promise<SudokuRoom | null>
  /** false on duplicate _id */
  insert(room: SudokuRoom): Promise<boolean>
  /** CAS on version; stores version = expectedVersion + 1. */
  replace(room: SudokuRoom, expectedVersion: number): Promise<boolean>
  /** status lobby|playing, newest first */
  listOpen(limit: number): Promise<SudokuRoom[]>
  /** status lobby|playing containing userId */
  findByPlayer(userId: string): Promise<SudokuRoom[]>
}

const OPEN: SudokuRoom['status'][] = ['lobby', 'playing']

export class MemorySudokuStore implements SudokuStore {
  private rooms = new Map<string, SudokuRoom>()

  async get(code: string) {
    const r = this.rooms.get(code)
    return r ? structuredClone(r) : null
  }

  async insert(room: SudokuRoom) {
    if (this.rooms.has(room._id)) return false
    this.rooms.set(room._id, structuredClone(room))
    return true
  }

  async replace(room: SudokuRoom, expectedVersion: number) {
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

export class MongoSudokuStore implements SudokuStore {
  private col: Collection<SudokuRoom>

  constructor(db: Db) {
    this.col = db.collection<SudokuRoom>('sudoku_rooms')
  }

  get(code: string) {
    return this.col.findOne({ _id: code })
  }

  async insert(room: SudokuRoom) {
    try {
      await this.col.insertOne(room)
      return true
    } catch (e) {
      if (isDuplicateKey(e)) return false
      throw e
    }
  }

  async replace(room: SudokuRoom, expectedVersion: number) {
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
