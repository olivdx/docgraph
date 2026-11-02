import { describe, it, expect } from 'vitest';
import { type Cell, type Move, type Side } from '@/src/game/types';
import { buildBoard, findWin, isInside } from '@/src/game/rules';
import { chooseBotMove } from '@/src/game/bot';

const mv = (x: number, y: number, side: Side): Move => ({ x, y, side, at: 0 });
const row = (x0: number, x1: number, y: number, side: Side): Move[] => {
  const out: Move[] = [];
  for (let x = x0; x <= x1; x++) out.push(mv(x, y, side));
  return out;
};

// Deterministic PRNG for reproducible games.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniformly random empty cell adjacent (Chebyshev 1) to any stone; center on an empty board. */
function randomMove(moves: Move[], rng: () => number): Cell {
  if (moves.length === 0) return { x: 15, y: 15 };
  const board = buildBoard(moves);
  const seen = new Set<number>();
  const cells: Cell[] = [];
  for (const m of moves) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = m.x + dx;
        const y = m.y + dy;
        if (!isInside(x, y) || board[y][x] !== null || seen.has(y * 100 + x)) continue;
        seen.add(y * 100 + x);
        cells.push({ x, y });
      }
    }
  }
  return cells[Math.floor(rng() * cells.length)];
}

type Player = (moves: Move[], side: Side) => Cell;

/** Plays a full game (X moves first) and returns the winner, or null on a draw / move cap. */
function playGame(px: Player, po: Player, maxMoves = 400): Side | null {
  const moves: Move[] = [];
  for (let i = 0; i < maxMoves; i++) {
    const side: Side = i % 2 === 0 ? 'X' : 'O';
    const c = (side === 'X' ? px : po)(moves, side);
    const board = buildBoard(moves);
    if (!isInside(c.x, c.y) || board[c.y][c.x] !== null) throw new Error(`illegal move ${c.x},${c.y} by ${side}`);
    const m = mv(c.x, c.y, side);
    moves.push(m);
    board[c.y][c.x] = side;
    if (findWin(board, m)) return side;
  }
  return null;
}

const inSet = (c: Cell, set: Cell[]) => set.some((s) => s.x === c.x && s.y === c.y);

describe('chooseBotMove', () => {
  it('empty board → center', () => {
    expect(chooseBotMove([], 'X', { mode: 'full' })).toEqual({ x: 15, y: 15 });
    expect(chooseBotMove([], 'X', { mode: 'fast' })).toEqual({ x: 15, y: 15 });
  });

  it('takes immediate open win', () => {
    const moves = [mv(5, 5, 'X'), mv(20, 20, 'X'), mv(5, 20, 'X'), mv(20, 5, 'X'), mv(25, 25, 'X'), ...row(10, 13, 10, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(inSet(chooseBotMove(moves, 'O', { mode }), [{ x: 9, y: 10 }, { x: 14, y: 10 }])).toBe(true);
    }
  });

  it('does not "win" into a both-blocked five', () => {
    // (14,5) would make O(10..14,5) with X on both ends — not a win. (14,12) is a real win.
    const moves = [mv(9, 5, 'X'), ...row(10, 13, 5, 'O'), mv(15, 5, 'X'), mv(9, 12, 'X'), ...row(10, 13, 12, 'O'), mv(20, 20, 'X'), mv(22, 22, 'X'), mv(24, 20, 'X'), mv(3, 25, 'X')];
    for (const mode of ['full', 'fast'] as const) {
      expect(chooseBotMove(moves, 'O', { mode })).toEqual({ x: 14, y: 12 });
    }
  });

  it('blocks opponent four', () => {
    const moves = [...row(5, 8, 5, 'X'), mv(20, 20, 'O'), mv(22, 23, 'O'), mv(18, 25, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(inSet(chooseBotMove(moves, 'O', { mode }), [{ x: 4, y: 5 }, { x: 9, y: 5 }])).toBe(true);
    }
  });

  it('blocks open three', () => {
    const moves = [...row(5, 7, 5, 'X'), mv(20, 20, 'O'), mv(23, 22, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(inSet(chooseBotMove(moves, 'O', { mode }), [{ x: 4, y: 5 }, { x: 8, y: 5 }])).toBe(true);
    }
  });

  it('never returns an occupied or outside cell (corner pressure)', () => {
    const moves = [mv(0, 0, 'X'), mv(1, 0, 'O'), mv(0, 1, 'X'), mv(1, 1, 'O'), mv(29, 29, 'X'), mv(28, 29, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      const c = chooseBotMove(moves, 'X', { mode });
      expect(isInside(c.x, c.y)).toBe(true);
      expect(buildBoard(moves)[c.y][c.x]).toBeNull();
    }
  });

  // Reduced search budget (40ms) keeps the 20 games fast; random play is trivially beaten anyway.
  it('beats a random mover 20/20 as O and as X', () => {
    const rng = mulberry32(12345);
    const bot: Player = (moves, side) => chooseBotMove(moves, side, { mode: 'full', timeBudgetMs: 40 });
    const rand: Player = (moves) => randomMove(moves, rng);
    let wins = 0;
    for (let g = 0; g < 10; g++) if (playGame(bot, rand) === 'X') wins++;
    for (let g = 0; g < 10; g++) if (playGame(rand, bot) === 'O') wins++;
    expect(wins).toBe(20);
  }, 60_000);

  // Reduced search budget (80ms) for the full bot keeps this loop efficient.
  it('beats fast mode in ≥ 7 of 10 games when full plays O', () => {
    let wins = 0;
    for (let g = 0; g < 10; g++) {
      const rng = mulberry32(1000 + g);
      const fast: Player = (moves, side) => chooseBotMove(moves, side, { mode: 'fast', rng });
      const full: Player = (moves, side) => chooseBotMove(moves, side, { mode: 'full', timeBudgetMs: 80 });
      if (playGame(fast, full) === 'O') wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(7);
  }, 120_000);

  /** 40 random adjacent stones around the center with no five on the board. */
  function midgame(seed: number): Move[] {
    const rng = mulberry32(seed);
    for (;;) {
      const moves: Move[] = [];
      let ok = true;
      for (let i = 0; i < 40 && ok; i++) {
        const c = randomMove(moves, rng);
        const m = mv(c.x, c.y, i % 2 === 0 ? 'X' : 'O');
        moves.push(m);
        if (findWin(buildBoard(moves), m)) ok = false;
      }
      if (ok) return moves;
    }
  }

  it('full move under 400ms on a 40-stone midgame', () => {
    // Seed 795 gives a quiet position (no forcing threats), so the full iterative-deepening search runs.
    const moves = midgame(795);
    const t0 = performance.now();
    const c = chooseBotMove(moves, 'X', { mode: 'full' });
    const dt = performance.now() - t0;
    expect(buildBoard(moves)[c.y][c.x]).toBeNull();
    expect(dt).toBeLessThan(400);
  });

  it('fast mode under 20ms', () => {
    const moves = midgame(795);
    chooseBotMove(moves, 'X', { mode: 'fast', rng: mulberry32(1) }); // warm-up (JIT + pattern cache)
    const t0 = performance.now();
    const c = chooseBotMove(moves, 'X', { mode: 'fast', rng: mulberry32(2) });
    const dt = performance.now() - t0;
    expect(buildBoard(moves)[c.y][c.x]).toBeNull();
    expect(dt).toBeLessThan(20);
  });
});
