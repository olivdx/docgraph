import { describe, expect, it } from 'vitest'
import { chooseBotMove, strengthForLevel } from '@/src/game/bot'
import { createRoom, joinRoom, setBotLevel, startRoom } from '@/src/tournament/room'
import { RoomError, resolveBotLevel } from '@/src/tournament/types'
import { mulberry, user } from './helpers'

const T0 = 1_800_000_000_000
const START = T0 + 1

function lobby(humans: number) {
  let r = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
  for (let i = 1; i < humans; i++) r = joinRoom(r, user(i), T0 + i)
  return r
}

function code(fn: () => unknown) {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof RoomError) return e.code
    throw e
  }
}

describe('bot level', () => {
  it('defaults to duel on new and legacy rooms', () => {
    const r = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
    expect(r.botLevel).toBe('duel')
    expect(resolveBotLevel({})).toBe('duel')
  })

  it('host can set level in the lobby only', () => {
    const l = lobby(1)
    expect(setBotLevel(l, 'u0', 'gauntlet').botLevel).toBe('gauntlet')
    expect(code(() => setBotLevel(l, 'u1', 'prelude'))).toBe('not_host')
    expect(code(() => setBotLevel(startRoom(l, 'u0', START, mulberry(1)), 'u0', 'prelude'))).toBe('not_lobby')
  })

  it('started room keeps the chosen level for bot moves', () => {
    const r = startRoom(setBotLevel(lobby(1), 'u0', 'prelude'), 'u0', START, mulberry(2))
    expect(resolveBotLevel(r)).toBe('prelude')
  })

  it('strength presets match the lobby labels', () => {
    expect(strengthForLevel('prelude')).toMatchObject({ maxDepth: 2, vcf: false, vct: false })
    expect(strengthForLevel('duel')).toMatchObject({ maxDepth: 4, vcf: true, vct: false })
    // Gauntlet runs its own engine (bot-gauntlet.ts), which deepens until its 2 s budget runs out.
    expect(strengthForLevel('gauntlet')).toMatchObject({ timeBudgetMs: 2000, vcf: true, vct: true })
  })

  it('prelude full move finishes under 150ms on a quiet midgame', () => {
    const moves = [
      { x: 0, y: 0, side: 'X' as const, at: 0 },
      { x: 1, y: 0, side: 'O' as const, at: 1 },
      { x: 0, y: 1, side: 'X' as const, at: 2 },
      { x: 2, y: 1, side: 'O' as const, at: 3 },
      { x: 1, y: 2, side: 'X' as const, at: 4 },
      { x: 3, y: 2, side: 'O' as const, at: 5 },
    ]
    const t0 = performance.now()
    chooseBotMove(moves, 'X', { mode: 'full', level: 'prelude' })
    expect(performance.now() - t0).toBeLessThan(150)
  })
})
