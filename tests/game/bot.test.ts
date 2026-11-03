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
  if (moves.length === 0) return { x: 0, y: 0 };
  const board = buildBoard(moves);
  const seen = new Set<string>();
  const cells: Cell[] = [];
  for (const m of moves) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = m.x + dx;
        const y = m.y + dy;
        if (!isInside(x, y) || board.get(x, y) !== null || seen.has(`${x},${y}`)) continue;
        seen.add(`${x},${y}`);
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
    if (!isInside(c.x, c.y) || board.get(c.x, c.y) !== null) throw new Error(`illegal move ${c.x},${c.y} by ${side}`);
    const m = mv(c.x, c.y, side);
    moves.push(m);
    board.set(c.x, c.y, side);
    if (findWin(board, m)) return side;
  }
  return null;
}

const inSet = (c: Cell, set: Cell[]) => set.some((s) => s.x === c.x && s.y === c.y);

describe('chooseBotMove', () => {
  it('empty board → (0,0)', () => {
    expect(chooseBotMove([], 'X', { mode: 'full' })).toEqual({ x: 0, y: 0 });
    expect(chooseBotMove([], 'X', { mode: 'fast' })).toEqual({ x: 0, y: 0 });
  });

  it('takes immediate open win', () => {
    const moves = [mv(-10, -10, 'X'), mv(5, 5, 'X'), mv(-10, 5, 'X'), mv(5, -10, 'X'), mv(10, 10, 'X'), ...row(-5, -2, -5, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(inSet(chooseBotMove(moves, 'O', { mode }), [{ x: -6, y: -5 }, { x: -1, y: -5 }])).toBe(true);
    }
  });

  it('does not "win" into a both-blocked five', () => {
    // (-1,-10) would make O(-5..-1,-10) with X on both ends — not a win. (-1,-3) is a real win.
    const moves = [mv(-6, -10, 'X'), ...row(-5, -2, -10, 'O'), mv(0, -10, 'X'), mv(-6, -3, 'X'), ...row(-5, -2, -3, 'O'), mv(5, 5, 'X'), mv(7, 7, 'X'), mv(9, 5, 'X'), mv(-12, 10, 'X')];
    for (const mode of ['full', 'fast'] as const) {
      expect(chooseBotMove(moves, 'O', { mode })).toEqual({ x: -1, y: -3 });
    }
  });

  it('blocks opponent four', () => {
    const moves = [...row(-10, -7, -10, 'X'), mv(5, 5, 'O'), mv(7, 8, 'O'), mv(3, 10, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(inSet(chooseBotMove(moves, 'O', { mode }), [{ x: -11, y: -10 }, { x: -6, y: -10 }])).toBe(true);
    }
  });

  it('blocks open three', () => {
    const moves = [...row(-10, -8, -10, 'X'), mv(5, 5, 'O'), mv(8, 7, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(inSet(chooseBotMove(moves, 'O', { mode }), [{ x: -11, y: -10 }, { x: -7, y: -10 }])).toBe(true);
    }
  });

  it('never returns an occupied or outside cell (corner pressure)', () => {
    const moves = [mv(-50, -50, 'X'), mv(-49, -50, 'O'), mv(-50, -49, 'X'), mv(-49, -49, 'O'), mv(49, 49, 'X'), mv(48, 49, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      const c = chooseBotMove(moves, 'X', { mode });
      expect(isInside(c.x, c.y)).toBe(true);
      expect(buildBoard(moves).get(c.x, c.y)).toBeNull();
    }
  });

  it('no phantom edge at the old 30×30 boundary: a five ending at x = 30..34 is open', () => {
    // X four 30..33 closed by O at 29: (34,0) wins only if (35,0) is empty, not an edge.
    const right = [mv(29, 0, 'O'), ...row(30, 33, 0, 'X'), mv(0, 0, 'O'), mv(-5, 8, 'O'), mv(5, -8, 'O')];
    // X four -4..-1 closed by O at 0: (-5,5) wins only if (-6,5) is empty.
    const left = [mv(0, 5, 'O'), ...row(-4, -1, 5, 'X'), mv(20, 20, 'O'), mv(-20, 20, 'O'), mv(20, -20, 'O')];
    for (const mode of ['full', 'fast'] as const) {
      expect(chooseBotMove(right, 'X', { mode })).toEqual({ x: 34, y: 0 });
      expect(chooseBotMove(left, 'X', { mode })).toEqual({ x: -5, y: 5 });
      // ...and as O the bot must block those same squares.
      expect(chooseBotMove(right, 'O', { mode })).toEqual({ x: 34, y: 0 });
      expect(chooseBotMove(left, 'O', { mode })).toEqual({ x: -5, y: 5 });
    }
  });

  it('the real board edge (-50 / 49) blocks: no "win" into edge + opponent', () => {
    // O at (-50,-20) would make O(-50..-46,-20): edge on the left, X at (-45,-20) → not a win.
    // O at (49,20) would make O(45..49,20): X at (44,20), edge on the right → not a win. (4,0) is real.
    const moves = [
      ...row(-49, -46, -20, 'O'), mv(-45, -20, 'X'),
      mv(44, 20, 'X'), ...row(45, 48, 20, 'O'),
      mv(-1, 0, 'X'), ...row(0, 3, 0, 'O'),
      mv(10, 10, 'X'), mv(-10, 10, 'X'), mv(10, -10, 'X'), mv(-10, -10, 'X'), mv(12, -12, 'X'),
    ];
    for (const mode of ['full', 'fast'] as const) {
      expect(chooseBotMove(moves, 'O', { mode })).toEqual({ x: 4, y: 0 });
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
    expect(buildBoard(moves).get(c.x, c.y)).toBeNull();
    expect(dt).toBeLessThan(400);
  });

  it('fast mode under 20ms', () => {
    const moves = midgame(795);
    chooseBotMove(moves, 'X', { mode: 'fast', rng: mulberry32(1) }); // warm-up (JIT + pattern cache)
    const t0 = performance.now();
    const c = chooseBotMove(moves, 'X', { mode: 'fast', rng: mulberry32(2) });
    const dt = performance.now() - t0;
    expect(buildBoard(moves).get(c.x, c.y)).toBeNull();
    expect(dt).toBeLessThan(20);
  });
});
