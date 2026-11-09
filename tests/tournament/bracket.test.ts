import { describe, it, expect } from 'vitest'
import { planBracket, planByeBracket, roundName } from '@/src/tournament/bracket'
import { randomCode } from '@/src/tournament/codes'
import { BOT_NAMES, CODE_ALPHABET } from '@/src/tournament/constants'
import type { Player } from '@/src/tournament/types'

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const humans = (n: number): Player[] =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, name: `U${i}`, avatarUrl: null, isBot: false, seed: null, joinedAt: i }))

describe('planBracket', () => {
  it.each([[2, 2, 1], [3, 4, 2], [4, 4, 2], [5, 8, 3], [9, 16, 4], [17, 32, 5], [32, 32, 5]])(
    '%i humans → size %i, %i rounds',
    (n, size, rounds) => {
      const p = planBracket(humans(n), mulberry(1))
      expect(p.size).toBe(size)
      expect(p.totalRounds).toBe(rounds)
      expect(p.order).toHaveLength(size)
    },
  )
  it('no round-1 pair is bot vs bot for every n in 2..32', () => {
    for (let n = 2; n <= 32; n++) {
      const { order } = planBracket(humans(n), mulberry(n))
      for (let s = 0; s < order.length / 2; s++) {
        expect(order[2 * s].isBot).toBe(false)
      }
    }
  })
  it('seeds are 1..size and unique', () => {
    for (let n = 2; n <= 32; n++) {
      const { order, size } = planBracket(humans(n), mulberry(n))
      expect(order.map((p) => p.seed)).toEqual(Array.from({ length: size }, (_, i) => i + 1))
    }
  })
  it('bot ids are bot:1.. and names from BOT_NAMES', () => {
    const { order } = planBracket(humans(5), mulberry(3))
    const bots = order.filter((p) => p.isBot)
    expect(bots).toHaveLength(3)
    expect(bots.map((b) => b.userId).sort()).toEqual(['bot:1', 'bot:2', 'bot:3'])
    for (const b of bots) {
      expect(BOT_NAMES).toContain(b.name)
      expect(b.avatarUrl).toBeNull()
      expect(b.joinedAt).toBe(0)
    }
  })
  it('bot pairs are spread over the bracket, not always the first K pairs', () => {
    const botPairs = (n: number, seed: number) => {
      const { order } = planBracket(humans(n), mulberry(seed))
      const pairs: number[] = []
      for (let s = 0; s < order.length / 2; s++) {
        expect(order[2 * s].isBot).toBe(false) // human always first, never bot vs bot
        if (order[2 * s + 1].isBot) pairs.push(s)
      }
      return pairs
    }
    for (const n of [3, 5, 6, 9, 13]) {
      const seen = new Set<string>()
      for (let seed = 1; seed <= 20; seed++) {
        const pairs = botPairs(n, seed)
        let size = 2
        while (size < n) size *= 2
        expect(pairs).toHaveLength(size - n) // exactly one bot per bot pair
        seen.add(pairs.join(','))
      }
      const firstK = Array.from({ length: [...seen][0].split(',').length }, (_, i) => i).join(',')
      expect([...seen].some((p) => p !== firstK)).toBe(true)
    }
  })
  it('does not mutate input', () => {
    const h = humans(5)
    const copy = JSON.parse(JSON.stringify(h))
    planBracket(h, mulberry(2))
    expect(h).toEqual(copy)
  })
})

describe('roundName', () => {
  it('names rounds', () => {
    expect(roundName(0, 3, 'normal')).toBe('Quarterfinal')
    expect(roundName(2, 3, 'normal')).toBe('Final')
    expect(roundName(1, 3, 'normal')).toBe('Semifinal')
    expect(roundName(0, 5, 'normal')).toBe('Round of 32')
    expect(roundName(2, 3, 'third_place')).toBe('3rd Place')
  })
})

describe('randomCode', () => {
  it('uses only the alphabet', () => {
    const rng = mulberry(9)
    for (let i = 0; i < 50; i++) {
      const c = randomCode(6, rng)
      expect(c).toHaveLength(6)
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch)
    }
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789')
  })
})

describe('planByeBracket', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)
  it.each([[2, 2, 1], [3, 4, 2], [5, 8, 3], [32, 32, 5]])('%i entrants → size %i, %i rounds', (n, size, rounds) => {
    const p = planByeBracket(ids(n), mulberry(n))
    expect(p.size).toBe(size)
    expect(p.totalRounds).toBe(rounds)
  })
  it('byes fill the empty seats, each as the second half of its own round-1 pair', () => {
    for (let n = 2; n <= 32; n++) {
      const { order, size } = planByeBracket(ids(n), mulberry(n))
      expect(order).toHaveLength(size)
      expect(order.filter((x) => x === null)).toHaveLength(size - n)
      for (let s = 0; s < size / 2; s++) expect(order[2 * s]).not.toBeNull()
    }
  })
  it('places every entrant exactly once', () => {
    for (let n = 2; n <= 32; n++) {
      const { order } = planByeBracket(ids(n), mulberry(n + 100))
      expect(order.filter((x) => x !== null).sort()).toEqual(ids(n).sort())
    }
  })
})
