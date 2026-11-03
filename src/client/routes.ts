import { SUDOKU_CODE_LEN } from '@/src/sudoku/constants'

/** Where a room lives: Sudoku codes are 5 chars, Caro codes 6. */
export const roomPath = (code: string) => (code.length === SUDOKU_CODE_LEN ? `/s/${code}` : `/r/${code}`)
