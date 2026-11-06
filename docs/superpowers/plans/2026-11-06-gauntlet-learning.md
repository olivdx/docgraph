# Gauntlet Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot Gauntlet lưu mọi ván chơi với người vào MongoDB và tự học: nước dẫn tới thua (gặp ≥ 3 lần, điểm ≤ −3) bị loại, nước trong ván thắng được ưu tiên.

**Architecture:** Module thuần `src/game/gauntlet-learn.ts` lo chuẩn hoá thế cờ (8 đối xứng), tính delta học và lọc/bias nước theo hints. Engine `bot-gauntlet.ts` nhận `hints` đồng bộ. `RoomService` đọc hints trước settle (timeout 150 ms) và học sau mỗi write thành công (trong `after()`), qua `GauntletBookStore` (Memory + Mongo).

**Tech Stack:** TypeScript, Next.js 16 (`after` từ `next/server`), MongoDB driver, vitest (+ mongodb-memory-server cho test Mongo).

Spec: `docs/superpowers/specs/2026-11-06-gauntlet-learning-design.md`.

## Global Constraints

- Comment trong code viết bằng tiếng Anh.
- Không đổi hành vi engine khi `hints` rỗng/undefined: `tests/game/bot-gauntlet.test.ts` hiện có phải pass nguyên vẹn.
- Mọi lỗi I/O học/đọc hint chỉ `console.warn('[gauntlet-learn] ...')`, không throw ra request.
- Hằng số: `HINT_MIN_N = 3`, `HINT_BAN_W = -3`, `HINT_BONUS = 2000`, `HINT_BONUS_CAP = 20000`, `HINT_TIMEOUT_MS = 150`, `GAMES_TTL_MS = 90 * 24 * 3600 * 1000`.
- Collection: `gauntlet_book` (`_id = "<key>:<side>"`), `gauntlet_games` (`_id = "<roomCode>:<matchId>:<gameIndex>"`, TTL trên `expiresAt`).
- Chỉ học khi `resolveBotLevel(room) === 'gauntlet'`, đúng một phía là bot, `endReason ∈ {'five_in_row','resign'}`.
- Chạy test: `npx vitest run <file>`; toàn bộ: `npm test`.
- Owner yêu cầu **không commit** trong lần này: bỏ qua các bước commit, chỉ chạy test.

---

## File map

| File | Vai trò |
|---|---|
| Create `src/game/gauntlet-learn.ts` | canonical key, types, `deltasFromGame`, `filterByHints`, `hintBonus`, `hintsFromDoc` |
| Modify `src/game/bot-gauntlet.ts` | `isForcedPosition`, `GauntletOptions.hints`, lọc + bias root |
| Modify `src/game/bot.ts:20-27, 416-422` | `BotOptions.hints` → gauntlet |
| Modify `src/tournament/match.ts:40-42, 360` | `SettleOpts.hints` → `chooseBotMove` |
| Create `src/server/gauntlet-book-store.ts` | `GauntletBookStore`, Memory + Mongo |
| Modify `src/server/db.ts:17-31` | TTL index `gauntlet_games` |
| Create `src/server/gauntlet-learning.ts` | `hintsFor`, `learnFromWrite` |
| Modify `src/server/room-service.ts:34-46, 277-323` | deps `learning`, `afterWrite`; prefetch hints; gọi afterWrite |
| Modify `src/server/http.ts:40-53` | wiring Mongo store + `after()` |
| Test `tests/game/gauntlet-learn.test.ts`, `tests/game/bot-gauntlet.test.ts`, `tests/server/gauntlet-learning.test.ts`, `tests/server/mongo-store.test.ts` | |

---

### Task 1: Canonical position + hint types (`gauntlet-learn.ts`)

**Files:**
- Create: `src/game/gauntlet-learn.ts`
- Test: `tests/game/gauntlet-learn.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HintEntry = { w: number; n: number; wins: number; losses: number }
  export type GauntletHints = Map<string, HintEntry>            // key "x,y" in board coords
  export type BookDoc = { _id: string; side: Side; moves: Record<string, HintEntry>; updatedAt: number }
  export type CanonicalPosition = { key: string; toCanon(c: Cell): Cell; fromCanon(c: Cell): Cell }
  export const cellKey = (c: Cell) => `${c.x},${c.y}`
  export const bookId = (key: string, side: Side) => `${key}:${side}`
  export function canonicalPosition(moves: Pick<Move, 'x' | 'y' | 'side'>[]): CanonicalPosition
  export function hintsFromDoc(doc: BookDoc | null, pos: CanonicalPosition): GauntletHints
  ```

- [ ] **Step 1: Viết test fail**

```ts
// tests/game/gauntlet-learn.test.ts
import { describe, expect, it } from 'vitest'
import { canonicalPosition, hintsFromDoc, type BookDoc } from '@/src/game/gauntlet-learn'
import type { Cell, Move, Side } from '@/src/game/types'

const mv = (x: number, y: number, side: Side): Move => ({ x, y, side, at: 0 })

// All 8 symmetries about (0,0): rotations by 90° and their mirrors.
const SYMS: ((c: Cell) => Cell)[] = [
  (c) => ({ x: c.x, y: c.y }),
  (c) => ({ x: -c.y, y: c.x }),
  (c) => ({ x: -c.x, y: -c.y }),
  (c) => ({ x: c.y, y: -c.x }),
  (c) => ({ x: -c.x, y: c.y }),
  (c) => ({ x: c.y, y: c.x }),
  (c) => ({ x: c.x, y: -c.y }),
  (c) => ({ x: -c.y, y: -c.x }),
]

const POS: Move[] = [mv(0, 0, 'X'), mv(1, 1, 'O'), mv(2, 0, 'X'), mv(1, -1, 'O'), mv(3, 2, 'X')]

describe('canonicalPosition', () => {
  it('gives the same key for every symmetry of a position', () => {
    const base = canonicalPosition(POS).key
    for (const s of SYMS) {
      const t = POS.map((m) => ({ ...m, ...s(m) }))
      expect(canonicalPosition(t).key).toBe(base)
    }
  })

  it('gives different keys for different positions', () => {
    const other = [...POS.slice(0, 4), mv(3, 3, 'X')]
    expect(canonicalPosition(other).key).not.toBe(canonicalPosition(POS).key)
    expect(canonicalPosition(POS).key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('round-trips cells through toCanon/fromCanon', () => {
    const pos = canonicalPosition(POS)
    for (const c of [{ x: 7, y: -3 }, { x: 0, y: 0 }, { x: -12, y: 5 }]) {
      expect(pos.fromCanon(pos.toCanon(c))).toEqual(c)
    }
  })

  it('still produces a key when a symmetry would leave the board (x = -50)', () => {
    const edge = [mv(-50, 0, 'X'), mv(-49, 1, 'O'), mv(-48, 0, 'X')]
    const pos = canonicalPosition(edge)
    expect(pos.key).toMatch(/^[0-9a-f]{16}$/)
    // Mirrored across y it must map to the same key (that symmetry keeps x = -50 in range).
    const mirrored = edge.map((m) => ({ ...m, y: -m.y }))
    expect(canonicalPosition(mirrored).key).toBe(pos.key)
  })
})

describe('hintsFromDoc', () => {
  it('returns an empty map for null and translates canonical cells to board cells', () => {
    const pos = canonicalPosition(POS)
    expect(hintsFromDoc(null, pos).size).toBe(0)
    const boardCell = { x: 4, y: 1 }
    const canon = pos.toCanon(boardCell)
    const doc: BookDoc = {
      _id: `${pos.key}:O`,
      side: 'O',
      moves: { [`${canon.x},${canon.y}`]: { w: -4, n: 3, wins: 0, losses: 3 } },
      updatedAt: 0,
    }
    const hints = hintsFromDoc(doc, pos)
    expect(hints.get('4,1')).toEqual({ w: -4, n: 3, wins: 0, losses: 3 })
  })
})
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run tests/game/gauntlet-learn.test.ts`
Expected: FAIL — `Cannot find module '@/src/game/gauntlet-learn'`

