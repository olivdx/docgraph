import { BOARD_SIZE, type Cell, type Move, type Side } from './types';

type Board = (Side | null)[][];

export function isInside(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

export function buildBoard(moves: Move[]): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array<Side | null>(BOARD_SIZE).fill(null));
  for (const m of moves) board[m.y][m.x] = m.side;
  return board;
}

export function sideToMove(moves: Move[]): Side {
  return moves.length % 2 === 0 ? 'X' : 'O';
}

const DIRECTIONS: [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export function findWin(board: Board, last: Move): Cell[] | null {
  const { side } = last;
  const blocked = (x: number, y: number) => !isInside(x, y) || (board[y][x] !== null && board[y][x] !== side);
  for (const [dx, dy] of DIRECTIONS) {
    let x0 = last.x;
    let y0 = last.y;
    while (isInside(x0 - dx, y0 - dy) && board[y0 - dy][x0 - dx] === side) {
      x0 -= dx;
      y0 -= dy;
    }
    const chain: Cell[] = [];
    let x = x0;
    let y = y0;
    while (isInside(x, y) && board[y][x] === side) {
      chain.push({ x, y });
      x += dx;
      y += dy;
    }
    // (x, y) is now the cell just beyond the far end
    if (chain.length >= 5 && !(blocked(x0 - dx, y0 - dy) && blocked(x, y))) return chain;
  }
  return null;
}
