import {
  BONUS_LIMIT,
  LIMIT_WINDOW_MS,
  PAIR_LIMIT,
  START_RATING,
  eloGain,
  ratingEvents,
  type RatingEvent,
} from '@/src/battleship/rating'
import type { BattleRoom } from '@/src/battleship/types'
import type { RatingDoc, RatingStore } from './battleship-rating-store'

export interface RankRow {
  rank: number
  name: string
  avatarUrl: string | null
  rating: number
  wins: number
  losses: number
  isYou: boolean
}

export interface RankingView {
  top: RankRow[]
  /** Players with at least one rated match. */
  total: number
  /** null until your first rated match */
  me: (RankRow & { cupsWon: number; lastDelta: number }) | null
}

type Profiles = Record<string, { name: string; avatarUrl: string | null }>

const TOP_LIMIT = 50
/** Events are only needed for idempotency and the 24 h limits. */
const EVENT_TTL_MS = 7 * LIMIT_WINDOW_MS
const UNKNOWN = { name: 'Captain', avatarUrl: null }

export class BattleshipRatingService {
  constructor(private deps: { store: RatingStore }) {}

  /** Applies whatever one room write finished. Never throws: a rating failure must not break the game. */
  async recordWrite(before: BattleRoom, after: BattleRoom): Promise<void> {
    try {
      const events = ratingEvents(before, after)
      if (events.length === 0) return
      const profiles: Profiles = {}
      for (const p of after.players) profiles[p.userId] = { name: p.name, avatarUrl: p.avatarUrl }
      await this.applyEvents(events, profiles)
    } catch (e) {
      console.error('[battleship-rating]', e)
    }
  }

  async applyEvents(events: RatingEvent[], profiles: Profiles): Promise<void> {
    const { store } = this.deps
    for (const ev of events) {
      const key = ev.kind === 'match' ? [ev.winnerId, ev.loserId].sort().join('|') : ev.userId
      const limit = ev.kind === 'match' ? PAIR_LIMIT : BONUS_LIMIT
      const counted = (await store.countCounted(ev.kind, key, ev.at - LIMIT_WINDOW_MS)) < limit
      const claimed = await store.claim({
        _id: ev.id,
        kind: ev.kind,
        key,
        counted,
        at: ev.at,
        expiresAt: new Date(ev.at + EVENT_TTL_MS),
      })
      if (!claimed || !counted) continue

      if (ev.kind === 'bonus') {
        await store.apply(
          ev.userId,
          profiles[ev.userId] ?? UNKNOWN,
          { delta: ev.amount, wins: 0, losses: 0, cupsWon: ev.cupWon ? 1 : 0, addToLast: true },
          ev.at,
        )
        continue
      }
      const docs = await store.getMany([ev.winnerId, ev.loserId])
      const ratingOf = (id: string) => docs.find((d) => d._id === id)?.rating ?? START_RATING
      const gain = eloGain(ratingOf(ev.winnerId), ratingOf(ev.loserId))
      await store.apply(
        ev.winnerId,
        profiles[ev.winnerId] ?? UNKNOWN,
        { delta: gain, wins: 1, losses: 0, cupsWon: 0, addToLast: false },
        ev.at,
      )
      await store.apply(
        ev.loserId,
        profiles[ev.loserId] ?? UNKNOWN,
        { delta: -gain, wins: 0, losses: 1, cupsWon: 0, addToLast: false },
        ev.at,
      )
    }
  }

  async ranking(userId: string): Promise<RankingView> {
    const { store } = this.deps
    const [docs, total, [mine]] = await Promise.all([store.top(TOP_LIMIT), store.count(), store.getMany([userId])])
    const row = (d: RatingDoc, rank: number): RankRow => ({
      rank,
      name: d.name,
      avatarUrl: d.avatarUrl,
      rating: d.rating,
      wins: d.wins,
      losses: d.losses,
      isYou: d._id === userId,
    })
    // equal ratings share a rank
    const top = docs.map((d) => row(d, 1 + docs.filter((x) => x.rating > d.rating).length))
    if (!mine) return { top, total, me: null }
    const rank = 1 + (await store.countAbove(mine.rating))
    return { top, total, me: { ...row(mine, rank), cupsWon: mine.cupsWon, lastDelta: mine.lastDelta } }
  }
}
