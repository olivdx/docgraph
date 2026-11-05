import { BOARD_MAX, BOARD_MIN, type Cell, type Move, type Side } from './types';

/**
 * Caro bot. Rules: 5+ in a row wins unless BOTH ends are blocked (opponent stone or board edge).
 *
 * The board is 100×100 (BOARD_MIN..BOARD_MAX), but the bot works on a local window: the stones'
 * bounding box grown by WINDOW_MARGIN cells, clamped to the board. Candidates are empty cells within
 * distance 2 of a stone and inside the window. Cells outside the window but on the board read as
 * EMPTY in pattern evaluation (there are no stones there); only cells beyond the board read as
 * blocked — so the window never creates a phantom edge.
 *
 * Pattern evaluation works on an 11-cell line window centred on a candidate cell. Every window is
 * classified recursively (five → four → three → two) by asking "how many / which empty cells turn
 * this into the next level", where a five only counts if it is not blocked on both ends. That keeps
 * the blocked-ends rule exact for gapped shapes too. Classifications are memoised per window code.
 */

import type { BotLevel } from '@/src/tournament/types'

export type BotOptions = {
  mode: 'full' | 'fast'
  /** Defaults from `level` (duel when omitted). */
  timeBudgetMs?: number
  level?: BotLevel
  rng?: () => number
}

export interface BotStrength {
  maxDepth: number
  timeBudgetMs: number
  vcf: boolean
  vct: boolean
}

export const strengthForLevel = (level: BotLevel): BotStrength => {
  switch (level) {
    case 'prelude':
      return { maxDepth: 2, timeBudgetMs: 80, vcf: false, vct: false }
    case 'gauntlet':
      return { maxDepth: 6, timeBudgetMs: 700, vcf: true, vct: true }
    default:
      return { maxDepth: 4, timeBudgetMs: 250, vcf: true, vct: false }
  }
}

/** ≥ 7 keeps every pattern window (candidate ±5, candidate ≤ 2 from a stone) inside the window. */
const WINDOW_MARGIN = 8;
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

const sideCode = (s: Side) => (s === 'X' ? 1 : 2);

/** Number of directions that form a four (closed or open) for the last scored cell. */
let lastFours = 0;

