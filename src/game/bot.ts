import { BOARD_SIZE, type Cell, type Move, type Side } from './types';

/**
 * Caro bot. Rules: 5+ in a row wins unless BOTH ends are blocked (opponent stone or board edge).
 *
 * Pattern evaluation works on an 11-cell line window centred on a candidate cell. Every window is
 * classified recursively (five → four → three → two) by asking "how many / which empty cells turn
 * this into the next level", where a five only counts if it is not blocked on both ends. That keeps
 * the blocked-ends rule exact for gapped shapes too. Classifications are memoised per window code.
 */

export type BotOptions = { mode: 'full' | 'fast'; timeBudgetMs?: number; rng?: () => number };

const N = BOARD_SIZE;
const CENTER = Math.floor(N / 2);
const EMPTY = 0;
const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

// ---- line pattern levels -------------------------------------------------------------------
const NONE = 0;
const TWO = 1; // closed two
const OPEN2 = 2;
const THREE = 3; // closed three
const OPEN3 = 4;
const FOUR = 5; // closed four: exactly one completion square
const OPEN4 = 6; // two or more completion squares
const FIVE = 7;

const W_FIVE = 1e9;
const W_OPEN4 = 1e7;
const W_DOUBLE3 = 1e6; // two open threes at once (no renju restrictions in caro)
const LEVEL_WEIGHT = [0, 50, 500, 1e3, 5e4, 1e5, W_OPEN4, W_FIVE];

// Window: offsets -5..-1 → digits 0..4, offsets 1..5 → digits 5..9 (base 3: 0 empty, 1 own, 2 blocked).
const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683];
const memo = new Int8Array(59049).fill(-1);

function hasFive(code: number): boolean {
  const cells = new Array<number>(11);
  let c = code;
  for (let i = 0; i < 10; i++) {
    cells[i < 5 ? i : i + 1] = c % 3;
    c = Math.floor(c / 3);
  }
  cells[5] = 1;
  let l = 5;
  while (l > 0 && cells[l - 1] === 1) l--;
  let r = 5;
  while (r < 10 && cells[r + 1] === 1) r++;
  if (r - l + 1 < 5) return false;
  // Beyond the window the board is unknown; treat as open.
  const leftBlocked = l > 0 && cells[l - 1] === 2;
  const rightBlocked = r < 10 && cells[r + 1] === 2;
  return !(leftBlocked && rightBlocked);
}

function level(code: number): number {
  const cached = memo[code];
  if (cached >= 0) return cached;
  let result: number;
  if (hasFive(code)) {
    result = FIVE;
  } else {
    let fives = 0;
    let best = NONE;
    let c = code;
    for (let i = 0; i < 10; i++) {
      const digit = c % 3;
      c = Math.floor(c / 3);
      if (digit !== EMPTY) continue;
      const lv = level(code + POW3[i]);
      if (lv === FIVE) fives++;
      else if (lv > best) best = lv;
    }
    if (fives >= 2) result = OPEN4;
    else if (fives === 1) result = FOUR;
    else if (best === OPEN4) result = OPEN3;
    else if (best === FOUR) result = THREE;
    else if (best === OPEN3) result = OPEN2;
    else if (best === THREE) result = TWO;
    else result = NONE;
  }
  memo[code] = result;
  return result;
}

// ---- board helpers -------------------------------------------------------------------------
type Board = Int8Array; // index y*N+x; 0 empty, 1 X, 2 O

const sideCode = (s: Side) => (s === 'X' ? 1 : 2);

/** Number of directions that form a four (closed or open) for the last scored cell. */
let lastFours = 0;

/** Value of `side` (1|2) playing at empty cell (x,y). */
function cellScore(b: Board, x: number, y: number, side: number): number {
  let sum = 0;
  let fours = 0;
  let open3 = 0;
  let five = false;
  for (let d = 0; d < 4; d++) {
    const dx = DIRS[d][0];
    const dy = DIRS[d][1];
    let code = 0;
    for (let i = 0; i < 10; i++) {
      const k = i < 5 ? i - 5 : i - 4;
      const xx = x + dx * k;
      const yy = y + dy * k;
      let digit: number;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) digit = 2;
      else {
        const v = b[yy * N + xx];
        digit = v === EMPTY ? 0 : v === side ? 1 : 2;
      }
      code += digit * POW3[i];
    }
    const lv = level(code);
    if (lv === FIVE) five = true;
    else if (lv >= FOUR) fours++;
    else if (lv === OPEN3) open3++;
    sum += LEVEL_WEIGHT[lv];
  }
  lastFours = fours;
  if (five) return W_FIVE + sum;
  if (fours >= 2 || (fours >= 1 && open3 >= 1)) return Math.max(sum, W_OPEN4);
  if (open3 >= 2) return Math.max(sum, W_DOUBLE3);
  return sum;
}

