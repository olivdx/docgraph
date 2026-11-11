import { describe, expect, it } from 'vitest'
import { cupBonus, eloGain } from '@/src/battleship/rating'

describe('eloGain', () => {
  it('equal ratings move 16 points', () => {
    expect(eloGain(1000, 1000)).toBe(16)
  })

  it('beating a stronger player pays more than beating a weaker one', () => {
    expect(eloGain(1000, 1400)).toBeGreaterThan(16)
    expect(eloGain(1400, 1000)).toBeLessThan(16)
  })

  it('a win always pays at least 1 point', () => {
    expect(eloGain(3000, 100)).toBe(1)
  })
})

describe('cupBonus', () => {
  it('champion gets one point per player, runner-up half', () => {
    expect(cupBonus(4)).toEqual({ champion: 4, runnerUp: 2 })
    expect(cupBonus(7)).toEqual({ champion: 7, runnerUp: 4 })
  })

  it('is capped at 16', () => {
    expect(cupBonus(32)).toEqual({ champion: 16, runnerUp: 8 })
  })
})