- [ ] **Step 3: Implement**

```ts
// src/game/gauntlet-learn.ts
import { BOARD_MAX, BOARD_MIN, type Cell, type Move, type Side } from './types'

/**
 * Learning support for the Gauntlet bot: positions are keyed by their canonical form (the
 * lexicographically smallest of the 8 board symmetries about (0,0)); per position and side to move
 * the book remembers how each bot move fared.
 */

export type HintEntry = { w: number; n: number; wins: number; losses: number }
/** Keyed by `cellKey` in *board* coordinates. */
export type GauntletHints = Map<string, HintEntry>
/** Stored book document; `moves` is keyed by `cellKey` in *canonical* coordinates. */
export type BookDoc = { _id: string; side: Side; moves: Record<string, HintEntry>; updatedAt: number }
export type CanonicalPosition = { key: string; toCanon(c: Cell): Cell; fromCanon(c: Cell): Cell }

export const HINT_MIN_N = 3
export const HINT_BAN_W = -3
export const HINT_BONUS = 2000
export const HINT_BONUS_CAP = 20000

export const cellKey = (c: Cell): string => `${c.x},${c.y}`
export const bookId = (key: string, side: Side): string => `${key}:${side}`

type Sym = { to: (c: Cell) => Cell; from: (c: Cell) => Cell }
// Rotations by 0/90/180/270 degrees, then the same four mirrored in x. Each entry carries its inverse.
const SYMS: Sym[] = [
  { to: (c) => ({ x: c.x, y: c.y }), from: (c) => ({ x: c.x, y: c.y }) },
  { to: (c) => ({ x: -c.y, y: c.x }), from: (c) => ({ x: c.y, y: -c.x }) },
  { to: (c) => ({ x: -c.x, y: -c.y }), from: (c) => ({ x: -c.x, y: -c.y }) },
  { to: (c) => ({ x: c.y, y: -c.x }), from: (c) => ({ x: -c.y, y: c.x }) },
  { to: (c) => ({ x: -c.x, y: c.y }), from: (c) => ({ x: -c.x, y: c.y }) },
  { to: (c) => ({ x: c.y, y: c.x }), from: (c) => ({ x: c.y, y: c.x }) },
  { to: (c) => ({ x: c.x, y: -c.y }), from: (c) => ({ x: c.x, y: -c.y }) },
  { to: (c) => ({ x: -c.y, y: -c.x }), from: (c) => ({ x: -c.y, y: -c.x }) },
]

const inside = (c: Cell) => c.x >= BOARD_MIN && c.x <= BOARD_MAX && c.y >= BOARD_MIN && c.y <= BOARD_MAX

/** FNV-1a over the string, as two independent 32-bit lanes → 16 hex chars. */
function fnv64(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    a = Math.imul(a ^ ch, 0x01000193)
    b = Math.imul(b ^ ch, 0x5bd1e995) ^ (b >>> 13)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

function serialize(cells: { x: number; y: number; side: Side }[]): string {
  const part = (side: Side) =>
    cells
      .filter((c) => c.side === side)
      .map((c) => [c.x, c.y] as const)
      .sort((p, q) => p[0] - q[0] || p[1] - q[1])
      .map(([x, y]) => `${x},${y}`)
      .join(';')
  return `X:${part('X')}|O:${part('O')}`
}

export function canonicalPosition(moves: Pick<Move, 'x' | 'y' | 'side'>[]): CanonicalPosition {
  let best: { s: string; sym: Sym } | null = null
  for (const sym of SYMS) {
    const mapped = moves.map((m) => ({ ...sym.to(m), side: m.side }))
    // A symmetry that pushes a stone off the (-50..49) board is not a symmetry of this board: skip it.
    if (!mapped.every(inside)) continue
    const s = serialize(mapped)
    if (best === null || s < best.s) best = { s, sym }
  }
  const chosen = best ?? { s: serialize(moves), sym: SYMS[0] } // identity is always inside
  return { key: fnv64(chosen.s), toCanon: chosen.sym.to, fromCanon: chosen.sym.from }
}

export function hintsFromDoc(doc: BookDoc | null, pos: CanonicalPosition): GauntletHints {
  const out: GauntletHints = new Map()
  if (!doc) return out
  for (const [k, entry] of Object.entries(doc.moves)) {
    const [x, y] = k.split(',').map(Number)
    out.set(cellKey(pos.fromCanon({ x, y })), entry)
  }
  return out
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run tests/game/gauntlet-learn.test.ts`
Expected: PASS (6 tests)

---

### Task 2: Deltas, filter, bonus (`gauntlet-learn.ts`)

**Files:**
- Modify: `src/game/gauntlet-learn.ts`
- Test: `tests/game/gauntlet-learn.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GameRecord = {
    _id: string; roomCode: string; matchId: string; gameIndex: number
    moves: Move[]; botSide: Side; winnerSide: Side; endReason: 'five_in_row' | 'resign'; createdAt: number
  }
  export type BookDelta = { key: string; side: Side; cell: string; delta: number; won: boolean }
  export const gameId = (roomCode: string, matchId: string, gameIndex: number) => `${roomCode}:${matchId}:${gameIndex}`
  export function deltasFromGame(rec: GameRecord, isForced: (moves: Move[], side: Side) => boolean, inBook: (moves: Move[], side: Side) => boolean): BookDelta[]
  export function filterByHints(cells: Cell[], hints: GauntletHints | undefined): Cell[]
  export function hintBonus(cell: Cell, hints: GauntletHints | undefined): number
  ```

