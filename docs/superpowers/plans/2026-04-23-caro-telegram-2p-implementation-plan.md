# Caro Telegram 2P Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable two-player Caro Telegram WebApp on Next.js with private room + quick match, authoritative game engine, blocked-ends win rule, timeout/reconnect handling, and ELO ranking persistence.

**Architecture:** Implement a server-authoritative realtime flow where active matches live in a focused in-memory engine and are persisted asynchronously at match end. Separate concerns into small modules (`engine`, `realtime`, `matchmaking`, `persistence`) so in-memory storage can later be swapped to Redis without rewriting rules.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, WebSocket runtime (`ws`), PostgreSQL + Prisma, Zod, Vitest.

---

## File Structure Map

- `app/page.tsx` - mobile-first game shell (board + HUD + queue/room controls).
- `app/layout.tsx` - app metadata and Telegram WebApp friendly layout setup.
- `app/api/ws/route.ts` - websocket upgrade bootstrap and connection handoff.
- `app/api/matches/history/route.ts` - fetch user match history for profile/ranking screens.
- `app/api/ranking/route.ts` - leaderboard endpoint.
- `src/server/auth/telegram.ts` - Telegram `initData` verification.
- `src/server/realtime/protocol.ts` - typed event contract (client/server payload schemas).
- `src/server/realtime/connection-manager.ts` - socket session map + room broadcast helpers.
- `src/server/game/types.ts` - game domain types and enums.
- `src/server/game/blocked-ends.ts` - win detection implementation.
- `src/server/game/engine.ts` - authoritative game state machine.
- `src/server/matchmaking/queue.ts` - quick-match FIFO queue service.
- `src/server/matchmaking/private-rooms.ts` - create/join private room service.
- `src/server/persistence/match-repository.ts` - match/move/rating persistence API.
- `src/server/persistence/elo.ts` - ELO expected score + update formula.
- `src/server/store/in-memory-state-store.ts` - default active-state storage.
- `src/server/store/state-store.ts` - `GameStateStore` interface abstraction.
- `src/client/realtime/ws-client.ts` - browser websocket client adapter.
- `src/client/state/game-store.ts` - client reducer for authoritative snapshots/events.
- `src/client/components/game-board.tsx` - large-cell board with pan/scroll.
- `src/client/components/match-controls.tsx` - quick/private room actions.
- `src/client/components/match-hud.tsx` - turn timer + reconnect countdown UI.
- `prisma/schema.prisma` - users, matches, moves, rating changes schema.
- `prisma/migrations/*` - DB migration files.
- `tests/server/game/blocked-ends.test.ts` - rule tests.
- `tests/server/game/engine.test.ts` - timer/reconnect/state tests.
- `tests/server/matchmaking/queue.test.ts` - queue pairing tests.
- `tests/server/realtime/protocol.test.ts` - schema validation tests.
- `tests/server/persistence/elo.test.ts` - ELO math tests.
- `tests/integration/realtime-match-flow.test.ts` - end-to-end server flow.
- `vitest.config.ts` - test config.
- `package.json` - add test/db/realtime dependencies and scripts.
- `docs/superpowers/specs/2026-04-23-caro-telegram-2p-design.md` - approved design input.

### Task 1: Testing + Data Foundation

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `prisma/schema.prisma`
- Create: `tests/server/persistence/elo.test.ts`
- Test: `tests/server/persistence/elo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { calculateElo } from "@/src/server/persistence/elo";

describe("calculateElo", () => {
  it("increases winner rating and decreases loser rating", () => {
    const result = calculateElo({ winnerRating: 1200, loserRating: 1200, kFactor: 32 });

    expect(result.winnerAfter).toBe(1216);
    expect(result.loserAfter).toBe(1184);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/server/persistence/elo.test.ts`
Expected: FAIL with module-not-found for `@/src/server/persistence/elo`.

- [ ] **Step 3: Write minimal implementation + tooling**

```ts
// src/server/persistence/elo.ts
export function calculateElo(input: { winnerRating: number; loserRating: number; kFactor: number }) {
  const expectedWinner = 1 / (1 + 10 ** ((input.loserRating - input.winnerRating) / 400));
  const expectedLoser = 1 - expectedWinner;

  const winnerAfter = Math.round(input.winnerRating + input.kFactor * (1 - expectedWinner));
  const loserAfter = Math.round(input.loserRating + input.kFactor * (0 - expectedLoser));

  return { winnerAfter, loserAfter };
}
```

```json
// package.json (scripts/deps excerpt)
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@prisma/client": "^6"
  },
  "devDependencies": {
    "prisma": "^6",
    "vitest": "^3"
  }
}
```

```prisma
// prisma/schema.prisma (models excerpt)
model User {
  id             String   @id @default(cuid())
  telegramUserId String   @unique
  displayName    String
  rating         Int      @default(1200)
  gamesPlayed    Int      @default(0)
  wins           Int      @default(0)
  losses         Int      @default(0)
  createdAt      DateTime @default(now())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/server/persistence/elo.test.ts`
