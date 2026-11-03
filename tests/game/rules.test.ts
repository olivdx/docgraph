import { describe, it, expect } from 'vitest';
import { BOARD_MAX, BOARD_MIN, type Move, type Side } from '@/src/game/types';
import { buildBoard, findWin, isInside, sideToMove } from '@/src/game/rules';

const mv = (x: number, y: number, side: Side): Move => ({ x, y, side, at: 0 });
const row = (x0: number, x1: number, y: number, side: Side): Move[] => {
  const out: Move[] = [];
  for (let x = x0; x <= x1; x++) out.push(mv(x, y, side));
  return out;
};
const col = (x: number, y0: number, y1: number, side: Side): Move[] => {
  const out: Move[] = [];
  for (let y = y0; y <= y1; y++) out.push(mv(x, y, side));
  return out;
};
const check = (moves: Move[]) => {
  const board = buildBoard(moves);
  return findWin(board, moves[moves.length - 1]);
};

describe('board range', () => {
  it('is 100×100 cells, -50..49, centred on (0,0)', () => {
    expect(BOARD_MIN).toBe(-50);
    expect(BOARD_MAX).toBe(49);
    expect(BOARD_MAX - BOARD_MIN + 1).toBe(100);
  });
});

describe('buildBoard', () => {
  it('is sparse: get returns the side or null, negative coordinates included', () => {
    const b = buildBoard([mv(-3, -7, 'X'), mv(4, 2, 'O')]);
    expect(b.get(-3, -7)).toBe('X');
    expect(b.get(4, 2)).toBe('O');
    expect(b.get(0, 0)).toBeNull();
    expect(b.get(-50, 49)).toBeNull();
    expect(b.size).toBe(2);
  });
});

describe('findWin', () => {
  it('open five wins', () => {
    expect(check(row(5, 9, 10, 'X'))?.length).toBe(5);
  });
  it('open five at negative coordinates wins', () => {
    expect(check(row(-9, -5, -10, 'X'))?.length).toBe(5);
  });
  it('five crossing the origin wins', () => {
    expect(check(row(-2, 2, 0, 'O'))?.length).toBe(5);
  });
  it('five blocked both ends by O is not a win', () => {
    expect(check([mv(4, 10, 'O'), mv(10, 10, 'O'), ...row(5, 9, 10, 'X')])).toBeNull();
  });
  it('five blocked one end wins', () => {
    expect(check([mv(4, 10, 'O'), ...row(5, 9, 10, 'X')])?.length).toBe(5);
  });
  it('no phantom edge at the old 30×30 boundary', () => {
    // Old board edges were x = -1 / x = 30; both are ordinary empty cells now.
    expect(check([mv(-3, 3, 'O'), ...row(-2, 2, 3, 'X')])?.length).toBe(5);
    expect(check([mv(34, 3, 'O'), ...row(29, 33, 3, 'X')])?.length).toBe(5);
    expect(check([mv(28, 3, 'O'), ...row(29, 33, 3, 'X')])?.length).toBe(5);
  });
  it('left edge (-50) counts as block', () => {
    expect(check([mv(-45, 3, 'O'), ...row(-50, -46, 3, 'X')])).toBeNull();
  });
  it('right edge (49) counts as block', () => {
    expect(check([mv(44, 3, 'O'), ...row(45, 49, 3, 'X')])).toBeNull();
  });
  it('top (-50) and bottom (49) edges count as block', () => {
    expect(check([mv(0, -45, 'O'), ...col(0, -50, -46, 'X')])).toBeNull();
    expect(check([mv(0, 44, 'O'), ...col(0, 45, 49, 'X')])).toBeNull();
  });
  it('edge + open other end wins', () => {
    expect(check(row(-50, -46, 3, 'X'))?.length).toBe(5);
    expect(check(row(45, 49, 3, 'X'))?.length).toBe(5);
  });
  it('six in a row with both ends blocked is not a win', () => {
    expect(check([mv(2, 2, 'O'), mv(9, 2, 'O'), ...row(3, 8, 2, 'X')])).toBeNull();
  });
  it('diagonal and anti-diagonal detected', () => {
    const d = [3, 4, 5, 6, 7].map((i) => mv(i, i, 'X'));
    expect(check(d)?.length).toBe(5);
    const a = [0, 1, 2, 3, 4].map((i) => mv(10 - i, 3 + i, 'X'));
    expect(check(a)?.length).toBe(5);
  });
  it('diagonal into the corner is blocked by both edges only when the other end is blocked', () => {
    const d = [45, 46, 47, 48, 49].map((i) => mv(i, i, 'X'));
    expect(check(d)?.length).toBe(5);
    expect(check([mv(44, 44, 'O'), ...d])).toBeNull();
  });
});

describe('helpers', () => {
  it('sideToMove alternates starting with X', () => {
    expect(sideToMove([])).toBe('X');
    expect(sideToMove([mv(0, 0, 'X')])).toBe('O');
    expect(sideToMove([mv(0, 0, 'X'), mv(1, 0, 'O')])).toBe('X');
  });
  it('isInside accepts -50..49 and rejects beyond', () => {
    expect(isInside(0, 0)).toBe(true);
    expect(isInside(-50, -50)).toBe(true);
    expect(isInside(49, 49)).toBe(true);
    expect(isInside(-1, 30)).toBe(true);
    expect(isInside(50, 0)).toBe(false);
    expect(isInside(0, 50)).toBe(false);
    expect(isInside(-51, 0)).toBe(false);
    expect(isInside(0, -51)).toBe(false);
  });
  it('isInside rejects non-integers', () => {
    expect(isInside(0.5, 0)).toBe(false);
    expect(isInside(0, NaN)).toBe(false);
    expect(isInside(Infinity, 0)).toBe(false);
  });
});
