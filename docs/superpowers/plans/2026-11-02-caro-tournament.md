# Caro Cup Tournament Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Caro Cup, a Telegram Mini App on Next.js 16 / Vercel where anyone creates a knockout Caro tournament, players sign up via room list or ref link, empty slots are filled by strong bots, and every match survives reloads.

**Architecture:** A tournament ("room") is one MongoDB document. It embeds its players and every bracket match (≤ 32 matches × ≤ 900 moves, well under 16 MB), so all game and bracket logic is pure functions over one aggregate. A thin service loads the room, runs `settleRoom` (lazy deadlines, bot moves, bracket advancement), applies the command, and saves with compare-and-set on `version`. Presence heartbeats live in a separate `presence` collection, so polling never fights the CAS. Clients poll route handlers. Identity comes from Telegram `initData` on every request.

**Tech Stack:** Next.js 16.2 App Router (route handlers + client components), React 19, TypeScript, Tailwind v4, native `mongodb` driver, Vitest 4, `mongodb-memory-server` (store tests only).

**Spec:** `docs/superpowers/specs/2026-11-02-caro-tournament-design.md`. UI look: `.superpowers/brainstorm/2751-1793605468/content/flow-v5.html`.

**Deviation from spec §6 (data model):** the spec lists separate `tournaments` and `matches` collections. This plan embeds matches in the room document and adds a `presence` collection. The fields are the same; only the placement differs. The reason is that one document means one atomic CAS per state change, which is what makes simultaneous settling safe.

## Global Constraints

- All UI text is English.
- Rules: 5+ in a row wins **unless both ends are blocked**. The board edge counts as a blocking end. Board is fixed 30×30.
- `TURN_MS = 25_000`; `RECONNECT_GRACE_MS = 30_000`; `DISCONNECT_DETECT_MS = 5_000` (forfeit when `now − lastSeen > 35_000`); `NO_SHOW_MS = 60_000`.
- `MIN_HUMANS = 2`, `MAX_PLAYERS = 32`. Bracket size is the next power of 2 ≥ humans. Bots are placed so no round-1 match is bot-vs-bot.
- Human vs bot: the human is X and moves first. Human vs human: X is random. One game per match. There is a 3rd-place match only when the bracket size ≥ 4.
- TTL: lobby rooms expire at `createdAt + 2h`; finished/cancelled rooms at `finishedAt + 10min`. `expiresAt` is a `Date` with a TTL index (`expireAfterSeconds: 0`).
- Bot "thinking" delay is uniformly random in 500–1000 ms. A full-strength bot move takes ≤ 300 ms of search. Bot-vs-bot uses `fast` mode.
- No ELO, no Prisma/Postgres, no Telegram bot messages or webhook.
- Mongo URI is built from `.env` `User` and `pass`, host `labs.wnk6exl.mongodb.net`, db `caro`. The `MONGODB_URI` env var overrides this (tests/CI). Never hard-code credentials.
- New env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_MINIAPP_SHORTNAME`. Invite URL is `https://t.me/<BOT_USERNAME>/<MINIAPP_SHORTNAME>?startapp=<CODE>`.
- Next.js 16 has breaking changes. Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `.../03-api-reference/03-file-conventions/route.md` before writing route handlers. Dynamic `params` are a Promise (`await ctx.params`).
- Room/match code alphabet: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I, L, O, 0, 1). Room codes are 6 characters; match ids are 4 characters, unique within a room.

## Review Focus

1. **Two polls settle the same expired deadline at once.** Exactly one outcome is persisted, and the second write re-reads instead of double-advancing the bracket. → Task 6 test `concurrent settles produce one result`.
2. **A player reloads during their opponent's turn and is gone ~20 s.** They are still in the game, with the board and clock unchanged. Only a gap > 35 s forfeits. → Task 4 test `presence gap of 20s does not forfeit`.
3. **The same move is sent twice** (double tap, network retry). It is applied once, and the turn does not skip. → Task 4 test `duplicate clientMoveNo is a no-op`.
4. **A move arrives after the mover's deadline but before anyone settled.** The mover loses by `turn_timeout`, and the move is rejected. → Task 4 test `late move loses by timeout`.
5. **A user opens a ref link to room B while still active in room A.** They are not auto-joined to B, and the response says where they are. → Task 6 test `join while active elsewhere is rejected with activeCode`.

---

## File Structure

