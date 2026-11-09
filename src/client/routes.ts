import { BATTLE_CODE_LEN } from '@/src/battleship/constants'
import { SUDOKU_CODE_LEN } from '@/src/sudoku/constants'

/** Where a room lives: Battleship codes are 4 chars, Sudoku 5, Caro 6. */
export function roomPath(code: string): string {
  if (code.length === BATTLE_CODE_LEN) return `/b/${code}`
  if (code.length === SUDOKU_CODE_LEN) return `/s/${code}`
  return `/r/${code}`
}
