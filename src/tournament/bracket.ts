import { BOT_NAMES } from './constants'
import type { Match, Player } from './types'

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function planBracket(
  humans: Player[],
  rng: () => number,
): { size: number; totalRounds: number; order: Player[] } {
  let size = 2
  let totalRounds = 1
  while (size < humans.length) {
    size *= 2
    totalRounds++
  }
  const botCount = size - humans.length // always <= size/2, so each bot gets its own pair
  const hs = shuffle(humans, rng)
  // Which round-1 pairs get a bot: a random subset, so bots don't cluster at the top of the bracket.
  const pairs = Array.from({ length: size / 2 }, (_, i) => i)
  const botPairs = new Set(shuffle(pairs, rng).slice(0, botCount))
  const order: Player[] = []
  let h = 0
  let n = 0
  for (let s = 0; s < size / 2; s++) {
    order.push(hs[h++]) // the human always takes the odd (first) position of the pair
    if (botPairs.has(s)) {
      n++
      order.push({ userId: `bot:${n}`, name: BOT_NAMES[(n - 1) % BOT_NAMES.length], avatarUrl: null, isBot: true, seed: null, joinedAt: 0 })
    } else {
      order.push(hs[h++])
    }
  }
  return { size, totalRounds, order: order.map((p, i) => ({ ...p, seed: i + 1 })) }
}

/**
 * Like planBracket, for games without bots: empty seats are byes (null). Each bye is the second
 * half of its own round-1 pair, and the pairs that get one are random. Seeds are the caller's job.
 */
export function planByeBracket<T>(
  entrants: T[],
  rng: () => number,
): { size: number; totalRounds: number; order: (T | null)[] } {
  let size = 2
  let totalRounds = 1
  while (size < entrants.length) {
    size *= 2
    totalRounds++
  }
  const byeCount = size - entrants.length // always <= size/2, so each bye gets its own pair
  const es = shuffle(entrants, rng)
  const pairs = Array.from({ length: size / 2 }, (_, i) => i)
  const byePairs = new Set(shuffle(pairs, rng).slice(0, byeCount))
  const order: (T | null)[] = []
  let e = 0
  for (let s = 0; s < size / 2; s++) {
    order.push(es[e++])
    order.push(byePairs.has(s) ? null : es[e++])
  }
  return { size, totalRounds, order }
}

export function roundName(round: number, totalRounds: number, kind: Match['kind']): string {
  if (kind === 'third_place') return '3rd Place'
  const fromEnd = totalRounds - 1 - round
  if (fromEnd === 0) return 'Final'
  if (fromEnd === 1) return 'Semifinal'
  if (fromEnd === 2) return 'Quarterfinal'
  return `Round of ${2 ** (totalRounds - round)}`
}