```
src/game/types.ts            Side, Cell, Move, BOARD_SIZE
src/game/rules.ts            buildBoard, sideToMove, findWin, isInside
src/game/bot.ts              chooseBotMove (threat eval + alpha-beta, 'full' | 'fast')
src/tournament/constants.ts  all timing/size constants above
src/tournament/types.ts      Room, Player, Match, EndReason, RoomError
src/tournament/codes.ts      randomCode(len, rng)
src/tournament/bracket.ts    planBracket, roundName, BOT_NAMES
src/tournament/room.ts       createRoom, joinRoom, leaveRoom, cancelRoom, startRoom
src/tournament/match.ts      markReady, playMove, resign, settleRoom, isActive
src/tournament/views.ts      toRoomView, toMatchView, toRoomSummary (client-safe projections)
src/server/telegram-auth.ts  verifyInitData, authenticate(request)
src/server/db.ts             getDb (cached MongoClient), ensureIndexes
src/server/stores.ts         RoomStore/PresenceStore interfaces + Memory* + Mongo* impls
src/server/room-service.ts   RoomService (load → settle → command → CAS save, retry)
src/server/http.ts           json(), errorResponse(RoomError), getService()
app/api/me/route.ts                                  GET
app/api/rooms/route.ts                               GET list, POST create
app/api/rooms/[code]/route.ts                        GET room view
app/api/rooms/[code]/[action]/route.ts               POST join|leave|cancel|start
app/api/rooms/[code]/matches/[matchId]/route.ts      GET match view (presence + ready)
app/api/rooms/[code]/matches/[matchId]/[action]/route.ts  POST move|resign
src/client/telegram.ts       getInitData, getStartParam, ready/expand, openShare
src/client/api.ts            apiGet/apiPost (adds auth header)
src/client/use-poll.ts       usePoll(path, intervalMs) with visibility pause
src/client/marks.tsx         <XMark/>, <OMark/> thick CSS marks
src/client/board.tsx         <Board/> 30×30, pan/zoom, last-move highlight
app/layout.tsx               Telegram script, dark shell, metadata
app/globals.css              tokens from mock
app/page.tsx                 Home + boot routing
app/r/[code]/page.tsx        Lobby | Bracket | Champion by status
app/r/[code]/m/[matchId]/page.tsx  Match screen + result card
tests/...                    mirrors src/
```

---

### Task 1: Clean slate + game rules

**Files:**
- Delete: `prisma/`, `src/server/persistence/elo.ts`, `tests/server/persistence/elo.test.ts`
- Modify: `package.json` (remove `@prisma/client`, `prisma`; add `mongodb`; dev `mongodb-memory-server`), `.gitignore` (add `.superpowers/`), `vitest.config.ts` (add `resolve.alias: { '@': <repo root> }`)
- Create: `.env.example` (keys only: `User=`, `pass=`, `MONGODB_URI=`, `TELEGRAM_BOT_TOKEN=`, `TELEGRAM_BOT_USERNAME=`, `TELEGRAM_MINIAPP_SHORTNAME=`). Do **not** touch `.env`.
- Create: `src/game/types.ts`, `src/game/rules.ts`
- Test: `tests/game/rules.test.ts`

**Interfaces:**
- Produces:
  - `type Side = 'X' | 'O'`; `type Cell = { x: number; y: number }`; `type Move = Cell & { side: Side; at: number }`; `const BOARD_SIZE = 30`
  - `isInside(x: number, y: number): boolean`
  - `buildBoard(moves: Move[]): (Side | null)[][]`, indexed `[y][x]`
  - `sideToMove(moves: Move[]): Side`. X moves first.
  - `findWin(board: (Side|null)[][], last: Move): Cell[] | null` returns the full contiguous chain (≥ 5) when at least one end is open, else `null`.

- [ ] **Step 1: Remove legacy, install deps.** `pnpm remove @prisma/client prisma && pnpm add mongodb && pnpm add -D mongodb-memory-server`, delete the files listed above, add the alias and `.gitignore` line, and create `.env.example`.
- [ ] **Step 2: Write failing tests** in `tests/game/rules.test.ts`. Use the helper `mv(x,y,side)`. Each case places a chain plus blockers, then calls `findWin` with the last stone:

```ts
it('open five wins', ...)                          // X at (5..9,10) → line length 5
it('five blocked both ends by O is not a win', ...) // O(4,10), X(5..9,10), O(10,10) → null
it('five blocked one end wins', ...)               // O(4,10), X(5..9,10) → length 5
it('board edge counts as block', ...)              // X(0..4,3), O(5,3) → null
it('edge + open other end wins', ...)              // X(0..4,3), (5,3) empty → length 5
it('six in a row with both ends blocked is not a win', ...) // O(2,2), X(3..8,2), O(9,2) → null
it('diagonal and anti-diagonal detected', ...)     // (3,3)…(7,7) and (10,3)…(6,7)
it('sideToMove alternates starting with X', ...)   // [] → 'X'; one move → 'O'
it('isInside rejects 30 and -1', ...)
```

