import type { Collection, Db } from 'mongodb'
import { bookId, type BookDelta, type BookDoc, type GameRecord, type HintEntry } from '@/src/game/gauntlet-learn'
import type { Side } from '@/src/game/types'

export const GAMES_TTL_MS = 90 * 24 * 3600 * 1000

export interface GauntletBookStore {
  getBook(key: string, side: Side): Promise<BookDoc | null>
  insertGame(rec: GameRecord): Promise<boolean>
  applyDeltas(deltas: BookDelta[], now: number): Promise<void>
}

const ZERO_HINT: HintEntry = { w: 0, n: 0, wins: 0, losses: 0 }

export class MemoryGauntletBookStore implements GauntletBookStore {
  readonly games = new Map<string, GameRecord>()
  readonly books = new Map<string, BookDoc>()

  async getBook(key: string, side: Side): Promise<BookDoc | null> {
    const doc = this.books.get(bookId(key, side))
    return doc ? structuredClone(doc) : null
  }

  async insertGame(rec: GameRecord): Promise<boolean> {
    if (this.games.has(rec._id)) return false
    this.games.set(rec._id, structuredClone(rec))
    return true
  }

  async applyDeltas(deltas: BookDelta[], now: number): Promise<void> {
    for (const delta of deltas) {
      const id = bookId(delta.key, delta.side)
      const doc = this.books.get(id) ?? { _id: id, side: delta.side, moves: {}, updatedAt: now }
      const hint = doc.moves[delta.cell] ?? { ...ZERO_HINT }
      doc.moves[delta.cell] = {
        w: hint.w + delta.delta,
        n: hint.n + 1,
        wins: hint.wins + (delta.won ? 1 : 0),
        losses: hint.losses + (delta.won ? 0 : 1),
      }
      doc.updatedAt = now
      this.books.set(id, doc)
    }
  }
}

type GameDoc = GameRecord & { expiresAt: Date }

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000
}

export class MongoGauntletBookStore implements GauntletBookStore {
  private readonly books: Collection<BookDoc>
  private readonly games: Collection<GameDoc>

  constructor(db: Db) {
    this.books = db.collection<BookDoc>('gauntlet_book')
    this.games = db.collection<GameDoc>('gauntlet_games')
  }

  getBook(key: string, side: Side): Promise<BookDoc | null> {
    return this.books.findOne({ _id: bookId(key, side) })
  }

  async insertGame(rec: GameRecord): Promise<boolean> {
    try {
      await this.games.insertOne({ ...rec, expiresAt: new Date(rec.createdAt + GAMES_TTL_MS) })
      return true
    } catch (e) {
      if (isDuplicateKey(e)) return false
      throw e
    }
  }

  async applyDeltas(deltas: BookDelta[], now: number): Promise<void> {
    if (deltas.length === 0) return
    await this.books.bulkWrite(
      deltas.map((delta) => ({
        updateOne: {
          filter: { _id: bookId(delta.key, delta.side) },
          update: {
            $setOnInsert: { side: delta.side },
            $set: { updatedAt: now },
            $inc: {
              [`moves.${delta.cell}.w`]: delta.delta,
              [`moves.${delta.cell}.n`]: 1,
              [`moves.${delta.cell}.wins`]: delta.won ? 1 : 0,
              [`moves.${delta.cell}.losses`]: delta.won ? 0 : 1,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    )
  }
}
