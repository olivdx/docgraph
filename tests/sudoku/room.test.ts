import { describe, expect, it } from 'vitest'
import { GAME_MS, PENALTY_MS } from '@/src/sudoku/constants'
import {
  cancelSudoku,
  createSudokuRoom,
  enterDigit,
  giveUp,
  isActiveSudoku,
  joinSudoku,
  leaveSudoku,
  ranking,
  setDifficulty,
  settleSudoku,
  startSudoku,
} from '@/src/sudoku/room'
import type { SudokuRoom } from '@/src/sudoku/types'
import { toSudokuView } from '@/src/sudoku/views'
import { RoomError } from '@/src/tournament/types'
import { mulberry, user } from '../tournament/helpers'

const T0 = 1_800_000_000_000

function started(n = 3): SudokuRoom {
  let r = createSudokuRoom({ code: 'ABCDE', host: user(1), now: T0 })
  for (let i = 2; i <= n; i++) r = joinSudoku(r, user(i), T0)
  return startSudoku(r, 'u1', T0, mulberry(3))
}

const empties = (r: SudokuRoom) => [...r.puzzle!].flatMap((c, i) => (c === '0' ? [i] : []))
const right = (r: SudokuRoom, cell: number) => Number(r.solution![cell])
const wrong = (r: SudokuRoom, cell: number) => (right(r, cell) % 9) + 1

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof RoomError) return e.code
    throw e
  }
  return 'none'
}

describe('sudoku lobby', () => {
  it('join is idempotent and closes at Start; host cannot leave; cancel/difficulty are host-only', () => {
    let r = createSudokuRoom({ code: 'ABCDE', host: user(1), now: T0 })
    expect(r.name).toBe("User's Sudoku")
    r = joinSudoku(r, user(2), T0)
    expect(joinSudoku(r, user(2), T0)).toBe(r)
    expect(code(() => leaveSudoku(r, 'u1'))).toBe('host_must_cancel')
    expect(code(() => cancelSudoku(r, 'u2', T0))).toBe('not_host')
    expect(code(() => setDifficulty(r, 'u2', 'hard'))).toBe('not_host')
    expect(setDifficulty(r, 'u1', 'hard').difficulty).toBe('hard')
    expect(leaveSudoku(r, 'u2').players).toHaveLength(1)
    const s = startSudoku(r, 'u1', T0, mulberry(1))
    expect(code(() => joinSudoku(s, user(3), T0))).toBe('not_lobby')
  })

  it('needs 2 players to start; everyone gets the puzzle and a 30-minute deadline', () => {
    const solo = createSudokuRoom({ code: 'ABCDE', host: user(1), now: T0 })
    expect(code(() => startSudoku(solo, 'u1', T0, mulberry(1)))).toBe('too_few_players')
    const r = started()
    expect(r.status).toBe('playing')
    expect(r.players.every((p) => p.grid === r.puzzle && p.deadlineAt === T0 + GAME_MS)).toBe(true)
  })
})

describe('sudoku play', () => {
  it('correct digit locks in; wrong digit is not kept and costs 30 s; retries are not charged twice', () => {
    let r = started()
    const [a, b] = empties(r)
    r = enterDigit(r, 'u2', a, right(r, a), 1, T0 + 1000)
    expect(r.players[1].grid[a]).toBe(String(right(r, a)))
    expect(code(() => enterDigit(r, 'u2', a, right(r, a), 2, T0 + 1000))).toBe('occupied')
    r = enterDigit(r, 'u2', b, wrong(r, b), 2, T0 + 2000)
    expect(r.players[1].grid[b]).toBe('0')
    expect(r.players[1].mistakes).toBe(1)
    expect(r.players[1].deadlineAt).toBe(T0 + GAME_MS - PENALTY_MS)
    expect(r.players[1].lastEntry).toMatchObject({ seq: 2, correct: false })
    expect(enterDigit(r, 'u2', b, wrong(r, b), 2, T0 + 3000)).toBe(r)
  })

  it('first to solve wins at once; the others are stopped', () => {
    let r = started()
    let seq = 0
    for (const c of empties(r)) r = enterDigit(r, 'u3', c, right(r, c), ++seq, T0 + seq)
    expect(r.status).toBe('finished')
    expect(r.winnerId).toBe('u3')
    expect(r.players.filter((p) => p.outReason === 'stopped')).toHaveLength(2)
    expect(isActiveSudoku(r, 'u1')).toBe(false)
  })

  it('on time-out, most correct cells wins; then fewer mistakes', () => {
    let r = started()
    const [a, b, c] = empties(r)
    r = enterDigit(r, 'u1', a, right(r, a), 1, T0 + 10)
    r = enterDigit(r, 'u2', a, right(r, a), 1, T0 + 10)
    r = enterDigit(r, 'u2', b, right(r, b), 2, T0 + 20)
    r = enterDigit(r, 'u3', a, right(r, a), 1, T0 + 10)
    r = enterDigit(r, 'u3', c, wrong(r, c), 2, T0 + 15)
    r = enterDigit(r, 'u3', b, right(r, b), 3, T0 + 20)
    const s = settleSudoku(r, T0 + GAME_MS).room
    expect(s.status).toBe('finished')
    expect(s.winnerId).toBe('u2')
    expect(ranking(s).map((x) => [x.userId, x.place, x.cells])).toEqual([
      ['u2', 1, 2],
      ['u3', 2, 2],
      ['u1', 3, 1],
    ])
  })

  it('penalties can run a clock out early; give up frees the player; all done ends the room', () => {
    let r = started(2)
    const cell = empties(r)[0]
    const late = T0 + GAME_MS - PENALTY_MS + 1
    r = enterDigit(r, 'u1', cell, wrong(r, cell), 1, late)
    expect(r.players[0].outReason).toBe('timeout')
    expect(isActiveSudoku(r, 'u1')).toBe(false)
    expect(isActiveSudoku(r, 'u2')).toBe(true)
    expect(code(() => giveUp(r, 'u1', late))).toBe('not_playing')
    r = giveUp(r, 'u2', late)
    expect(r.status).toBe('finished')
  })

  it('the solution never reaches a client before the room finishes', () => {
    const r = started()
    for (const who of ['u1', 'outsider']) {
      const v = toSudokuView(r, who, T0, '')
      expect(v.solution).toBeNull()
      expect(JSON.stringify(v)).not.toContain(r.solution!)
    }
    expect(toSudokuView(r, 'outsider', T0, '').puzzle).toBeNull()
    expect(toSudokuView(r, 'outsider', T0, '').you).toBeNull()
    const done = settleSudoku(r, T0 + GAME_MS).room
    expect(toSudokuView(done, 'outsider', T0 + GAME_MS, '').solution).toBe(r.solution)
  })
})