- [ ] **Step 3: Run** `pnpm test tests/game/rules.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement `src/game/types.ts` and `src/game/rules.ts`.** `findWin`: for each of the directions (1,0), (0,1), (1,1), (1,−1), extend both ways over the same side. If length ≥ 5, check the cell beyond each end: blocked = outside the board or the opponent's stone. It wins unless both are blocked.
- [ ] **Step 5: Run** `pnpm test`. Expected: all pass, and no elo test remains.
- [ ] **Step 6: Commit.** `git add -A prisma src tests package.json pnpm-lock.yaml .gitignore vitest.config.ts .env.example && git commit -m "feat: caro rules with blocked-ends win; drop prisma/elo"`

---

### Task 2: Bot AI

**Files:**
- Create: `src/game/bot.ts`
- Test: `tests/game/bot.test.ts`

**Interfaces:**
- Consumes: `Move`, `Side`, `Cell`, `buildBoard`, `findWin`, `isInside`, `BOARD_SIZE` (Task 1)
- Produces: `chooseBotMove(moves: Move[], side: Side, opts: { mode: 'full' | 'fast'; timeBudgetMs?: number; rng?: () => number }): Cell`. `timeBudgetMs` defaults to 250 for `full`. The function never returns an occupied or outside cell. On an empty board it returns (15,15).

**Approach (decided):**
- Candidates are empty cells within Chebyshev distance 2 of any stone.
- **Pattern evaluation:** scan each line (4 directions) through a candidate for both sides, and classify by stones and open ends **using the blocked-ends rule**. A shape that can only become a both-ends-blocked five is worth 0. Use these weights:
  - five: 1e9
  - open four: 1e7
  - closed four (one end open): 1e5
  - open three: 5e4
  - closed three: 1e3
  - open two: 500
  - closed two: 50
- Score a move as `attack(side) + 0.9 × defend(opponent)`. Count double threats (two fours, or four + open three) as open four.
- **`full` mode:** pre-checks first (an immediate win, then blocking the opponent's immediate win or open-four completion). Then iterative-deepening negamax with alpha-beta over the top 12 candidates by move score, up to depth 4. Stop at `timeBudgetMs` (check `performance.now()`) and return the best move of the last completed depth.
- **`fast` mode:** the pre-checks, then the single best move by move score (no search). Use `rng` for tie-breaking.

- [ ] **Step 1: Write failing tests:**

```ts
it('empty board → center', () => expect(chooseBotMove([], 'X', {mode:'full'})).toEqual({x:15,y:15}))
it('takes immediate open win', ...)        // O has (10..13,10), (9,10) & (14,10) empty → returns one of them
it('does not "win" into a both-blocked five', ...) // X(9,5) O(10..13,5) X(15,5): O to move must not count (14,5) as win; with an alternative real win elsewhere it picks the real one
it('blocks opponent four', ...)            // X has (5..8,5) open; bot O → (4,5) or (9,5)
it('blocks open three', ...)               // X has (5..7,5) open both sides, no O threats → bot plays (4,5) or (8,5)
it('beats a random mover 20/20 as O and as X', ...) // loop full games with rules; random picks any empty neighbor cell; seeded rng
it('beats fast mode in ≥ 7 of 10 games when full plays O', ...) // seeded; fast moves first as X
it('full move under 400ms on a 40-stone midgame', ...) // timing with generous margin
it('fast mode under 20ms', ...)
```

- [ ] **Step 2: Run** `pnpm test tests/game/bot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/game/bot.ts`** per the approach above.
- [ ] **Step 4: Run.** Expected: PASS. If "beats fast" is flaky, tune the weights and depth, not the test thresholds.
- [ ] **Step 5: Commit** `feat: threat-search caro bot (full/fast)`.

---

### Task 3: Bracket planning + room types

**Files:**
- Create: `src/tournament/constants.ts`, `src/tournament/types.ts`, `src/tournament/codes.ts`, `src/tournament/bracket.ts`
- Test: `tests/tournament/bracket.test.ts`

**Interfaces:**
- Produces (types, `src/tournament/types.ts`):

```ts
type RoomStatus = 'lobby' | 'running' | 'finished' | 'cancelled'
type MatchStatus = 'waiting' | 'pending' | 'playing' | 'finished'   // waiting = an entrant still TBD
type EndReason = 'five_in_row' | 'turn_timeout' | 'disconnect_timeout' | 'resign' | 'no_show' | 'board_full'
interface Player { userId: string; name: string; avatarUrl: string | null; isBot: boolean; seed: number | null; joinedAt: number }
interface Match {
  id: string; round: number; slot: number; kind: 'normal' | 'third_place'
  a: string | null; b: string | null          // bracket entrants (userIds), a = upper
  X: string | null; O: string | null          // assigned when status becomes pending
  status: MatchStatus; pendingSince: number | null; startedAt: number | null
  readyAt: { X: number | null; O: number | null }
  moves: Move[]; turnDeadlineAt: number | null; botMoveDueAt: number | null
  winner: Side | null; endReason: EndReason | null; winLine: Cell[] | null; finishedAt: number | null
}
interface Room {
  _id: string /* room code */; name: string; hostId: string; status: RoomStatus
  players: Player[]; totalRounds: number; matches: Match[]
  placements: { first: string | null; second: string | null; third: string | null }
  version: number; createdAt: number; startedAt: number | null; finishedAt: number | null; expiresAt: Date
}
class RoomError extends Error { constructor(public code: RoomErrorCode, public extra?: Record<string, unknown>) }
type RoomErrorCode = 'not_found' | 'not_lobby' | 'full' | 'not_host' | 'host_must_cancel' | 'too_few_players'
  | 'not_participant' | 'not_playing' | 'not_your_turn' | 'occupied' | 'out_of_bounds' | 'already_active' | 'conflict'
