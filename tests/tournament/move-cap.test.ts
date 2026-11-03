import { describe, it, expect, vi } from 'vitest'
import type { Cell, Move } from '@/src/game/types'

// A bot that never makes five: stones on an isolated lattice (every other cell), one per move.
vi.mock('@/src/game/bot', () => ({
  chooseBotMove: (moves: Move[]): Cell => {
    const k = moves.length
    return { x: -50 + 2 * (k % 50), y: -50 + 2 * Math.floor(k / 50) }
  },
}))

import { createRoom, joinRoom, markReady, resign, settleRoom, startRoom, playMove } from '@/src/tournament/room'
import { MAX_BOT_GAME_MOVES } from '@/src/tournament/constants'
import type { Room } from '@/src/tournament/types'
import { mulberry, user } from './helpers'

const T0 = 1_000_000
const START = T0 + 100
const rng = mulberry(42)
const isBot = (r: Room, id: string | null) => r.players.find((p) => p.userId === id)?.isBot ?? false

function startedRoom(humans: number, seed: number): Room {
  let r = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
  for (let i = 1; i < humans; i++) r = joinRoom(r, user(i), T0 + i)
  return startRoom(r, 'u0', START, mulberry(seed))
}

describe('move cap (board_full)', () => {
  it('is 900 moves', () => {
    expect(MAX_BOT_GAME_MOVES).toBe(900)
  })

  it('a bot-vs-bot game without a winner stops at 900 moves: board_full, X wins', () => {
    // Same setup as match.test: 5 humans, seed 3 → slots 0 and 1 are human-vs-bot; humans resign.
    let r = startedRoom(5, 3)
    const s0 = r.matches.find((m) => m.round === 0 && m.slot === 0)!
    const s1 = r.matches.find((m) => m.round === 0 && m.slot === 1)!
    r = markReady(r, s0.id, s0.X!, START, rng)
    r = resign(r, s0.id, s0.X!, START + 100, rng)
    r = markReady(r, s1.id, s1.X!, START + 200, rng)
    r = resign(r, s1.id, s1.X!, START + 300, rng)
    const bb = r.matches.find((m) => m.round === 1 && m.slot === 0)!
    expect(isBot(r, bb.X) && isBot(r, bb.O)).toBe(true)
    expect(bb.status).toBe('finished')
    expect(bb.endReason).toBe('board_full')
    expect(bb.winner).toBe('X')
    expect(bb.moves).toHaveLength(900)
  })

  it('a due bot move in a human-vs-bot game at the cap finishes board_full instead of moving', () => {
    let r = startedRoom(3, 5)
    const m0 = r.matches.find((m) => isBot(r, m.a) || isBot(r, m.b))!
    expect(isBot(r, m0.O)).toBe(true)
    r = markReady(r, m0.id, m0.X!, START, rng)
    r = playMove(r, m0.id, m0.X!, { x: 1, y: 1 }, 0, START + 1000, rng)
    const m = r.matches.find((x) => x.id === m0.id)!
    // Pad the game to 901 stones (O, the bot, to move) on an isolated lattice.
    m.moves = Array.from({ length: 901 }, (_, k) => ({
      x: -49 + 2 * (k % 49),
      y: -49 + 2 * Math.floor(k / 49),
      side: k % 2 === 0 ? ('X' as const) : ('O' as const),
      at: START,
    }))
    const due = m.botMoveDueAt!
    const after = settleRoom(r, { [m0.X!]: due }, due, rng).room.matches.find((x) => x.id === m0.id)!
    expect(after.status).toBe('finished')
    expect(after.endReason).toBe('board_full')
    expect(after.winner).toBe('X')
    expect(after.moves).toHaveLength(901)
  })
})