type Gen = {
  cells: number[]; // candidate indices sorted by move score desc
  myFive: number[];
  oppFive: number[];
  myOpen4: number[];
  oppOpen4: number[];
  myFour: number[];
  attackSum: number;
  defendSum: number;
  score: Float64Array; // move score (attack + 0.9 × defence) by cell index; shared buffer
};

const CAP = 1e6; // cap per-cell contributions to the static evaluation

class Engine {
  b: Board = new Int8Array(N * N);
  near = new Int16Array(N * N);
  deadline = Infinity;
  checkTime = false;

  constructor(moves: Move[]) {
    for (const m of moves) this.place(m.y * N + m.x, sideCode(m.side));
  }

  place(idx: number, side: number) {
    this.b[idx] = side;
    this.bumpNear(idx, 1);
  }

  remove(idx: number) {
    this.b[idx] = EMPTY;
    this.bumpNear(idx, -1);
  }

  private bumpNear(idx: number, delta: number) {
    const x0 = idx % N;
    const y0 = (idx - x0) / N;
    for (let y = Math.max(0, y0 - 2); y <= Math.min(N - 1, y0 + 2); y++)
      for (let x = Math.max(0, x0 - 2); x <= Math.min(N - 1, x0 + 2); x++) this.near[y * N + x] += delta;
  }

  /** Scores every candidate for side `me` and collects threat squares. */
  gen(me: number): Gen {
    const opp = 3 - me;
    const g = {
      cells: [] as number[],
      myFive: [] as number[],
      oppFive: [] as number[],
      myOpen4: [] as number[],
      oppOpen4: [] as number[],
      myFour: [] as number[],
      attackSum: 0,
      defendSum: 0,
      score: scoreBuf,
    };
    const b = this.b;
    for (let idx = 0; idx < N * N; idx++) {
      if (b[idx] !== EMPTY || this.near[idx] === 0) continue;
      const x = idx % N;
      const y = (idx - x) / N;
      const a = cellScore(b, x, y, me);
      const myFours = lastFours;
      const d = cellScore(b, x, y, opp);
      if (a >= W_FIVE) g.myFive.push(idx);
      else if (a >= W_OPEN4) g.myOpen4.push(idx);
      if (myFours > 0) g.myFour.push(idx);
      if (d >= W_FIVE) g.oppFive.push(idx);
      else if (d >= W_OPEN4) g.oppOpen4.push(idx);
      g.attackSum += Math.min(a, CAP);
      g.defendSum += Math.min(d, CAP);
      scoreBuf[idx] = a + 0.9 * d;
      g.cells.push(idx);
    }
    g.cells.sort((p, q) => scoreBuf[q] - scoreBuf[p] || p - q);
    return g;
  }
}

const scoreBuf = new Float64Array(N * N);

// ---- search --------------------------------------------------------------------------------
const WIN = 1e12;
const MAX_DEPTH = 4;
const BRANCH = 12;
const VCF_DEPTH = 10;

class Timeout extends Error {}

function byScore(cells: number[], score: Float64Array): number[] {
  return [...new Set(cells)].sort((p, q) => score[q] - score[p] || p - q);
}

/** Moves to search at a node with no immediate win/loss. */
function searchMoves(g: Gen): number[] {
  if (g.oppOpen4.length > 0) {
    // Opponent threatens an open four: block one of its squares, or counter with a four of our own.
    return byScore([...g.oppOpen4, ...g.myFour], g.score);
  }
  return g.cells.slice(0, BRANCH);
}