/** Value of `side` (1|2) playing at empty window cell (x,y) (window coordinates). */
function cellScore(e: Engine, x: number, y: number, side: number): number {
  const { b, w, h } = e;
  // Window-coordinate bounds of the real board: beyond them is blocked; window-outside is empty.
  const minX = BOARD_MIN - e.x0;
  const maxX = BOARD_MAX - e.x0;
  const minY = BOARD_MIN - e.y0;
  const maxY = BOARD_MAX - e.y0;
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
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) digit = xx < minX || yy < minY || xx > maxX || yy > maxY ? 2 : 0;
      else {
        const v = b[yy * w + xx];
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
  /** Window origin (board coordinates) and size. Window cell index = (y - y0) * w + (x - x0). */
  x0: number;
  y0: number;
  w: number;
  h: number;
  b: Int8Array; // 0 empty, 1 X, 2 O
  near: Int16Array; // stones within Chebyshev distance 2
  cand = new Set<number>(); // cells with near > 0 (occupied ones are skipped by gen)
  score: Float64Array; // move score by cell index; shared by nested gen calls
  deadline = Infinity;
  checkTime = false;

  constructor(moves: Move[]) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const m of moves) {
      minX = Math.min(minX, m.x);
      maxX = Math.max(maxX, m.x);
      minY = Math.min(minY, m.y);
      maxY = Math.max(maxY, m.y);
    }
    this.x0 = Math.max(BOARD_MIN, minX - WINDOW_MARGIN);
    this.y0 = Math.max(BOARD_MIN, minY - WINDOW_MARGIN);
    this.w = Math.min(BOARD_MAX, maxX + WINDOW_MARGIN) - this.x0 + 1;
    this.h = Math.min(BOARD_MAX, maxY + WINDOW_MARGIN) - this.y0 + 1;
    this.b = new Int8Array(this.w * this.h);
    this.near = new Int16Array(this.w * this.h);
    this.score = new Float64Array(this.w * this.h);
    for (const m of moves) this.place(this.idx(m.x, m.y), sideCode(m.side));
  }

  idx(x: number, y: number): number {
    return (y - this.y0) * this.w + (x - this.x0);
  }

  toCell(idx: number): Cell {
    const lx = idx % this.w;
    return { x: this.x0 + lx, y: this.y0 + (idx - lx) / this.w };
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
    const { w, h, near, cand } = this;
    const x0 = idx % w;
    const y0 = (idx - x0) / w;
    for (let y = Math.max(0, y0 - 2); y <= Math.min(h - 1, y0 + 2); y++)
      for (let x = Math.max(0, x0 - 2); x <= Math.min(w - 1, x0 + 2); x++) {
        const i = y * w + x;
        near[i] += delta;
        if (near[i] === 0) cand.delete(i);
        else if (delta > 0 && near[i] === delta) cand.add(i);
      }
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
      score: this.score,
    };
    const { b, w } = this;
    const scoreBuf = this.score;
    for (const idx of this.cand) {
      if (b[idx] !== EMPTY) continue;
      const x = idx % w;
      const y = (idx - x) / w;
      const a = cellScore(this, x, y, me);
      const myFours = lastFours;
      const d = cellScore(this, x, y, opp);
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

// ---- search --------------------------------------------------------------------------------
const WIN = 1e12;
const BRANCH = 12;
const VCF_DEPTH = 10;
const VCT_DEPTH = 8;

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

/** True if playing at (x,y) in window coords gives `me` an open three on any line. */
function createsOpen3(e: Engine, x: number, y: number, me: number): boolean {
  const minX = BOARD_MIN - e.x0;
  const maxX = BOARD_MAX - e.x0;
  const minY = BOARD_MIN - e.y0;
  const maxY = BOARD_MAX - e.y0;
  for (let d = 0; d < 4; d++) {
    const dx = DIRS[d][0];
    const dy = DIRS[d][1];
    let code = 0;
    for (let i = 0; i < 10; i++) {
      const k = i < 5 ? i - 5 : i - 4;
      const xx = x + dx * k;
      const yy = y + dy * k;
      let digit: number;
      if (xx < 0 || yy < 0 || xx >= e.w || yy >= e.h) digit = xx < minX || yy < minY || xx > maxX || yy > maxY ? 2 : 0;
      else {
        const v = e.b[yy * e.w + xx];
        digit = v === EMPTY ? 0 : v === me ? 1 : 2;
      }
      code += digit * POW3[i];
    }
    if (level(code) === OPEN3) return true;
  }
  return false;
}

/** Cells where `me` creates an open three (not already open four / five). */
function open3Moves(e: Engine, me: number, g: Gen): number[] {
  const { b, w } = e;
  const out: number[] = [];
  for (const idx of g.cells.slice(0, 2 * BRANCH)) {
    if (b[idx] !== EMPTY) continue;
    const x = idx % w;
    const y = (idx - x) / w;
    const a = cellScore(e, x, y, me);
    if (a >= W_OPEN4) continue;
    if (createsOpen3(e, x, y, me)) out.push(idx);
  }
  return out;
}

function threatSquares(e: Engine, me: number): number[] {
  const g = e.gen(3 - me);
  return [...new Set([...g.oppFive, ...g.oppOpen4])];
}

/**
 * Victory by continuous threats: fours and open threes until the opponent faces a double threat.
 * Returns the first move of a winning sequence, or -1.
 */
function vct(e: Engine, me: number, depth: number): number {
  if (e.checkTime && performance.now() > e.deadline) throw new Timeout();
  const g = e.gen(me);
  if (g.myFive.length > 0) return g.myFive[0];
  if (g.oppFive.length > 0) return -1;
  if (g.myOpen4.length > 0) return g.myOpen4[0];
  if (depth <= 0) return -1;
  const tries = byScore([...g.myFour, ...open3Moves(e, me, g)], g.score);
  for (const idx of tries) {
    e.place(idx, me);
    try {
      const reply = e.gen(3 - me);
      if (reply.myFive.length > 0) continue;
      const forced = threatSquares(e, me);
      if (forced.length >= 2) return idx;
      if (forced.length === 0) continue;
      if (forced.length > 3) continue;
      for (const block of forced) {
        e.place(block, 3 - me);
        try {
          if (vct(e, me, depth - 1) >= 0) return idx;
        } finally {
          e.remove(block);
        }
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

/** Nearest empty board cell to (0,0) (ring by ring); only used when no candidate exists. */
function firstEmpty(moves: Move[]): Cell {
  const taken = new Set(moves.map((m) => `${m.x},${m.y}`));
  const reach = Math.max(-BOARD_MIN, BOARD_MAX);
  for (let r = 0; r <= reach; r++)
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
        if (x < BOARD_MIN || y < BOARD_MIN || x > BOARD_MAX || y > BOARD_MAX) continue;
        if (!taken.has(`${x},${y}`)) return { x, y };
      }
  return { x: 0, y: 0 }; // board full: unreachable in play (bot-vs-bot games are capped)
}

export function chooseBotMove(moves: Move[], side: Side, opts: BotOptions): Cell {
  if (moves.length === 0) return { x: 0, y: 0 };
  const e = new Engine(moves);
  const toCell = (idx: number) => e.toCell(idx);
  const me = sideCode(side);
  const g = e.gen(me);
  const s = Float64Array.from(g.score); // copy: nested searches reuse the shared buffer

  // No stone neighbourhood free (practically impossible on a 100×100 board).
  if (g.cells.length === 0) return firstEmpty(moves);
  // Pre-checks: win now, block a win, make an open four, block an open four (fast).
  if (g.myFive.length > 0) return toCell(pick(g.myFive, s, opts.rng));
  if (g.oppFive.length > 0) return toCell(pick(g.oppFive, s, opts.rng));
  if (g.myOpen4.length > 0) return toCell(pick(g.myOpen4, s, opts.rng));

  if (opts.mode === 'fast') {
    if (g.oppOpen4.length > 0) return toCell(pick(g.oppOpen4, s, opts.rng));
    return toCell(pick(g.cells, s, opts.rng));
  }

  const level = opts.level ?? 'duel';
  const strength = strengthForLevel(level);
  const budget = opts.timeBudgetMs ?? strength.timeBudgetMs;
  const start = performance.now();
  e.checkTime = true;

  const runVcfAttack = () => {
    e.deadline = start + (strength.vct ? budget * (80 / 700) : budget / 5);
    return vcf(e, me, VCF_DEPTH);
  };
  const runVcfDefense = (root: number[]) => {
    e.deadline = start + (strength.vct ? budget * (200 / 700) : budget / 2);
    if (vcf(e, 3 - me, VCF_DEPTH) < 0) return root;
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
    if (safe.length === 1) return safe;
    if (safe.length > 0) return safe.slice(0, BRANCH);
    return root;
  };
  const runVctAttack = () => {
    e.deadline = start + budget * (340 / 700);
    return vct(e, me, VCT_DEPTH);
  };
  const runVctDefense = (root: number[]) => {
    e.deadline = start + budget * (480 / 700);
    if (vct(e, 3 - me, VCT_DEPTH) < 0) return root;
    const pool = byScore([...root, ...g.myFour, ...g.cells.slice(0, 2 * BRANCH)], s);
    const safe: number[] = [];
    for (const idx of pool) {
      e.place(idx, me);
      try {
        if (vct(e, 3 - me, VCT_DEPTH) < 0) safe.push(idx);
      } finally {
        e.remove(idx);
      }
    }
    if (safe.length === 1) return safe;
    if (safe.length > 0) return safe.slice(0, BRANCH);
    return root;
  };

  // Full: iterative-deepening negamax over the root candidates.
  let root = searchMoves(g);
  if (root.length === 1) return toCell(root[0]);

  if (strength.vcf) {
    try {
      const win = runVcfAttack();
      if (win >= 0) return toCell(win);
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
    }
    try {
      root = runVcfDefense(root);
      if (root.length === 1) return toCell(root[0]);
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
    }
  }

  if (strength.vct) {
    try {
      const win = runVctAttack();
      if (win >= 0) return toCell(win);
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
    }
    try {
      root = runVctDefense(root);
      if (root.length === 1) return toCell(root[0]);
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
    }
  }

  e.deadline = start + budget;
  let bestMove = root[0];
  for (let depth = 1; depth <= strength.maxDepth; depth++) {
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
