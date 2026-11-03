import { BOARD_MAX, BOARD_MIN, type Cell, type Move, type Side } from './types';

export function isInside(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= BOARD_MIN && y >= BOARD_MIN && x <= BOARD_MAX && y <= BOARD_MAX;
}

/** Sparse board: only occupied cells are stored. */
export class Board {
  private cells = new Map<string, Side>();

  get(x: number, y: number): Side | null {
    return this.cells.get(`${x},${y}`) ?? null;
  }

  set(x: number, y: number, side: Side): void {
    this.cells.set(`${x},${y}`, side);
  }

  get size(): number {
    return this.cells.size;
  }
}

export function buildBoard(moves: Move[]): Board {
  const board = new Board();
  for (const m of moves) board.set(m.x, m.y, m.side);
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
  const own = (x: number, y: number) => isInside(x, y) && board.get(x, y) === side;
  const blocked = (x: number, y: number) => {
    if (!isInside(x, y)) return true;
    const v = board.get(x, y);
    return v !== null && v !== side;
  };
  for (const [dx, dy] of DIRECTIONS) {
    let x0 = last.x;
    let y0 = last.y;
    while (own(x0 - dx, y0 - dy)) {
      x0 -= dx;
      y0 -= dy;
    }
    const chain: Cell[] = [];
    let x = x0;
    let y = y0;
    while (own(x, y)) {
      chain.push({ x, y });
      x += dx;
      y += dy;
    }
    // (x, y) is now the cell just beyond the far end
    if (chain.length >= 5 && !(blocked(x0 - dx, y0 - dy) && blocked(x, y))) return chain;
  }
  return null;
}