```

- `randomCode(len: number, rng: () => number): string`, using the alphabet from Global Constraints.
- `BOT_NAMES = ['Bot Alpha','Bot Bravo','Bot Charlie', … 'Bot Echo' … NATO order]`. Bot userIds are `bot:<n>`.
- `planBracket(humans: Player[], rng): { size: number; totalRounds: number; order: Player[] /* humans + bots, seeds 1..size */; }`. Round 1 match `s` is `order[2s]` vs `order[2s+1]`. Bots are only ever in the odd position of a pair (so they always face a human), and the human order is shuffled.
- `roundName(round: number, totalRounds: number, kind: Match['kind']): string`:
  - `third_place` → `'3rd Place'`
  - last round → `'Final'`
  - one before → `'Semifinal'`
  - two before → `'Quarterfinal'`
  - otherwise → `` `Round of ${2 ** (totalRounds - round)}` ``

- [ ] **Step 1: Write failing tests:**

```ts
it.each([[2,2,1],[3,4,2],[4,4,2],[5,8,3],[9,16,4],[17,32,5],[32,32,5]])('%i humans → size %i, %i rounds', ...)
it('no round-1 pair is bot vs bot for every n in 2..32', ...)
it('seeds are 1..size and unique', ...)
it('bot ids are bot:1.. and names from BOT_NAMES', ...)
it('roundName', () => { expect(roundName(0,3,'normal')).toBe('Quarterfinal'); expect(roundName(2,3,'normal')).toBe('Final');
  expect(roundName(1,3,'normal')).toBe('Semifinal'); expect(roundName(0,5,'normal')).toBe('Round of 32'); expect(roundName(2,3,'third_place')).toBe('3rd Place') })
it('randomCode uses only the alphabet', ...)
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** (and the constants file). **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: bracket planning and room types`.

---

### Task 4: Room aggregate — lobby commands, match lifecycle, settle

**Files:**
- Create: `src/tournament/room.ts`, `src/tournament/match.ts`
- Test: `tests/tournament/room.test.ts`, `tests/tournament/match.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (all pure; they return a **new** Room, never mutate; throw `RoomError`):
  - `createRoom(p: { code: string; host: { userId; name; avatarUrl }; name?: string; now: number }): Room`. Name defaults to `` `${firstWord(host.name)}'s Cup` ``, status `lobby`, `expiresAt = now + LOBBY_TTL_MS`, version 0.
  - `joinRoom(room, user, now): Room`. Idempotent if already in. Errors: `not_lobby`, `full` (32).
  - `leaveRoom(room, userId): Room`. Host gets `host_must_cancel`.
  - `cancelRoom(room, userId, now): Room`. Host only, lobby only. Sets `cancelled`, `finishedAt`, and `expiresAt = now + FINISHED_TTL_MS`.
  - `startRoom(room, userId, now, rng): Room`. Host only, `too_few_players` if humans < 2. Creates **all** matches: round 0 filled from `planBracket`; later rounds `waiting`; a `third_place` match at round `totalRounds-1`, slot 1, when size ≥ 4. Match ids come from `randomCode(4)` (unique). Round-0 matches become `pending` right away (assign sides, `pendingSince = now`).
  - `markReady(room, matchId, userId, now): Room`
  - `playMove(room, matchId, userId, cell: Cell, clientMoveNo: number, now, rng): Room`. `clientMoveNo` is the 0-based index this move will occupy. If `clientMoveNo < moves.length` and `moves[clientMoveNo]` equals the cell and side, it's a no-op. If the match is already finished because the deadline passed, the call returns the settled room (it does not throw), so the client sees the result.
  - `resign(room, matchId, userId, now): Room`
  - `settleRoom(room, presence: Record<string, number>, now, rng): { room: Room; changed: boolean }`. Runs to a fixpoint.
  - `isActive(room, userId): boolean`. True in lobby if they are a player; true while running if they are not eliminated; false otherwise.
  - `playMove`, `resign` and `markReady` call `settleRoom` first.

**Settle rules (decided, applied per match until nothing changes):**
- `waiting` → `pending` when `a` and `b` are both set. Assign sides: if exactly one is a bot, the human is X; if both are human, `rng() < 0.5 ? a : b` is X; if both are bots, a is X. Bots get `readyAt` set.
- `pending` → `playing` when both `readyAt` are set: `startedAt = now`, `turnDeadlineAt = now + TURN_MS` if a human is to move. If a bot is to move, set `botMoveDueAt = now + delay(rng)` and `turnDeadlineAt = null`.
- `pending` and `now − pendingSince > NO_SHOW_MS` → finished, `no_show`. The side that isn't ready loses. If neither is ready, the lower seed number wins.
- `playing`: collect the deadlines that are ≤ now and apply only the **earliest**:
  - turn: `turnDeadlineAt` → the side to move loses, `turn_timeout`
  - disconnect, per human side: `max(presence[uid] ?? startedAt, startedAt) + DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS` → that side loses, `disconnect_timeout`
  - bot: `botMoveDueAt` → apply `chooseBotMove(moves, side, {mode})`, check for a win, then set the next deadline
- Both bots → play the whole game right now in `fast` mode with no delays. 900 moves without a win → `board_full`, X wins.
- After any move: check for a win (`five_in_row` with `winLine`); if the board is full → `board_full` with X winning; otherwise set the next deadline as above.
- **Finished match** → advance once:
  - the winner goes to `(round+1, floor(slot/2))` in field `a` if `slot` is even, else `b`
  - if it's a semifinal (`round === totalRounds-2`), the loser goes to `third_place` (`a` for slot 0, `b` for slot 1)