- [ ] **Step 1: Thêm test fail**

```ts
// append to tests/game/gauntlet-learn.test.ts
import {
  deltasFromGame, filterByHints, hintBonus, HINT_BONUS_CAP, type GameRecord, type GauntletHints,
} from '@/src/game/gauntlet-learn'

const never = () => false
function rec(moves: Move[], botSide: Side, winnerSide: Side): GameRecord {
  return { _id: 'R:M:1', roomCode: 'R', matchId: 'M', gameIndex: 1, moves, botSide, winnerSide, endReason: 'five_in_row', createdAt: 0 }
}
// X: 0,0  O: 1,1  X: 2,0  O: 1,-1  X: 3,2  O: 4,4  (bot = O → bot moves at ply 1, 3, 5)
const GAME: Move[] = [mv(0, 0, 'X'), mv(1, 1, 'O'), mv(2, 0, 'X'), mv(1, -1, 'O'), mv(3, 2, 'X'), mv(4, 4, 'O')]

describe('deltasFromGame', () => {
  it('gives +1 to every non-forced, non-book bot move of a won game', () => {
    const d = deltasFromGame(rec(GAME, 'O', 'O'), never, never)
    expect(d.map((x) => x.delta)).toEqual([1, 1, 1])
    expect(d.every((x) => x.side === 'O' && x.won)).toBe(true)
    // keys are those of the positions *before* each bot move
    expect(d[0].key).toBe(canonicalPosition(GAME.slice(0, 1)).key)
    expect(d[2].key).toBe(canonicalPosition(GAME.slice(0, 5)).key)
  })

  it('penalises a lost game more the closer to the end (k = 3 → -5/3, -7/3, -3)', () => {
    const d = deltasFromGame(rec(GAME, 'O', 'X'), never, never)
    expect(d.map((x) => +x.delta.toFixed(4))).toEqual([-1.6667, -2.3333, -3])
    expect(d.every((x) => !x.won)).toBe(true)
  })

  it('skips book and forced positions', () => {
    const inBook = (moves: Move[]) => moves.length < 2 // ply 1 is "book"
    const isForced = (moves: Move[]) => moves.length === 5 // last bot move is "forced"
    const d = deltasFromGame(rec(GAME, 'O', 'X'), isForced, inBook)
    expect(d).toHaveLength(1)
    expect(d[0].delta).toBe(-3) // k = 1
    expect(d[0].key).toBe(canonicalPosition(GAME.slice(0, 3)).key)
  })

  it('stores the move cell in canonical coordinates', () => {
    const d = deltasFromGame(rec(GAME, 'O', 'O'), never, never)
    const pos = canonicalPosition(GAME.slice(0, 1))
    const c = pos.toCanon({ x: 1, y: 1 })
    expect(d[0].cell).toBe(`${c.x},${c.y}`)
  })
})

describe('filterByHints / hintBonus', () => {
  const cells: Cell[] = [{ x: 0, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]
  const entry = (w: number, n: number) => ({ w, n, wins: 0, losses: n })

  it('removes cells seen >= 3 times with w <= -3', () => {
    const hints: GauntletHints = new Map([['0,1', entry(-3, 3)], ['2,2', entry(-5, 2)], ['3,3', entry(-2.9, 10)]])
    expect(filterByHints(cells, hints)).toEqual([{ x: 2, y: 2 }, { x: 3, y: 3 }])
  })

  it('never removes everything', () => {
    const hints: GauntletHints = new Map([['0,1', entry(-9, 9)]])
    expect(filterByHints([{ x: 0, y: 1 }], hints)).toEqual([{ x: 0, y: 1 }])
    expect(filterByHints(cells, undefined)).toEqual(cells)
  })

  it('bonus is w * 2000, clamped, 0 when unknown', () => {
    const hints: GauntletHints = new Map([['0,1', entry(2, 2)], ['2,2', entry(-50, 50)]])
    expect(hintBonus({ x: 0, y: 1 }, hints)).toBe(4000)
    expect(hintBonus({ x: 2, y: 2 }, hints)).toBe(-HINT_BONUS_CAP)
    expect(hintBonus({ x: 3, y: 3 }, hints)).toBe(0)
    expect(hintBonus({ x: 3, y: 3 }, undefined)).toBe(0)
  })
})
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run tests/game/gauntlet-learn.test.ts`
Expected: FAIL — `deltasFromGame is not a function` (hoặc import lỗi)

- [ ] **Step 3: Implement**

```ts
// append to src/game/gauntlet-learn.ts
export type GameRecord = {
  _id: string
  roomCode: string
  matchId: string
  /** 1-based index of the game within its match (= match.games.length once recorded). */
  gameIndex: number
  moves: Move[]
  botSide: Side
  winnerSide: Side
  endReason: 'five_in_row' | 'resign'
  createdAt: number
}
export type BookDelta = { key: string; side: Side; cell: string; delta: number; won: boolean }

export const gameId = (roomCode: string, matchId: string, gameIndex: number): string =>
  `${roomCode}:${matchId}:${gameIndex}`

/**
 * One delta per bot move that was neither a book reply nor tactically forced. A won game credits
 * each such move +1; a lost game debits -(1 + 2·(i+1)/k), so the last free move carries -3.
 */
export function deltasFromGame(
  rec: GameRecord,
  isForced: (moves: Move[], side: Side) => boolean,
  inBook: (moves: Move[], side: Side) => boolean,
): BookDelta[] {
  const won = rec.winnerSide === rec.botSide
  const picked: { key: string; cell: string }[] = []
  for (let i = 0; i < rec.moves.length; i++) {
    const m = rec.moves[i]
    if (m.side !== rec.botSide) continue
    const before = rec.moves.slice(0, i)
    if (inBook(before, m.side) || isForced(before, m.side)) continue
    const pos = canonicalPosition(before)
    picked.push({ key: pos.key, cell: cellKey(pos.toCanon(m)) })
  }
  const k = picked.length
  return picked.map((p, i) => ({
    key: p.key,
    side: rec.botSide,
    cell: p.cell,
    delta: won ? 1 : -(1 + (2 * (i + 1)) / k),
    won,
  }))
}

/** Drops cells the book has condemned (n ≥ HINT_MIN_N and w ≤ HINT_BAN_W); keeps all if none would remain. */
export function filterByHints(cells: Cell[], hints: GauntletHints | undefined): Cell[] {
  if (!hints || hints.size === 0) return cells
  const kept = cells.filter((c) => {
    const h = hints.get(cellKey(c))
    return !(h && h.n >= HINT_MIN_N && h.w <= HINT_BAN_W)
  })
  return kept.length > 0 ? kept : cells
}

/** Root-score nudge for a cell: w · HINT_BONUS clamped to ±HINT_BONUS_CAP; 0 when unknown. */
export function hintBonus(cell: Cell, hints: GauntletHints | undefined): number {
  const h = hints?.get(cellKey(cell))
  if (!h) return 0
  return Math.max(-HINT_BONUS_CAP, Math.min(HINT_BONUS_CAP, h.w * HINT_BONUS))
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run tests/game/gauntlet-learn.test.ts`
Expected: PASS (13 tests)