Expected: PASS with 1 passed test.

- [ ] **Step 5: Commit**

```bash
git add package.json vitest.config.ts prisma/schema.prisma src/server/persistence/elo.ts tests/server/persistence/elo.test.ts
git commit -m "test: bootstrap vitest and elo baseline"
```

### Task 2: Rules Engine (Blocked-Ends + Core Move Validation)

**Files:**
- Create: `src/server/game/types.ts`
- Create: `src/server/game/blocked-ends.ts`
- Create: `tests/server/game/blocked-ends.test.ts`
- Test: `tests/server/game/blocked-ends.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { detectWinFromMove } from "@/src/server/game/blocked-ends";

describe("detectWinFromMove", () => {
  it("does not count five-in-row when blocked at both ends", () => {
    const board = [
      ["O", "X", "X", "X", "X", "X", "O"],
    ];

    const result = detectWinFromMove({
      board,
      x: 3,
      y: 0,
      side: "X",
    });

    expect(result.isWin).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/server/game/blocked-ends.test.ts`
Expected: FAIL with module-not-found or undefined function error.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/game/blocked-ends.ts
import type { BoardCell, Side } from "./types";

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export function detectWinFromMove(input: { board: BoardCell[][]; x: number; y: number; side: Side }) {
  for (const [dx, dy] of DIRECTIONS) {
    const segment = collectSegment(input.board, input.x, input.y, input.side, dx, dy);
    if (segment.length >= 5 && !(segment.blockedStart && segment.blockedEnd)) {
      return { isWin: true as const };
    }
  }
  return { isWin: false as const };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/server/game/blocked-ends.test.ts`
Expected: PASS and blocked-ends case green.

- [ ] **Step 5: Commit**

```bash
git add src/server/game/types.ts src/server/game/blocked-ends.ts tests/server/game/blocked-ends.test.ts
git commit -m "feat: implement blocked-ends win detection"
```

### Task 3: Authoritative Match Engine (Turn Timer + Reconnect)

**Files:**
- Create: `src/server/store/state-store.ts`
- Create: `src/server/store/in-memory-state-store.ts`
- Create: `src/server/game/engine.ts`
- Create: `tests/server/game/engine.test.ts`
- Test: `tests/server/game/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { createGameEngine } from "@/src/server/game/engine";

describe("game engine timeouts", () => {
  it("marks active turn side as loser when turn deadline expires", () => {
    const engine = createGameEngine();
    const matchId = engine.createMatchForTest();
    engine.fastForwardTurnDeadlineForTest(matchId);

    const result = engine.tick(nowMs());
    expect(result[0].endReason).toBe("turn_timeout");
  });

  it("marks disconnected player as loser after 30s grace", () => {
    const engine = createGameEngine();
    const matchId = engine.createMatchForTest();
    engine.disconnectForTest(matchId, "X");
    engine.fastForwardDisconnectDeadlineForTest(matchId);

    const result = engine.tick(nowMs());
    expect(result[0].endReason).toBe("disconnect_timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/server/game/engine.test.ts`
Expected: FAIL with missing `createGameEngine` API.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/game/engine.ts
export function createGameEngine() {
  const store = new InMemoryStateStore();
  return {
    tick(now: number) {
      return store.resolveDeadlines(now);
    },
    makeMove(input: { matchId: string; side: "X" | "O"; x: number; y: number; clientMoveNo: number }) {
      return store.applyMove(input);
    },
    // test-only helpers omitted in production exports
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/server/game/engine.test.ts`
Expected: PASS timeout + reconnect test cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/store/state-store.ts src/server/store/in-memory-state-store.ts src/server/game/engine.ts tests/server/game/engine.test.ts
git commit -m "feat: add authoritative game engine with timeout handling"
```

### Task 4: Matchmaking + Realtime Protocol

**Files:**
- Create: `src/server/realtime/protocol.ts`
- Create: `src/server/realtime/connection-manager.ts`
- Create: `src/server/matchmaking/queue.ts`
- Create: `src/server/matchmaking/private-rooms.ts`
- Create: `app/api/ws/route.ts`
- Create: `tests/server/matchmaking/queue.test.ts`
- Create: `tests/server/realtime/protocol.test.ts`
- Test: `tests/server/matchmaking/queue.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { QuickMatchQueue } from "@/src/server/matchmaking/queue";

describe("QuickMatchQueue", () => {
  it("pairs players in FIFO order", () => {
    const queue = new QuickMatchQueue();
    queue.enqueue("u1");
    queue.enqueue("u2");

    expect(queue.tryPair()).toEqual({ playerA: "u1", playerB: "u2" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/server/matchmaking/queue.test.ts`
Expected: FAIL because queue class does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/matchmaking/queue.ts
export class QuickMatchQueue {
  private readonly waiting: string[] = [];

  enqueue(userId: string) {
    if (!this.waiting.includes(userId)) this.waiting.push(userId);
  }

  tryPair() {
    if (this.waiting.length < 2) return null;
    const playerA = this.waiting.shift()!;
    const playerB = this.waiting.shift()!;
    return { playerA, playerB };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/server/matchmaking/queue.test.ts tests/server/realtime/protocol.test.ts`
Expected: PASS for queue behavior and protocol schema validation.

- [ ] **Step 5: Commit**

```bash
git add src/server/realtime/protocol.ts src/server/realtime/connection-manager.ts src/server/matchmaking/queue.ts src/server/matchmaking/private-rooms.ts app/api/ws/route.ts tests/server/matchmaking/queue.test.ts tests/server/realtime/protocol.test.ts
git commit -m "feat: add matchmaking services and realtime protocol"
```

### Task 5: Telegram Auth + Persistence Wiring + Integration Flow

**Files:**
- Create: `src/server/auth/telegram.ts`
- Create: `src/server/persistence/match-repository.ts`
- Create: `app/api/ranking/route.ts`
- Create: `app/api/matches/history/route.ts`
- Create: `tests/integration/realtime-match-flow.test.ts`
- Test: `tests/integration/realtime-match-flow.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, it } from "vitest";
import { createTestServer } from "./test-server";

describe("realtime match flow", () => {
  it("finishes a quick match and persists result + elo", async () => {
    const server = await createTestServer();
    const flow = await server.quickMatchFlow();

    expect(flow.endReason).toBeDefined();
    expect(flow.ratingChanges.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/integration/realtime-match-flow.test.ts`
Expected: FAIL with missing auth/persistence wiring.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/auth/telegram.ts
export async function verifyTelegramInitData(initData: string, botToken: string) {
  if (!initData || !botToken) return { ok: false as const, reason: "missing_data" };
  // Implement official Telegram hash verification in production path.
  return { ok: true as const };
}
```

```ts
// src/server/persistence/match-repository.ts (core contract)
export interface MatchRepository {
  saveFinishedMatch(input: SaveFinishedMatchInput): Promise<void>;
  getRanking(limit: number): Promise<RankingEntry[]>;
  getUserHistory(userId: string, limit: number): Promise<MatchHistoryItem[]>;
}
```

- [ ] **Step 4: Run test suite to verify pass**

Run: `pnpm test`
Expected: PASS all unit + integration tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/telegram.ts src/server/persistence/match-repository.ts app/api/ranking/route.ts app/api/matches/history/route.ts tests/integration/realtime-match-flow.test.ts
git commit -m "feat: wire telegram auth persistence and ranking endpoints"
```

### Task 6: Mobile Gameplay UI + Client Realtime Sync

**Files:**
- Modify: `app/page.tsx`
- Create: `src/client/components/game-board.tsx`
- Create: `src/client/components/match-controls.tsx`
- Create: `src/client/components/match-hud.tsx`
- Create: `src/client/realtime/ws-client.ts`
- Create: `src/client/state/game-store.ts`
- Test: `pnpm lint`

- [ ] **Step 1: Write the failing UI state test**

```ts
import { describe, expect, it } from "vitest";
import { reduceGameEvent } from "@/src/client/state/game-store";

describe("game-store", () => {
  it("replaces state on full snapshot reconnect", () => {
    const state = reduceGameEvent(initialState, { type: "game.state", payload: snapshot });
    expect(state.matchId).toBe(snapshot.matchId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest src/client/state/game-store.test.ts`
Expected: FAIL due to missing reducer implementation.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/client/components/game-board.tsx
export function GameBoard({ board, onMove }: Props) {
  return (
    <div className="overflow-auto touch-pan-x touch-pan-y">
      <div className="grid w-max" style={{ gridTemplateColumns: `repeat(${board.length}, minmax(32px, 32px))` }}>
        {board.map((row, y) =>
          row.map((cell, x) => (
            <button key={`${x}:${y}`} className="h-8 w-8 border border-zinc-400" onClick={() => onMove(x, y)}>
              {cell ?? ""}
            </button>
          )),
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run validation**

Run: `pnpm vitest src/client/state/game-store.test.ts && pnpm lint`
Expected: PASS tests and ESLint with no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx src/client/components/game-board.tsx src/client/components/match-controls.tsx src/client/components/match-hud.tsx src/client/realtime/ws-client.ts src/client/state/game-store.ts src/client/state/game-store.test.ts
git commit -m "feat: implement mobile game ui and client realtime state sync"
```

## Final Verification Checklist

- [ ] Run: `pnpm test`
- [ ] Run: `pnpm lint`
- [ ] Run: `pnpm build`
- [ ] Manual verify on Telegram WebApp:
  - [ ] Quick match full game end.
  - [ ] Private room full game end.
  - [ ] Turn timeout loss.
  - [ ] Disconnect + reconnect under 30s.
  - [ ] Disconnect over 30s -> loss.
  - [ ] Ranking updates after match end.
