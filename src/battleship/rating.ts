/**
 * Battleship ranking rules. Pure: which finished matches move rating points, and by how much.
 *
 * - Elo per match (K = 32, everyone starts at 1000): the winner takes points from the loser.
 * - Only cups with 4+ players count, and only matches where the battle actually started
 *   (no byes, no-shows, or opponents who left before the first shot).
 * - Reaching the final of a rated cup pays a small bonus that grows with the cup size.
 */
import type { BattleMatch, BattleRoom } from './types'

export const START_RATING = 1000
export const K_FACTOR = 32
export const RANKED_MIN_PLAYERS = 4
/** Anti-farming: the same two players are rated against each other this many times per window. */
export const PAIR_LIMIT = 3
/** Anti-farming: a player collects this many cup bonuses per window. */
export const BONUS_LIMIT = 3
export const LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000
export const MAX_CUP_BONUS = 16

/** Points the winner takes from the loser (always at least 1). */
export function eloGain(winnerRating: number, loserRating: number): number {
  const expected = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400))
  return Math.max(1, Math.round(K_FACTOR * (1 - expected)))
}

export function cupBonus(playerCount: number): { champion: number; runnerUp: number } {
  const champion = Math.min(playerCount, MAX_CUP_BONUS)
  return { champion, runnerUp: Math.round(champion / 2) }
}

export const isRankedCup = (room: Pick<BattleRoom, 'players'>) => room.players.length >= RANKED_MIN_PLAYERS

/** A real fight: two players, a winner, and the shooting had started. */
function isRatedMatch(m: BattleMatch): boolean {
  return m.status === 'finished' && !!m.winner && !!m.a && !!m.b && m.startedAt !== null
}

export type RatingEvent =
  | { kind: 'match'; id: string; winnerId: string; loserId: string; at: number }
  | { kind: 'bonus'; id: string; userId: string; amount: number; cupWon: boolean; at: number }

/** The rating events caused by one room write (ids are stable, so applying them is idempotent). */
export function ratingEvents(before: BattleRoom, after: BattleRoom): RatingEvent[] {
  if (!isRankedCup(after)) return []
  const out: RatingEvent[] = []
  const finished = after.matches
    .filter((m) => isRatedMatch(m) && before.matches.find((x) => x.id === m.id)?.status !== 'finished')
    .sort((x, y) => (x.finishedAt ?? 0) - (y.finishedAt ?? 0))
  for (const m of finished) {
    const winnerId = m[m.winner!]!
    const loserId = (m.winner === 'a' ? m.b : m.a)!
    out.push({ kind: 'match', id: `${after._id}:${m.id}`, winnerId, loserId, at: m.finishedAt ?? 0 })
  }

  if (after.status === 'finished' && before.status !== 'finished') {
    const final = after.matches.find((m) => m.kind === 'normal' && m.round === after.totalRounds - 1)
    const { first, second } = after.placements
    // no bonus for a final that was never fought
    if (final && isRatedMatch(final) && first && second) {
      const bonus = cupBonus(after.players.length)
      const at = after.finishedAt ?? final.finishedAt ?? 0
      out.push({ kind: 'bonus', id: `${after._id}:first`, userId: first, amount: bonus.champion, cupWon: true, at })
      out.push({ kind: 'bonus', id: `${after._id}:second`, userId: second, amount: bonus.runnerUp, cupWon: false, at })
    }
  }
  return out
}
