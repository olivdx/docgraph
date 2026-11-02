import { describe, it, expect } from 'vitest';
import { BOARD_SIZE, type Move, type Side } from '@/src/game/types';
import { buildBoard, findWin, isInside, sideToMove } from '@/src/game/rules';

const mv = (x: number, y: number, side: Side): Move => ({ x, y, side, at: 0 });
const row = (x0: number, x1: number, y: number, side: Side): Move[] => {
  const out: Move[] = [];
  for (let x = x0; x <= x1; x++) out.push(mv(x, y, side));
  return out;
};
const check = (moves: Move[]) => {
  const board = buildBoard(moves);
  return findWin(board, moves[moves.length - 1]);
};

describe('findWin', () => {
  it('open five wins', () => {
    expect(check(row(5, 9, 10, 'X'))?.length).toBe(5);
  });
  it('five blocked both ends by O is not a win', () => {
    expect(check([mv(4, 10, 'O'), mv(10, 10, 'O'), ...row(5, 9, 10, 'X')])).toBeNull();
  });
  it('five blocked one end wins', () => {
    expect(check([mv(4, 10, 'O'), ...row(5, 9, 10, 'X')])?.length).toBe(5);
  });
  it('board edge counts as block', () => {
    expect(check([mv(5, 3, 'O'), ...row(0, 4, 3, 'X')])).toBeNull();
  });
  it('edge + open other end wins', () => {
    expect(check(row(0, 4, 3, 'X'))?.length).toBe(5);
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
});

describe('helpers', () => {
  it('sideToMove alternates starting with X', () => {
    expect(sideToMove([])).toBe('X');
    expect(sideToMove([mv(0, 0, 'X')])).toBe('O');
    expect(sideToMove([mv(0, 0, 'X'), mv(1, 0, 'O')])).toBe('X');
  });
  it('isInside rejects 30 and -1', () => {
    expect(isInside(BOARD_SIZE, 0)).toBe(false);
    expect(isInside(0, 30)).toBe(false);
    expect(isInside(-1, 0)).toBe(false);
    expect(isInside(0, 0)).toBe(true);
    expect(isInside(29, 29)).toBe(true);
  });
});
