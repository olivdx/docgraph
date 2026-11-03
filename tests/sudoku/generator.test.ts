import { describe, expect, it } from 'vitest'
import { countSolutions, generate, GIVENS, givenCount, PEERS, solve } from '@/src/sudoku/generator'
import { DIFFICULTIES } from '@/src/sudoku/types'
import { mulberry } from '../tournament/helpers'

function isValidSolution(s: string): boolean {
  if (!/^[1-9]{81}$/.test(s)) return false
  return [...s].every((d, i) => PEERS[i].every((j) => s[j] !== d))
}

describe('generator', () => {
  it('PEERS has 20 peers per cell', () => {
    expect(PEERS.every((p) => p.length === 20)).toBe(true)
  })

  for (const d of DIFFICULTIES) {
    it(`${d}: unique-solution puzzles inside the given range, consistent with the solution`, () => {
      const rng = mulberry(42)
      for (let n = 0; n < 8; n++) {
        const t0 = performance.now()
        const { puzzle, solution } = generate(d, rng)
        expect(performance.now() - t0).toBeLessThan(1000)
        expect(isValidSolution(solution)).toBe(true)
        expect(countSolutions(puzzle)).toBe(1)
        expect(solve(puzzle)).toBe(solution)
        const g = givenCount(puzzle)
        expect(g).toBeGreaterThanOrEqual(GIVENS[d].min)
        expect(g).toBeLessThanOrEqual(GIVENS[d].max)
        expect([...puzzle].every((c, i) => c === '0' || c === solution[i])).toBe(true)
      }
    })
  }

  it('different seeds give different puzzles', () => {
    expect(generate('medium', mulberry(1)).puzzle).not.toBe(generate('medium', mulberry(2)).puzzle)
  })

  it('solver: none for contradictory grids, 2+ for an empty grid', () => {
    expect(solve('11' + '0'.repeat(79))).toBeNull()
    expect(countSolutions('0'.repeat(81))).toBe(2)
  })
})