function negamax(e: Engine, depth: number, alpha: number, beta: number, me: number, ply: number): number {
  if (e.checkTime && performance.now() > e.deadline) throw new Timeout();
  const g = e.gen(me);
  if (g.myFive.length > 0) return WIN - ply;
  if (g.oppFive.length >= 2) return -(WIN - ply - 1);
  let moves: number[];
  if (g.oppFive.length === 1) {
    moves = g.oppFive;
  } else {
    if (g.myOpen4.length > 0) return WIN - ply - 2;
    if (depth <= 0) return g.attackSum - g.defendSum;
    moves = searchMoves(g);
  }
  if (moves.length === 0) return 0;
  // Forced single replies don't consume depth (bounded: each one fills a square).
  const nextDepth = moves.length === 1 && ply < 16 ? depth : depth - 1;
  let best = -Infinity;
  for (const idx of moves) {
    e.place(idx, me);
    let v: number;
    try {
      v = -negamax(e, nextDepth, -beta, -alpha, 3 - me, ply + 1);
    } finally {
      e.remove(idx);
    }
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Victory by continuous fours: `me` keeps making fours (each forces the single block) until a
 * double threat appears. Returns the first move of a winning sequence, or -1.
 */
function vcf(e: Engine, me: number, depth: number): number {
  if (e.checkTime && performance.now() > e.deadline) throw new Timeout();
  const g = e.gen(me);
  if (g.myFive.length > 0) return g.myFive[0];
  if (g.oppFive.length > 0) return -1; // must defend; not a pure VCF position
  if (g.myOpen4.length > 0) return g.myOpen4[0];
  if (depth <= 0) return -1;
  const fours = g.myFour.slice();
  for (const idx of fours) {
    e.place(idx, me);
    try {
      const reply = e.gen(3 - me);
      if (reply.myFive.length > 0) continue; // our four let the opponent win first
      if (reply.oppFive.length >= 2) return idx;
      if (reply.oppFive.length === 0) continue;
      const block = reply.oppFive[0];
      e.place(block, 3 - me);
      try {
        if (vcf(e, me, depth - 1) >= 0) return idx;
      } finally {
        e.remove(block);
      }
    } finally {
      e.remove(idx);
    }
  }
  return -1;
}

function pick(cells: number[], score: Float64Array, rng?: () => number): number {
  const sorted = byScore(cells, score);
  if (!rng) return sorted[0];
  const top = sorted.filter((c) => score[c] === score[sorted[0]]);
  return top[Math.floor(rng() * top.length) % top.length];
}

const toCell = (idx: number): Cell => ({ x: idx % N, y: Math.floor(idx / N) });

export function chooseBotMove(moves: Move[], side: Side, opts: BotOptions): Cell {
  if (moves.length === 0) return { x: CENTER, y: CENTER };
  const e = new Engine(moves);
  const me = sideCode(side);
  const g = e.gen(me);
  const s = Float64Array.from(g.score); // copy: nested searches reuse the shared buffer

  if (g.cells.length === 0) {
    // No stone neighbourhood free (practically impossible): first empty square.
    const idx = e.b.indexOf(EMPTY);
    return toCell(idx >= 0 ? idx : 0);
  }
  // Pre-checks: win now, block a win, make an open four, block an open four (fast).
  if (g.myFive.length > 0) return toCell(pick(g.myFive, s, opts.rng));
  if (g.oppFive.length > 0) return toCell(pick(g.oppFive, s, opts.rng));
  if (g.myOpen4.length > 0) return toCell(pick(g.myOpen4, s, opts.rng));

  if (opts.mode === 'fast') {
    if (g.oppOpen4.length > 0) return toCell(pick(g.oppOpen4, s, opts.rng));
    return toCell(pick(g.cells, s, opts.rng));
  }

  // Full: iterative-deepening negamax over the root candidates.
  let root = searchMoves(g);
  if (root.length === 1) return toCell(root[0]);
  const budget = opts.timeBudgetMs ?? 250;
  const start = performance.now();
  // A forced win by continuous fours beats any heuristic choice (capped at a fifth of the budget).
  e.deadline = start + budget / 5;
  e.checkTime = true;
  try {
    const win = vcf(e, me, VCF_DEPTH);
    if (win >= 0) return toCell(win);
  } catch (err) {
    if (!(err instanceof Timeout)) throw err;
  }
  // If the opponent would have a VCF on their move, keep only moves that refute it.
  e.deadline = start + budget / 2;
  try {
    if (vcf(e, 3 - me, VCF_DEPTH) >= 0) {
      const pool = byScore([...root, ...g.myFour, ...g.cells.slice(0, 2 * BRANCH)], s);
      const safe: number[] = [];
      for (const idx of pool) {
        e.place(idx, me);
        try {
          if (vcf(e, 3 - me, VCF_DEPTH) < 0) safe.push(idx);
        } finally {
          e.remove(idx);
        }
      }
      if (safe.length === 1) return toCell(safe[0]);
      if (safe.length > 0) root = safe.slice(0, BRANCH);
    }
  } catch (err) {
    if (!(err instanceof Timeout)) throw err;
  }
  e.deadline = start + budget;
  let bestMove = root[0];
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    e.checkTime = depth > 1;
    let alpha = -Infinity;
    let depthBest = root[0];
    try {
      for (const idx of root) {
        e.place(idx, me);
        let v: number;
        try {
          v = -negamax(e, depth - 1, -Infinity, -alpha, 3 - me, 1);
        } finally {
          e.remove(idx);
        }
        if (v > alpha) {
          alpha = v;
          depthBest = idx;
        }
      }
    } catch (err) {
      if (err instanceof Timeout) break;
      throw err;
    }
    bestMove = depthBest;
    if (alpha >= WIN - 100) break; // forced win found
    root = [depthBest, ...root.filter((c) => c !== depthBest)];
  }
  return toCell(bestMove);
}