---

### Task 3: Engine nhận hints (`bot-gauntlet.ts`, `bot.ts`)

**Files:**
- Modify: `src/game/bot-gauntlet.ts` (`GauntletOptions` ~dòng 23; `chooseGauntletMove` ~dòng 655–776)
- Modify: `src/game/bot.ts:20-27, 416-422`
- Test: `tests/game/bot-gauntlet.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // bot-gauntlet.ts
  export type GauntletOptions = { timeBudgetMs: number; rng?: () => number; hints?: GauntletHints }
  export function isForcedPosition(moves: Move[], side: Side): boolean
  // bot.ts
  export type BotOptions = { mode: 'full' | 'fast'; timeBudgetMs?: number; level?: BotLevel; rng?: () => number; hints?: GauntletHints }
  ```

- [ ] **Step 1: Thêm test fail**

```ts
// append to tests/game/bot-gauntlet.test.ts (reuse mv/row/midgame helpers already in the file)
import { isForcedPosition } from '@/src/game/bot-gauntlet'
import type { GauntletHints } from '@/src/game/gauntlet-learn'

describe('isForcedPosition', () => {
  it('is true when we can make five', () => {
    expect(isForcedPosition([...row(0, 3, 0, 'X'), ...row(0, 3, 5, 'O')], 'X')).toBe(true)
  })
  it('is true when the opponent threatens five', () => {
    expect(isForcedPosition([...row(0, 3, 0, 'X'), ...row(0, 2, 5, 'O')], 'O')).toBe(true)
  })
  it('is true when we have an open four', () => {
    // X at 1..3 open both ends is an open three; an open four is four with both ends open.
    expect(isForcedPosition([...row(1, 4, 0, 'X'), ...row(0, 2, 5, 'O')], 'X')).toBe(true)
  })
  it('is false in a quiet position', () => {
    expect(isForcedPosition([mv(0, 0, 'X'), mv(1, 1, 'O'), mv(2, 0, 'X')], 'O')).toBe(false)
  })
})

describe('chooseGauntletMove with hints', () => {
  const moves = midgame(7, 8)
  const side: Side = moves.length % 2 === 0 ? 'X' : 'O'
  const base = chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1) })

  it('plays the same move with empty hints', () => {
    expect(chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1), hints: new Map() })).toEqual(base)
  })

  it('avoids a condemned move', () => {
    const hints: GauntletHints = new Map([[`${base.x},${base.y}`, { w: -6, n: 4, wins: 0, losses: 4 }]])
    const got = chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1), hints })
    expect(got).not.toEqual(base)
  })

  it('does not avoid a move condemned on too little evidence', () => {
    const hints: GauntletHints = new Map([[`${base.x},${base.y}`, { w: -6, n: 2, wins: 0, losses: 2 }]])
    const got = chooseGauntletMove(moves, side, { timeBudgetMs: 150, rng: mulberry32(1), hints })
    expect(got).toEqual(base)
  })
})
```

Lưu ý: nếu `midgame(7, 8)` tình cờ là thế forced (bot trả lời ngay ở "Immediate tactics"), đổi seed cho tới khi `isForcedPosition(moves, side) === false`; thêm `expect(isForcedPosition(moves, side)).toBe(false)` vào đầu describe.

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run tests/game/bot-gauntlet.test.ts`
Expected: FAIL — `isForcedPosition` không export; test "avoids a condemned move" fail.

- [ ] **Step 3: Implement trong `bot-gauntlet.ts`**

Import và options:

```ts
import { filterByHints, hintBonus, type GauntletHints } from './gauntlet-learn'

export type GauntletOptions = {
  timeBudgetMs: number
  rng?: () => number
  /** Learned book for this position (board coordinates); see gauntlet-learn.ts. */
  hints?: GauntletHints
}
```

Thêm trước `chooseGauntletMove`:

```ts
/** True when the side to move must act at once: it can make five, must stop a five, or has an open four. */
export function isForcedPosition(moves: Move[], side: Side): boolean {
  const e = new GauntletEngine(moves)
  const me = side === 'X' ? 1 : 2
  const opp = 3 - me
  return e.n5[me] > 0 || e.n5[opp] > 0 || e.n4o[me] > 0
}
```

Trong `chooseGauntletMove`, ngay sau khối `if (threatDepth >= 0) { ... }` và trước `// 3. Iterative-deepening PVS`:

```ts
  // Learned book: drop condemned moves, then try the better-rated ones first (stable sort).
  const hints = opts.hints
  if (hints && hints.size > 0) {
    root = filterByHints(root.map(toCell), hints).map((c) => toIdx(c.x, c.y))
    if (root.length === 1) return toCell(root[0])
    const w = (q: number) => hints.get(`${toCell(q).x},${toCell(q).y}`)?.w ?? 0
    root = root.map((q, i) => ({ q, i })).sort((a, b) => w(b.q) - w(a.q) || a.i - b.i).map((x) => x.q)
  }
```

Trong vòng PVS gốc, đổi phần chọn `iterBest` để cộng bonus vào **điểm so sánh** nhưng không vào `alpha` dùng cho search window:

```ts
    let bestScore = -Infinity
    ...
        if (i === 0) firstValue = v
        const score = v + hintBonus(toCell(q), hints)
        if (v > alpha) alpha = v
        if (score > bestScore) {
          bestScore = score
          iterBest = q
        }
```

và trong nhánh partial iteration dùng `bestScore > firstValue + hintBonus(toCell(root[0]), hints)` thay cho `alpha > firstValue`. Khi `hints` undefined, `hintBonus` trả 0 nên `score === v` và hành vi giống cũ (vì `v > alpha` và `score > bestScore` trùng nhau khi `bestScore` theo cùng chuỗi giá trị).

- [ ] **Step 4: Implement trong `bot.ts`**

```ts
import type { GauntletHints } from './gauntlet-learn'

export type BotOptions = {
  mode: 'full' | 'fast'
  /** Defaults from `level` (duel when omitted). */
  timeBudgetMs?: number
  level?: BotLevel
  rng?: () => number
  /** Gauntlet only: learned book for this position. */
  hints?: GauntletHints
}

export function chooseBotMove(moves: Move[], side: Side, opts: BotOptions): Cell {
  if (opts.mode === 'full' && opts.level === 'gauntlet') {
    return chooseGauntletMove(moves, side, {
      timeBudgetMs: opts.timeBudgetMs ?? strengthForLevel('gauntlet').timeBudgetMs,
      rng: opts.rng,
      hints: opts.hints,
    });
  }
```