- **Room finished** when the final is finished and (no 3rd-place match or it's finished):
  - set `placements`, status `finished`, `finishedAt`, `expiresAt = now + FINISHED_TTL_MS`
  - for a size-2 bracket, `third` stays null
- `changed` is true if anything differs. The service only writes when `changed`, and the service bumps `version`.

- [ ] **Step 1: Write failing tests** in `room.test.ts`: create defaults (name "Son's Cup" from "Son Duong", status lobby, expiresAt +2h); join idempotent; join 33rd → `full`; join running → `not_lobby`; non-host start → `not_host`; 1 human start → `too_few_players`; 5 humans start → 8 slots, 3 bots, 7 normal matches + 1 third_place, round-0 all `pending`, each bot is O and its human X; leave as host → `host_must_cancel`; cancel sets expiresAt +10 min.
- [ ] **Step 2: Write failing tests** in `match.test.ts` (fixture: started 2-human room → one final; helper `ready(room)` marks both):

```ts
it('pending → playing when both ready; X to move with 25s deadline', ...)
it('no-show: only X ready, now = pendingSince+60_001 → O loses no_show', ...)
it('turn timeout: X does nothing for 25_001ms → X loses turn_timeout', ...)
it('late move loses by timeout', ...)            // playMove at deadline+1 → match finished turn_timeout, move not recorded
it('presence gap of 20s does not forfeit', ...)  // presence[X]=start, now=start+20_000, X not to move → still playing
it('presence gap of 35_001ms forfeits disconnect_timeout', ...)
it('earliest deadline wins when two expired', ...) // turn deadline at t+25s, opponent disconnect at t+35s, settle at t+40s → turn_timeout
it('duplicate clientMoveNo is a no-op', ...)     // same move twice → moves.length 1, turn is O
it('wrong turn → not_your_turn; occupied → occupied; outside → out_of_bounds', ...)
it('five_in_row finishes with winLine and advances winner', ...)
it('both-blocked five does not finish', ...)
it('resign → opponent wins resign', ...)
it('human vs bot: bot move appears only after botMoveDueAt', ...) // settle at due-1 → no move; at due → 1 more move
it('bot vs bot later-round match resolves inside one settle', ...) // 3 humans + 1 bot... force: craft room where two bots meet
it('4-player bracket: semis losers meet in 3rd place; room finishes with placements', ...)
it('size-2 bracket finishes with third=null', ...)
it('isActive: eliminated player false, remaining player true, finished room false', ...)
```

- [ ] **Step 3: Run** `pnpm test tests/tournament`. Expected: FAIL.
- [ ] **Step 4: Implement** `room.ts` and `match.ts` per the rules above. Inject time and rng everywhere; no `Date.now()` or `Math.random()` inside them.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: tournament aggregate with lazy settle`.

---

### Task 5: Views + Telegram auth

**Files:**
- Create: `src/tournament/views.ts`, `src/server/telegram-auth.ts`
- Test: `tests/tournament/views.test.ts`, `tests/server/telegram-auth.test.ts`

**Interfaces:**
- Produces:
  - `toRoomSummary(room, viewerId): { code; name; hostName; status; playerCount; youAreIn: boolean; liveLabel: string | null }`
  - `toRoomView(room, viewerId, now, inviteUrl): RoomView`, which includes:
    - `code`, `name`, `status`, `isHost`, `players` (name, avatarUrl, isBot, seed, isHost)
    - `slotsIfStartedNow` and `botsIfStartedNow`
    - `rounds: { name; matches: { id; a: Entrant|null; b: Entrant|null; scoreA: 1|0|null; scoreB; status; isYours: boolean }[] }[]`, with the third-place match as its own trailing column named `'3rd Place'`
    - `yourMatch: { id; opponentName; youAre: Side } | null` (the viewer's pending/playing match)
    - `placements` as names, `inviteUrl`, `serverNow`
    - no `moves`
  - `toMatchView(room, matchId, viewerId, now, presence): MatchView`, which includes:
    - `id`, `roundName`, `status`, `you: Side | null`
    - `players: { X: {name, isBot}, O: {...} }`
    - `moves: Move[]`, `turn`, `turnRemainingMs`
    - `opponentDisconnected: boolean` and `opponentReconnectRemainingMs: number | null` (disconnected = `now − lastSeen > 5s`)
    - `winner`, `endReason`, `winLine`
    - `nextStep: 'wait' | 'next_match' | 'eliminated' | 'champion' | 'podium'`
    - `serverNow`
  - `verifyInitData(initData: string, botToken: string, nowSec: number, maxAgeSec = 86_400): TelegramUser | null`. This is the standard WebApp check:
    - `secret = HMAC_SHA256(key="WebAppData", botToken)`
    - `hash = hex(HMAC_SHA256(secret, data_check_string))`
    - `data_check_string` is the sorted `key=value` pairs (excluding `hash`) joined by `\n`
    - compare with `timingSafeEqual`
    - reject when `auth_date` is older than `maxAgeSec`
    - return `{ id: string; name: string /* first + last */; avatarUrl: string | null /* photo_url */ }`
  - `authenticate(request: Request): TelegramUser`, which throws a 401 Response:
    - normally reads the `x-telegram-init-data` header
    - when `process.env.NODE_ENV === 'development'` and the header `x-dev-user: <id>:<name>` is present, it returns that user instead

- [ ] **Step 1: Write failing tests.** Views:
  - moves are never present in RoomView
  - `isYours` is set only on the viewer's match
  - the 5-human lobby says 8 slots / 3 bots
  - MatchView `turnRemainingMs = deadline − now`
  - `opponentDisconnected` toggles at 5 s
  - `nextStep` follows this rule:
    - `wait` while the match isn't finished
    - `champion` for the final's winner
    - `podium` for the final's loser and the 3rd-place winner
    - `next_match` for a winner with another match, or a semifinal loser heading to 3rd place
    - `eliminated` otherwise (tests cover the semifinal loser → `next_match` and the 3rd-place loser → `eliminated`)
- Auth tests: build a valid initData in-test with a known token, then check:
  - it verifies and returns the user
  - a tampered `user` → null
  - an `auth_date` 2 days old → null
  - a wrong token → null
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: client views and telegram initData auth`.

---

### Task 6: Stores + RoomService

**Files:**
- Create: `src/server/db.ts`, `src/server/stores.ts`, `src/server/room-service.ts`
- Test: `tests/server/room-service.test.ts` (Memory stores), `tests/server/mongo-store.test.ts` (`mongodb-memory-server`)

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:

```ts
interface RoomStore {
  get(code: string): Promise<Room | null>
  insert(room: Room): Promise<boolean>                  // false on duplicate _id
  replace(room: Room, expectedVersion: number): Promise<boolean>  // CAS; stores room with version = expectedVersion + 1
  listOpen(limit: number): Promise<Room[]>              // status lobby|running, newest first
  findByPlayer(userId: string): Promise<Room[]>         // status lobby|running containing userId
}
interface PresenceStore { touch(code: string, userId: string, now: number): Promise<void>; get(code: string, userIds: string[]): Promise<Record<string, number>> }
class MemoryRoomStore implements RoomStore; class MemoryPresenceStore implements PresenceStore
class MongoRoomStore implements RoomStore; class MongoPresenceStore implements PresenceStore
getDb(): Promise<Db>      // global-cached MongoClient (globalThis), maxPoolSize 5
ensureIndexes(db): Promise<void>  // rooms: {expiresAt:1} TTL 0, {status:1, createdAt:-1}, {'players.userId':1}; presence: {_id} = `${code}:${userId}`, {expiresAt:1} TTL 0 (now+1h)

class RoomService {
  constructor(deps: { rooms: RoomStore; presence: PresenceStore; now: () => number; rng: () => number; inviteUrl: (code: string) => string })
  me(user): Promise<{ user: TelegramUser; active: { code: string; matchId: string | null } | null }>
  list(user): Promise<RoomSummary[]>                    // settles nothing; summaries only
  create(user, name?: string): Promise<RoomView>        // already_active if isActive elsewhere; retries code on duplicate
  getRoom(code, user): Promise<RoomView>                // settle (+ save if changed)
  join(code, user): Promise<RoomView>                   // already_active (extra.activeCode) if active in another room
  leave(code, user) / cancel(code, user) / start(code, user): Promise<RoomView>
  getMatch(code, matchId, user): Promise<MatchView>     // touch presence if participant, markReady, settle, save
  move(code, matchId, user, cell, clientMoveNo): Promise<MatchView>
  resign(code, matchId, user): Promise<MatchView>
}
```

- **Mutation loop (decided):** for up to 5 attempts:
  1. `get`
  2. read presence for the players of the `playing` matches
  3. `settleRoom`
  4. apply the command
  5. if nothing changed, return
  6. otherwise `replace(next, loaded.version)`
  7. if the CAS fails, retry from step 1
  
  After 5 failed attempts, throw `RoomError('conflict')`.
- `me` checks every room from `findByPlayer` and picks the one where `isActive` holds after settling. Its `matchId` is the viewer's `pending`/`playing` match, if any.

- [ ] **Step 1: Write failing tests** (`room-service.test.ts`, with a fake clock and seeded rng):

```ts
it('full tournament 3 humans + 1 bot reaches finished with placements', ...) // drive: start, getMatch for each human, play scripted wins, advance clock for bot
it('reload mid-match returns identical MatchView (moves, turn, remaining)', ...)
it('concurrent settles produce one result', ...)   // two getRoom calls interleaved via a store wrapper that delays replace → final room has exactly one finished match transition, version +1 per real change, winner advanced once
it('join while active elsewhere is rejected with activeCode', ...)
it('eliminated player can join another room', ...)
it('getRoom with nothing to settle does not write', ...) // spy replace count = 0
it('me routes to pending match after start', ...)
```

  `mongo-store.test.ts`:
  - `insert` duplicate → false
  - `replace` with a stale version → false
  - `listOpen` excludes finished rooms
  - `findByPlayer` works
  - `ensureIndexes` creates the TTL index with `expireAfterSeconds: 0`
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** In `db.ts`, the URI is `process.env.MONGODB_URI ?? \`mongodb+srv://${enc(User)}:${enc(pass)}@labs.wnk6exl.mongodb.net/?retryWrites=true&w=majority\``; call `ensureIndexes` once per cold start. Store `expiresAt` as a `Date`.
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: mongo stores and room service with CAS settle`.

---

### Task 7: API route handlers

**Files:**
- Create: `src/server/http.ts` and the 6 route files listed in File Structure
- Test: `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `RoomService`, `authenticate`, `RoomError`.
- Produces (all JSON; every request needs the auth header; every handler exports `export const dynamic = 'force-dynamic'`):

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/me` | | `{ user, active }` |
| `GET /api/rooms` | | `RoomSummary[]` |
| `POST /api/rooms` | `{ name?: string }` (trimmed, ≤ 40 chars) | `RoomView` |
| `GET /api/rooms/[code]` | | `RoomView` |
| `POST /api/rooms/[code]/(join\|leave\|cancel\|start)` | | `RoomView` |
| `GET /api/rooms/[code]/matches/[matchId]` | | `MatchView` |
| `POST /api/rooms/[code]/matches/[matchId]/move` | `{ x: number, y: number, clientMoveNo: number }` | `MatchView` |
| `POST /api/rooms/[code]/matches/[matchId]/resign` | | `MatchView` |

  - `http.ts`:
    - `getService(): RoomService`, a singleton wired with the Mongo stores, `Date.now`, `Math.random`, and the invite URL from env
    - `errorResponse(e): Response`, which maps:
      - `not_found` → 404
      - `not_host`, `not_participant` → 403
      - `conflict`, `already_active`, `not_lobby`, `full` → 409
      - other `RoomError` → 400
      - a thrown `Response` → itself
      - anything else → 500 `{error:'internal'}`
    - the body is `{ error: code, ...extra }`
  - An unknown `[action]` → 404.

- [ ] **Step 1: Write failing tests** for `errorResponse` status mapping and for body validation (a `move` with a non-integer `x` → 400 `bad_request`). Keep the validator in `http.ts` as `parseMoveBody(json): { x, y, clientMoveNo }`, which throws `RoomError('out_of_bounds')` or a 400 Response.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** `http.ts` and the routes, after reading the Next 16 route docs named in Global Constraints. **Step 4: Run.** Expected: PASS, and `pnpm build` succeeds.
- [ ] **Step 5: Commit** `feat: tournament API routes`.

---

### Task 8: Client shell, Home, boot routing

**Files:**
- Modify: `app/layout.tsx` (load `https://telegram.org/js/telegram-web-app.js` with `next/script` `strategy="beforeInteractive"`; title "Caro Cup"; body dark shell), `app/globals.css` (tokens from mock: `--bg #0f172a`, `--panel #1e293b`, `--panel2 #273449`, `--line #3b4a63`, `--text #e2e8f0`, `--muted #94a3b8`, `--accent #3b82f6`, `--win #22c55e`, `--x #1d6ff2`, `--o #ef4456`, `--grid #d9e3f2`, `--paper #f7f9fd`)
- Create: `src/client/telegram.ts`, `src/client/api.ts`, `src/client/use-poll.ts`
- Rewrite: `app/page.tsx`
- Delete: unused `public/*.svg`

**Interfaces:**
- Produces:
  - `getInitData(): string`
  - `getStartParam(): string | null` (from `Telegram.WebApp.initDataUnsafe.start_param`, or the `?startapp=` query in dev)
  - `initTelegram(): void` (calls `ready()` and `expand()`)
  - `shareInvite(url: string, text: string): void` (opens `https://t.me/share/url?url=…&text=…` via `Telegram.WebApp.openTelegramLink`)
  - `apiGet<T>(path): Promise<T>` and `apiPost<T>(path, body?): Promise<T>`. They send `x-telegram-init-data`, and in dev `x-dev-user` from `?dev=<id>:<name>`, persisted in `sessionStorage`. They throw `ApiError {status, code, extra}`.
  - `usePoll<T>(path: string | null, intervalMs: number): { data: T | null; error: ApiError | null; refresh(): void }`. It pauses while `document.hidden` and refreshes immediately on `visibilitychange`.

**Home behavior:**
- **On mount:**
  1. `initTelegram()`.
  2. Unless `sessionStorage['booted']` is set: set it, then
     - if there's a start param: `router.replace('/r/' + code + '?join=1')`
     - else, from `GET /api/me`: an active match → `/r/{code}/m/{matchId}`; an active room → `/r/{code}`
  3. Otherwise render Home.
- **Home render** (polls `/api/rooms` every 10 s):
  - header "Tournaments" + "Hi, {first name}"
  - **＋ Create** button: POST, then navigate to the room
  - "Your tournament" section with **Resume**, if `youAreIn`
  - "Open rooms" list: lobby → **Join** (POST join, then navigate); running → **View**
  - empty state: "No open rooms yet. Create one!"
  - a 409 `already_active` shows a toast "You're already in {activeCode}" with a Go button

- [ ] **Step 1: Implement** the files above. (UI has no unit tests; correctness is verified in Task 10.)
- [ ] **Step 2: Run** `pnpm lint && pnpm build`. Expected: no errors.
- [ ] **Step 3: Commit** `feat: telegram client shell and home`.

---

### Task 9: Lobby, Bracket, Match, Board

**Files:**
- Create: `src/client/marks.tsx`, `src/client/board.tsx`, `app/r/[code]/page.tsx`, `app/r/[code]/m/[matchId]/page.tsx`
- Test: `tests/client/board-geometry.test.ts`

**Interfaces:**
- Consumes: `RoomView`, `MatchView` (Task 5), client helpers (Task 8).
- Produces:
  - `<XMark size/>` and `<OMark size/>`, drawn with CSS:
    - X is two 4px-thick rounded bars at ±45°, 22px long at cell 30
    - O is a ring with a 4px border, 16px inner box at cell 30
    - both scale with the cell size and are centered in the cell
  - `<Board moves winLine you turn disabled onPlay(cell)/>`:
    - 30×30 graph-paper grid inside a scroll container, with cell size from zoom steps `[24, 32, 44]` (default 32)
    - zoom buttons ＋ / － / fit (fit = 24 and scroll to the stones' bounding box)
    - the last move is highlighted with `rgba(59,130,246,.18)` and the `winLine` cells get a green tint
    - on mount it scrolls so the last move (or the center) is centered
    - a tap on an empty cell while it's `you === turn` and not disabled calls `onPlay`
  - `cellAt(px, py, cellSize): Cell | null` and `scrollToCenter(cell, cellSize, viewport): {left, top}`. These pure geometry helpers are exported for testing.

**Room page `/r/[code]`:**
- Polls `GET /api/rooms/{code}` every 3 s. If `?join=1` and the status is lobby and you're not in it, it POSTs join once; on 409 `already_active` it shows the read-only banner "You're already playing in {activeCode} → Go back".
- **Lobby:**
  - card with the room code and **↗ Share invite link** button
  - player list with avatar initials and a Host pill
  - hint: "On start: N players → M-slot bracket, K bots added."
  - host: **▶ Start tournament** (disabled when humans < 2) and **Cancel tournament**
  - non-host: "Waiting for host to start…" and **Leave**
- **Bracket** (running): horizontally scrollable columns per round plus a '3rd Place' column.
  - Match cards show seed (`#n`), name (bots prefixed 🤖), and score; the winner is bold with a green score, the loser is dimmed, `playing` gets a "● Live" tag (with "· #{id}" on yours), and your card has an accent outline.
  - If `yourMatch` is set: a card "Your match is ready" with "You (✕/○) vs {opponent} · match #{id}" and an **Enter match →** button. It auto-navigates the first time `yourMatch` appears, guarded with `sessionStorage['auto:{id}']`.
- **Finished:** 🏆 "Champion: {name}", the 🥈 / 🥉 line, "This room closes in 10 minutes.", and a **Back to rooms** button.
- **Cancelled:** "This tournament was cancelled." and **Back to rooms**.

**Match page `/r/[code]/m/[matchId]`:**
- Polls the match every 1 s, plus right after its own move.
- The clock is displayed by counting down locally from `turnRemainingMs`; it resyncs on every poll.
- **HUD:** two side cards (mark, "You" or name, "Your turn" / "Waiting", and the countdown in `m:ss`); the active one has an accent ring.
- **Banners:**
  - if `opponentDisconnected`: "⚠ Opponent disconnected: {s}s to reconnect, otherwise they forfeit."
  - if `pending`: "Waiting for {opponent} to join… ({s}s)"
- **Board**, then a footer: "Move {n} · blocked-ends rule", the match code, and **Resign** (`confirm()` first).
- **Moves are optimistic:** draw the move immediately, POST it with `clientMoveNo = moves.length`, and roll back on error.
- **Finished:** a result card overlay:
  - 🎉 "You win!" / "You lose" / for spectators "{name} wins"
  - the reason in words: "Open five", "Opponent timed out", "Opponent disconnected", "Opponent resigned", "Opponent didn't show up", "Board full" (and the mirrored wording when you lose)
  - the `nextStep` line ("Advancing to {next round}" / "You're out. Thanks for playing!" / "Champion!")
  - a **View bracket** button

- [ ] **Step 1: Write failing tests** for `cellAt` (`(0,0,32)` → (0,0); `(959,959,32)` → (29,29); `(960,10,32)` → null) and for `scrollToCenter` (clamped to ≥ 0).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test && pnpm lint && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: lobby, bracket and match screens`.

---

### Task 10: End-to-end verification + README

**Files:**
- Modify: `README.md` (what Caro Cup is, env vars, `pnpm dev` with `?dev=<id>:<name>` multi-tab testing, how to register the Mini App with BotFather and set `TELEGRAM_MINIAPP_SHORTNAME`, deploy to Vercel)

- [ ] **Step 1: Seed `.env.local`** for dev, with the user's own values: `MONGODB_URI` is optional because `User` and `pass` in `.env` are already used. Start `pnpm dev`.
- [ ] **Step 2: Manual run** with 3 browser tabs (`?dev=1:Ann`, `?dev=2:Ben`, `?dev=3:Cat`):
  1. Ann creates → Ben and Cat join via `/?startapp=<CODE>`.
  2. Lobby shows "3 players → 4-slot bracket, 1 bot".
  3. Ann starts → all three are auto-routed into matches; the bot's opponent sees the bot move ~0.5–1 s after their own move.
  4. Reload a tab mid-match → same board and clock.
  5. Close a tab for 40 s → the opponent wins by disconnect.
  6. Play to the champion screen.
  7. In Mongo, the room's `expiresAt` ≈ finishedAt + 10 min.
- [ ] **Step 3: Run** `pnpm test && pnpm lint && pnpm build`. Expected: all green.
- [ ] **Step 4: Commit** `docs: README for Caro Cup`.
