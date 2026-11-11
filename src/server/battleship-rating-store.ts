import type { Collection, Db } from 'mongodb'
import { START_RATING } from '@/src/battleship/rating'

export interface RatingDoc {
  /** Telegram user id */
  _id: string
  name: string
  avatarUrl: string | null
  rating: number
  wins: number
  losses: number
  cupsWon: number
  /** The latest rating change (a cup bonus is added to the match it came with). */
  lastDelta: number
  updatedAt: number
}

/** One row per rating event: makes applying idempotent and backs the anti-farming limits. */
export interface RatingEventDoc {
  _id: string
  kind: 'match' | 'bonus'
  /** match: the two user ids, sorted and joined; bonus: the user id */
  key: string
  /** false when the event was over a limit and moved no points */
  counted: boolean
  at: number
  expiresAt: Date
}

export interface RatingChange {
  delta: number
  wins: number
  losses: number
  cupsWon: number
  /** Add to lastDelta instead of replacing it. */
  addToLast: boolean
}

export interface RatingStore {
  /** false when this event id was already claimed */
  claim(ev: RatingEventDoc): Promise<boolean>
  /** counted events of this kind and key with at > since */
  countCounted(kind: RatingEventDoc['kind'], key: string, since: number): Promise<number>
  getMany(userIds: string[]): Promise<RatingDoc[]>
  /** Creates the player at the start rating if needed, then applies the change atomically. */
  apply(userId: string, profile: { name: string; avatarUrl: string | null }, change: RatingChange, now: number): Promise<void>
  /** Highest rating first; ties: whoever got there first. */
  top(limit: number): Promise<RatingDoc[]>
  countAbove(rating: number): Promise<number>
  count(): Promise<number>
}

export class MemoryRatingStore implements RatingStore {
  private docs = new Map<string, RatingDoc>()
  private events = new Map<string, RatingEventDoc>()

  async claim(ev: RatingEventDoc) {
    if (this.events.has(ev._id)) return false
    this.events.set(ev._id, structuredClone(ev))
    return true
  }

  async countCounted(kind: RatingEventDoc['kind'], key: string, since: number) {
    return [...this.events.values()].filter((e) => e.kind === kind && e.key === key && e.counted && e.at > since).length
  }

  async getMany(userIds: string[]) {
    return userIds.flatMap((id) => (this.docs.has(id) ? [structuredClone(this.docs.get(id)!)] : []))
  }

  async apply(userId: string, profile: { name: string; avatarUrl: string | null }, change: RatingChange, now: number) {
    const cur = this.docs.get(userId)
    this.docs.set(userId, {
      _id: userId,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      rating: (cur?.rating ?? START_RATING) + change.delta,
      wins: (cur?.wins ?? 0) + change.wins,
      losses: (cur?.losses ?? 0) + change.losses,
      cupsWon: (cur?.cupsWon ?? 0) + change.cupsWon,
      lastDelta: change.addToLast ? (cur?.lastDelta ?? 0) + change.delta : change.delta,
      updatedAt: now,
    })
  }

  async top(limit: number) {
    return [...this.docs.values()]
      .sort((a, b) => b.rating - a.rating || a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map((d) => structuredClone(d))
  }

  async countAbove(rating: number) {
    return [...this.docs.values()].filter((d) => d.rating > rating).length
  }

  async count() {
    return this.docs.size
  }
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000
}

export class MongoRatingStore implements RatingStore {
  private col: Collection<RatingDoc>
  private events: Collection<RatingEventDoc>

  constructor(db: Db) {
    this.col = db.collection<RatingDoc>('battleship_ratings')
    this.events = db.collection<RatingEventDoc>('battleship_rating_events')
  }

  async claim(ev: RatingEventDoc) {
    try {
      await this.events.insertOne(ev)
      return true
    } catch (e) {
      if (isDuplicateKey(e)) return false
      throw e
    }
  }

  countCounted(kind: RatingEventDoc['kind'], key: string, since: number) {
    return this.events.countDocuments({ kind, key, counted: true, at: { $gt: since } })
  }

  getMany(userIds: string[]) {
    return this.col.find({ _id: { $in: userIds } }).toArray()
  }

  async apply(userId: string, profile: { name: string; avatarUrl: string | null }, change: RatingChange, now: number) {
    const add = (field: string, start: number, by: number) => ({ $add: [{ $ifNull: [`$${field}`, start] }, by] })
    // A pipeline update, so a brand-new player starts from START_RATING in the same atomic write.
    await this.col.updateOne(
      { _id: userId },
      [
        {
          $set: {
            name: { $literal: profile.name },
            avatarUrl: { $literal: profile.avatarUrl },
            rating: add('rating', START_RATING, change.delta),
            wins: add('wins', 0, change.wins),
            losses: add('losses', 0, change.losses),
            cupsWon: add('cupsWon', 0, change.cupsWon),
            lastDelta: change.addToLast ? add('lastDelta', 0, change.delta) : { $literal: change.delta },
            updatedAt: { $literal: now },
          },
        },
      ],
      { upsert: true },
    )
  }

  top(limit: number) {
    return this.col.find().sort({ rating: -1, updatedAt: 1 }).limit(limit).toArray()
  }

  countAbove(rating: number) {
    return this.col.countDocuments({ rating: { $gt: rating } })
  }

  count() {
    return this.col.estimatedDocumentCount()
  }
}