- [ ] **Step 5: Chạy test**

Run: `npx vitest run tests/game/bot-gauntlet.test.ts tests/game/gauntlet-learn.test.ts`
Expected: PASS, kể cả toàn bộ test Gauntlet cũ.

---

### Task 4: Book store (Memory + Mongo) và index

**Files:**
- Create: `src/server/gauntlet-book-store.ts`
- Modify: `src/server/db.ts:17-31`
- Test: `tests/server/mongo-store.test.ts` (thêm describe)

**Interfaces:**
- Produces:
  ```ts
  export interface GauntletBookStore {
    getBook(key: string, side: Side): Promise<BookDoc | null>
    insertGame(rec: GameRecord): Promise<boolean>
    applyDeltas(deltas: BookDelta[], now: number): Promise<void>
  }
  export class MemoryGauntletBookStore implements GauntletBookStore { games: Map<string, GameRecord>; books: Map<string, BookDoc> }
  export class MongoGauntletBookStore implements GauntletBookStore { constructor(db: Db) }
  export const GAMES_TTL_MS = 90 * 24 * 3600 * 1000
  ```

- [ ] **Step 1: Thêm test Mongo fail**

```ts
// append to tests/server/mongo-store.test.ts (uses the file's db/unavailable setup)
import { MongoGauntletBookStore } from '@/src/server/gauntlet-book-store'
import type { GameRecord } from '@/src/game/gauntlet-learn'

describe('MongoGauntletBookStore', () => {
  const rec: GameRecord = {
    _id: 'R:M:1', roomCode: 'R', matchId: 'M', gameIndex: 1, moves: [], botSide: 'O', winnerSide: 'X',
    endReason: 'five_in_row', createdAt: T0,
  }

  it('inserts a game once', async () => {
    if (unavailable) return
    const s = new MongoGauntletBookStore(db!)
    expect(await s.insertGame(rec)).toBe(true)
    expect(await s.insertGame(rec)).toBe(false)
  })

  it('upserts and increments book entries', async () => {
    if (unavailable) return
    const s = new MongoGauntletBookStore(db!)
    await s.applyDeltas([{ key: 'k1', side: 'O', cell: '1,1', delta: -2, won: false }], T0)
    await s.applyDeltas([{ key: 'k1', side: 'O', cell: '1,1', delta: 1, won: true }], T0 + 1)
    const doc = await s.getBook('k1', 'O')
    expect(doc?.moves['1,1']).toEqual({ w: -1, n: 2, wins: 1, losses: 1 })
    expect(doc?.updatedAt).toBe(T0 + 1)
    expect(await s.getBook('k1', 'X')).toBeNull()
  })
})
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `npx vitest run tests/server/mongo-store.test.ts`
Expected: FAIL — module không tồn tại (hoặc skip với cảnh báo nếu máy không tải được mongodb-memory-server; khi đó dựa vào test Memory ở Task 5).

- [ ] **Step 3: Implement store**

```ts
// src/server/gauntlet-book-store.ts
import type { Collection, Db } from 'mongodb'
import { bookId, type BookDelta, type BookDoc, type GameRecord, type HintEntry } from '@/src/game/gauntlet-learn'
import type { Side } from '@/src/game/types'

export const GAMES_TTL_MS = 90 * 24 * 3600 * 1000

export interface GauntletBookStore {
  /** Book for a canonical position and side to move, or null. Callers race it against a timeout. */
  getBook(key: string, side: Side): Promise<BookDoc | null>
  /** Stores a replay; false when this game was already recorded (same _id). */
  insertGame(rec: GameRecord): Promise<boolean>
  /** Adds each delta to its (key, side, cell) entry, creating documents as needed. */
  applyDeltas(deltas: BookDelta[], now: number): Promise<void>
}

const ZERO: HintEntry = { w: 0, n: 0, wins: 0, losses: 0 }

// ---- memory ------------------------------------------------------------------------------------

export class MemoryGauntletBookStore implements GauntletBookStore {
  readonly games = new Map<string, GameRecord>()
  readonly books = new Map<string, BookDoc>()

  async getBook(key: string, side: Side): Promise<BookDoc | null> {
    const d = this.books.get(bookId(key, side))
    return d ? structuredClone(d) : null
  }

  async insertGame(rec: GameRecord): Promise<boolean> {
    if (this.games.has(rec._id)) return false
    this.games.set(rec._id, structuredClone(rec))
    return true
  }

  async applyDeltas(deltas: BookDelta[], now: number): Promise<void> {
    for (const d of deltas) {
      const id = bookId(d.key, d.side)
      const doc = this.books.get(id) ?? { _id: id, side: d.side, moves: {}, updatedAt: now }
      const e = doc.moves[d.cell] ?? { ...ZERO }
      doc.moves[d.cell] = { w: e.w + d.delta, n: e.n + 1, wins: e.wins + (d.won ? 1 : 0), losses: e.losses + (d.won ? 0 : 1) }
      doc.updatedAt = now
      this.books.set(id, doc)
    }
  }
}

// ---- mongo -------------------------------------------------------------------------------------

type GameDoc = GameRecord & { expiresAt: Date }

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000
}

export class MongoGauntletBookStore implements GauntletBookStore {
  private books: Collection<BookDoc>
  private games: Collection<GameDoc>

  constructor(db: Db) {
    this.books = db.collection<BookDoc>('gauntlet_book')
    this.games = db.collection<GameDoc>('gauntlet_games')
  }

  async getBook(key: string, side: Side): Promise<BookDoc | null> {
    return this.books.findOne({ _id: bookId(key, side) })
  }

  async insertGame(rec: GameRecord): Promise<boolean> {
    try {
      await this.games.insertOne({ ...rec, expiresAt: new Date(rec.createdAt + GAMES_TTL_MS) })
      return true
    } catch (e) {
      if (isDuplicateKey(e)) return false
      throw e
    }
  }

  async applyDeltas(deltas: BookDelta[], now: number): Promise<void> {
    if (deltas.length === 0) return
    await this.books.bulkWrite(
      deltas.map((d) => ({
        updateOne: {
          filter: { _id: bookId(d.key, d.side) },
          update: {
            $setOnInsert: { side: d.side },
            $set: { updatedAt: now },
            $inc: {
              [`moves.${d.cell}.w`]: d.delta,
              [`moves.${d.cell}.n`]: 1,
              [`moves.${d.cell}.wins`]: d.won ? 1 : 0,
              [`moves.${d.cell}.losses`]: d.won ? 0 : 1,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    )
  }
}
```

Lưu ý: khoá `moves.<cell>` chứa dấu phẩy và dấu trừ (`"-1,2"`) — hợp lệ trong Mongo field path (chỉ `.` và `$` đầu là cấm).

- [ ] **Step 4: Thêm index trong `db.ts`**

```ts
export async function ensureIndexes(db: Db): Promise<void> {
  const rooms = db.collection('rooms')
  const presence = db.collection('presence')
  const sudoku = db.collection('sudoku_rooms')
  const gauntletGames = db.collection('gauntlet_games')
  await Promise.all([
    // ...existing indexes unchanged...
    gauntletGames.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ])
}
```

- [ ] **Step 5: Chạy test**

Run: `npx vitest run tests/server/mongo-store.test.ts`
Expected: PASS (hoặc skipped-with-warning nếu không có binary Mongo).

---

### Task 5: `GauntletLearning` service (hints + learn) với Memory store

**Files:**
- Create: `src/server/gauntlet-learning.ts`
- Test: `tests/server/gauntlet-learning.test.ts`

**Interfaces:**
- Consumes: `GauntletBookStore` (Task 4), `canonicalPosition`, `hintsFromDoc`, `deltasFromGame`, `gameId` (Task 1–2), `isForcedPosition`, `bookMove` (Task 3 / có sẵn), `resolveBotLevel`, `isBotId`, `sideToMove`.
- Produces:
  ```ts
  export const HINT_TIMEOUT_MS = 150
  export interface GauntletLearning {
    hintsFor(room: Room, m: Match): Promise<GauntletHints | undefined>
    learnFromWrite(before: Room, after: Room, now: number): Promise<void>
  }
  export function createGauntletLearning(store: GauntletBookStore, log?: (msg: string, e?: unknown) => void): GauntletLearning
  export function learnableBotSide(room: Room, m: Match): Side | null
  ```

- [ ] **Step 1: Viết test fail**

```ts
// tests/server/gauntlet-learning.test.ts
import { describe, expect, it } from 'vitest'
import { createGauntletLearning, learnableBotSide } from '@/src/server/gauntlet-learning'
import { MemoryGauntletBookStore } from '@/src/server/gauntlet-book-store'
import { createRoom, markReady, playMove, setBotLevel, setFormat, settleRoom, startRoom } from '@/src/tournament/room'
import type { Match, Room } from '@/src/tournament/types'
import type { Cell, Side } from '@/src/game/types'
import { mulberry, user } from '../tournament/helpers'

const T0 = 1_000_000
const START = T0 + 100
const rng = mulberry(42)
const isBot = (r: Room, id: string | null) => r.players.find((p) => p.userId === id)?.isBot ?? false

/** Free-play room: one human vs a bot of `level`, match playing. */
function botRoom(level: 'duel' | 'gauntlet'): Room {
  let r = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
  r = setBotLevel(setFormat(r, 'u0', 'free'), 'u0', level)
  r = startRoom(r, 'u0', START, mulberry(1))
  const m = r.matches[0]
  for (const id of [m.X, m.O]) if (id && !isBot(r, id)) r = markReady(r, m.id, id, START, rng)
  return r
}
const match = (r: Room): Match => r.matches[0]
const seen = (r: Room, at: number) => Object.fromEntries(r.players.filter((p) => !p.isBot).map((p) => [p.userId, at]))

/**
 * Scripted game: the human plays `human[i]`, the bot's due move is replaced by `bot[i]` through
 * playMove is impossible, so instead we drive both sides with playMove by making the bot's cells
 * part of a human-vs-human-like script: we simply play the human's stones and let settle play the
 * bot. For a deterministic end we give the human an unstoppable five in a row on row 10.
 */
function humanWins(r: Room): { before: Room; after: Room; at: number } {
  let at = START + 1000
  const m0 = match(r)
  const humanId = isBot(r, m0.X) ? m0.O! : m0.X!
  const line: Cell[] = [10, 11, 12, 13, 14].map((x) => ({ x, y: 10 }))
  let before = r
  for (const c of line) {
    const m = match(r)
    // settle until it is the human's turn (plays the bot's due move when needed)
    r = settleRoom(r, seen(r, at), at, rng, { fullBotMatchId: m.id }).room
    const mm = match(r)
    if (mm.status !== 'playing') break
    const side: Side = mm.X === humanId ? 'X' : 'O'
    if ((mm.moves.length % 2 === 0 ? 'X' : 'O') !== side) {
      at += 3000
      r = settleRoom(r, seen(r, at), at, rng, { fullBotMatchId: m.id }).room
    }
    before = r
    r = playMove(r, mm.id, humanId, c, match(r).moves.length, at, rng, seen(r, at), { fullBotMatchId: mm.id })
    at += 1000
  }
  return { before, after: r, at }
}

describe('learnableBotSide', () => {
  it('is the bot side for a human-vs-gauntlet match and null otherwise', () => {
    const g = botRoom('gauntlet')
    const m = match(g)
    expect(learnableBotSide(g, m)).toBe(isBot(g, m.X) ? 'X' : 'O')
    const d = botRoom('duel')
    expect(learnableBotSide(d, match(d))).toBeNull()
  })
})

describe('learnFromWrite', () => {
  it('records a human-vs-gauntlet game once and updates the book', async () => {
    const store = new MemoryGauntletBookStore()
    const learning = createGauntletLearning(store, () => {})
    const { before, after, at } = humanWins(botRoom('gauntlet'))
    expect(match(after).games).toHaveLength(1)
    await learning.learnFromWrite(before, after, at)
    expect(store.games.size).toBe(1)
    const rec = [...store.games.values()][0]
    expect(rec._id).toBe(`ABCDEF:${match(after).id}:1`)
    expect(rec.winnerSide).not.toBe(rec.botSide)
    expect(store.books.size).toBeGreaterThan(0)
    for (const doc of store.books.values()) for (const e of Object.values(doc.moves)) expect(e.w).toBeLessThan(0)
    const booksBefore = JSON.stringify([...store.books.values()])
    await learning.learnFromWrite(before, after, at) // same write again: idempotent
    expect(store.games.size).toBe(1)
    expect(JSON.stringify([...store.books.values()])).toBe(booksBefore)
  })

  it('ignores duel games', async () => {
    const store = new MemoryGauntletBookStore()
    const learning = createGauntletLearning(store, () => {})
    const { before, after, at } = humanWins(botRoom('duel'))
    await learning.learnFromWrite(before, after, at)
    expect(store.games.size).toBe(0)
  })

  it('ignores writes that end no game', async () => {
    const store = new MemoryGauntletBookStore()
    const learning = createGauntletLearning(store, () => {})
    const r = botRoom('gauntlet')
    await learning.learnFromWrite(r, r, START)
    expect(store.games.size).toBe(0)
  })
})

describe('hintsFor', () => {
  it('returns undefined when the store is too slow and hints when it answers', async () => {
    const slow = { getBook: () => new Promise<null>(() => {}), insertGame: async () => true, applyDeltas: async () => {} }
    const learning = createGauntletLearning(slow, () => {})
    const r = botRoom('gauntlet')
    const m = { ...match(r), botMoveDueAt: START + 1, moves: [
      { x: 0, y: 0, side: 'X' as const, at: 0 }, { x: 1, y: 1, side: 'O' as const, at: 0 }, { x: 2, y: 0, side: 'X' as const, at: 0 },
    ] }
    const t = Date.now()
    expect(await learning.hintsFor(r, m)).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(1000)

    const store = new MemoryGauntletBookStore()
    const quick = createGauntletLearning(store, () => {})
    expect(await quick.hintsFor(r, { ...m, botMoveDueAt: null })).toBeUndefined() // not the bot's turn
    const hints = await quick.hintsFor(r, m)
    expect(hints).toBeInstanceOf(Map)
  })
})
```

Nếu `tests/tournament/helpers.ts` không export `mulberry`/`user` với chữ ký trên, đọc file đó và dùng đúng tên có sẵn. Nếu `playMove` của `room.ts` không nhận `presence`/`opts` theo thứ tự trên, xem chữ ký tại `src/tournament/room.ts:262-280` và sửa lời gọi.

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `npx vitest run tests/server/gauntlet-learning.test.ts`
Expected: FAIL — module không tồn tại.

- [ ] **Step 3: Implement**

```ts
// src/server/gauntlet-learning.ts
import { bookMove, isForcedPosition } from '@/src/game/bot-gauntlet'
import {
  canonicalPosition, deltasFromGame, gameId, hintsFromDoc, type GameRecord, type GauntletHints,
} from '@/src/game/gauntlet-learn'
import { sideToMove } from '@/src/game/rules'
import type { Side } from '@/src/game/types'
import { isBotId } from '@/src/tournament/match'
import { resolveBotLevel, type Match, type Room } from '@/src/tournament/types'
import type { GauntletBookStore } from './gauntlet-book-store'

export const HINT_TIMEOUT_MS = 150
const LEARN_REASONS = new Set(['five_in_row', 'resign'])
const BOOK_PLIES = 3 // the static opening book answers these; nothing to look up

export interface GauntletLearning {
  /** Learned hints for the bot's pending move in `m`; undefined when not applicable, slow or failing. */
  hintsFor(room: Room, m: Match): Promise<GauntletHints | undefined>
  /** Learns from every human-vs-Gauntlet game that ended between `before` and `after`. Never throws. */
  learnFromWrite(before: Room, after: Room, now: number): Promise<void>
}

/** The bot's side when `m` is a human-vs-Gauntlet match, else null. */
export function learnableBotSide(room: Room, m: Match): Side | null {
  if (resolveBotLevel(room) !== 'gauntlet') return null
  const xBot = isBotId(room, m.X)
  const oBot = isBotId(room, m.O)
  if (xBot === oBot) return null
  return xBot ? 'X' : 'O'
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(undefined) })
  })
}

const defaultLog = (msg: string, e?: unknown) => console.warn(`[gauntlet-learn] ${msg}`, e ?? '')

export function createGauntletLearning(store: GauntletBookStore, log = defaultLog): GauntletLearning {
  return {
    async hintsFor(room, m) {
      const botSide = learnableBotSide(room, m)
      if (!botSide || m.status !== 'playing' || m.botMoveDueAt === null) return undefined
      if (m.moves.length < BOOK_PLIES || sideToMove(m.moves) !== botSide) return undefined
      const pos = canonicalPosition(m.moves)
      const doc = await withTimeout(store.getBook(pos.key, botSide), HINT_TIMEOUT_MS)
      if (doc === undefined) return undefined
      return hintsFromDoc(doc, pos)
    },

    async learnFromWrite(before, after, now) {
      try {
        for (const m of after.matches) {
          const botSide = learnableBotSide(after, m)
          if (!botSide) continue
          const prev = before.matches.find((x) => x.id === m.id)
          const prevGames = prev?.games.length ?? 0
          if (m.games.length !== prevGames + 1) continue
          if (prev && m.moves.length < prev.moves.length) continue // next game already started: replay lost
          const g = m.games[m.games.length - 1]
          if (!LEARN_REASONS.has(g.endReason)) continue
          const winnerSide: Side = g.winner === m.X ? 'X' : 'O'
          if (g.endReason === 'resign' && winnerSide !== botSide) continue // bots never resign; be safe
          const rec: GameRecord = {
            _id: gameId(after._id, m.id, m.games.length),
            roomCode: after._id,
            matchId: m.id,
            gameIndex: m.games.length,
            moves: m.moves,
            botSide,
            winnerSide,
            endReason: g.endReason as GameRecord['endReason'],
            createdAt: now,
          }
          if (!(await store.insertGame(rec))) continue
          const deltas = deltasFromGame(rec, isForcedPosition, (moves, side) => bookMove(moves, side) !== null)
          await store.applyDeltas(deltas, now)
        }
      } catch (e) {
        log('learnFromWrite failed', e)
      }
    },
  }
}
```

- [ ] **Step 4: Chạy test**

Run: `npx vitest run tests/server/gauntlet-learning.test.ts`
Expected: PASS (5 tests)

---

### Task 6: Wiring vào `RoomService`, `match.ts`, `http.ts`

**Files:**
- Modify: `src/tournament/match.ts:40-42, 354-362`
- Modify: `src/server/room-service.ts:34-46, 277-323`
- Modify: `src/server/http.ts:1-10, 40-53`
- Test: `tests/server/gauntlet-learning.test.ts` (thêm 1 describe dùng `RoomService` + memory stores)

**Interfaces:**
- Consumes: `GauntletLearning` (Task 5), `GauntletHints` (Task 1).
- Produces:
  ```ts
  // match.ts
  export interface SettleOpts { fullBotMatchId?: string | null; hints?: GauntletHints }
  // room-service.ts
  export interface RoomServiceDeps { ...; learning?: GauntletLearning; afterWrite?: (before: Room, after: Room, now: number) => void }
  ```

- [ ] **Step 1: Thêm test fail**

```ts
// append to tests/server/gauntlet-learning.test.ts
import { RoomService } from '@/src/server/room-service'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'

describe('RoomService wiring', () => {
  it('calls afterWrite with before/after on every successful write and passes hints into settle', async () => {
    const calls: [Room, Room][] = []
    let hintsAsked = 0
    const learning = {
      hintsFor: async () => { hintsAsked++; return new Map() },
      learnFromWrite: async () => {},
    }
    const rooms = new MemoryRoomStore()
    const svc = new RoomService({
      rooms, presence: new MemoryPresenceStore(), now: () => T0, rng: mulberry(3), inviteUrl: () => '',
      learning, afterWrite: (b, a) => calls.push([b, a]),
    })
    const me = { id: 'u0', name: 'User 0', avatarUrl: null }
    const view = await svc.create(me, 'room')
    expect(calls.length).toBe(0) // create() inserts, it does not go through mutate/write
    await svc.setFormat(me, view.code, 'free')
    expect(calls.length).toBe(1)
    expect(calls[0][0].version).toBeLessThan(calls[0][1].version)
    const started = await svc.start(me, view.code)
    const matchId = started.matches?.[0]?.id ?? (await rooms.get(view.code))!.matches[0].id
    await svc.match(me, view.code, matchId) // a match request: hints are looked up for the caller's match
    expect(hintsAsked).toBeGreaterThanOrEqual(1)
  })
})
```

Tên method của `RoomService` (`setFormat`, `start`, `match`, ...) và hình dạng `RoomView` lấy theo `src/server/room-service.ts:130-240`; chỉnh tên cho đúng với file.

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `npx vitest run tests/server/gauntlet-learning.test.ts`
Expected: FAIL — `learning`/`afterWrite` không có trong `RoomServiceDeps` (TS) / `calls.length` là 0.

- [ ] **Step 3: `match.ts`**

```ts
import type { GauntletHints } from '@/src/game/gauntlet-learn'

export interface SettleOpts {
  fullBotMatchId?: string | null
  /** Learned book for the scoped match's pending Gauntlet move (see gauntlet-learn.ts). */
  hints?: GauntletHints
}
```

Dòng ~360:

```ts
          const cell = chooseBotMove(m.moves, side, { mode: 'full', level: resolveBotLevel(room), rng, hints: opts?.hints })
```

- [ ] **Step 4: `room-service.ts`**

Deps:

```ts
import type { GauntletLearning } from './gauntlet-learning'

export interface RoomServiceDeps {
  // ...existing...
  /** Gauntlet learning: hints before a bot move, learning after a write. Absent → no learning. */
  learning?: GauntletLearning
  /** Called after every successful write with the room before and after it. */
  afterWrite?: (before: Room, after: Room, now: number) => void
}
```

Trong `mutate`, thay dòng `const opts = { fullBotMatchId: caller?.matchId ?? null }` bằng:

```ts
      const hints = caller && this.deps.learning ? await this.hintsFor(loaded, caller.matchId) : undefined
      const opts = { fullBotMatchId: caller?.matchId ?? null, hints }
```

Và hai chỗ write thành công:

```ts
        if (written) {
          this.notifyChanged(loaded, written)
          this.deps.afterWrite?.(loaded, written, now)
          throw e
        }
      ...
      if (saved) {
        this.notifyChanged(loaded, saved)
        this.deps.afterWrite?.(loaded, saved, now)
        return { room: saved, presence, now }
      }
```

Thêm helper:

```ts
  /** Learned hints for the caller's match when its Gauntlet bot is due to move; never throws. */
  private async hintsFor(room: Room, matchId: string): Promise<GauntletHints | undefined> {
    const m = room.matches.find((x) => x.id === matchId)
    if (!m) return undefined
    try {
      return await this.deps.learning!.hintsFor(room, m)
    } catch (e) {
      console.warn('[gauntlet-learn] hintsFor failed', e)
      return undefined
    }
  }
```

(import `GauntletHints` từ `@/src/game/gauntlet-learn`.)

- [ ] **Step 5: `http.ts`**

```ts
import { MongoGauntletBookStore } from './gauntlet-book-store'
import { createGauntletLearning } from './gauntlet-learning'

      const out = {} as Services
      const learning = createGauntletLearning(new MongoGauntletBookStore(db))
      out.caro = new RoomService({
        rooms: new MongoRoomStore(db),
        presence: new MongoPresenceStore(db),
        now: Date.now,
        rng: Math.random,
        inviteUrl: (code) => buildInviteUrl(code),
        activeElsewhere: (userId) => out.sudoku.activeCode(userId),
        notify,
        notifyMove,
        learning,
        // Learn after the response is sent; the request never waits on it.
        afterWrite: (before, after_, now) => after(() => learning.learnFromWrite(before, after_, now)),
      })
```

(đặt tên tham số `after_` để không che import `after` của Next.)

- [ ] **Step 6: Chạy toàn bộ test + lint**

Run: `npm test`
Expected: PASS toàn bộ, không có fail trong `tests/tournament/*`, `tests/game/*`, `tests/server/*`.

Run: `npx tsc --noEmit -p .` (nếu project có tsconfig build) và `npx eslint src tests`
Expected: không lỗi.

---

### Task 7: Cập nhật tài liệu

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-caro-tournament-design.md` (sau mục "Gauntlet bot engine, added 2026-11-06")

- [ ] **Step 1: Thêm mục**

```markdown
### Gauntlet learning, added 2026-11-06 (owner decision)

- Owner: the Gauntlet bot keeps every game it plays against a human and learns from it: moves that
  keep losing are dropped, moves from won games are preferred. Design: `2026-11-06-gauntlet-learning-design.md`.
- Implementation: `src/game/gauntlet-learn.ts` (canonical position over 8 symmetries, deltas,
  filter/bonus), `src/server/gauntlet-book-store.ts` (`gauntlet_book`, `gauntlet_games` with a 90-day TTL),
  `src/server/gauntlet-learning.ts` (hints before a bot move with a 150 ms cap, learning in `after()`
  following each write). Learning only for human-vs-Gauntlet games ending in five-in-a-row or a human resign.
```

- [ ] **Step 2: Chạy lại `npm test` lần cuối**

Expected: PASS.

---

## Self-review

- **Spec coverage:** §3.1 → Task 1–2; §3.2–3.3 → Task 3; §3.4 → Task 6; §3.5 → Task 4; §3.6 → Task 5; §3.7 → Task 6; §4 lỗi/timeout → Task 5 (`withTimeout`, try/catch) + Task 6 (`hintsFor` try/catch, `after()`); §5 test → mỗi task. Idempotent `_id` → Task 4/5.
- **Placeholder scan:** không còn TBD; các chỗ "chỉnh tên theo file" đều chỉ rõ file/dòng để tra.
- **Type consistency:** `GauntletHints`, `HintEntry`, `BookDoc`, `GameRecord`, `BookDelta`, `GauntletBookStore`, `GauntletLearning`, `learnableBotSide`, `isForcedPosition`, `hintsFromDoc`, `filterByHints`, `hintBonus`, `deltasFromGame`, `gameId`, `bookId`, `cellKey` dùng thống nhất qua các task.
