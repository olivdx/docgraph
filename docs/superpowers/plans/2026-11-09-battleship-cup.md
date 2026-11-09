# Battleship Cup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Battleship as the third game of the Telegram Mini App: human-only Bo1 knockout cups with invite links, secret fleet placement and a 3D battle screen.

**Architecture:** A new `src/battleship/` module (pure rules, cup/match state machine, views) beside Caro and Sudoku, persisted in a new Mongo collection through a `BattleshipService` that copies Caro's settle → command → CAS-write loop and reuses its presence store, invite links and Ably doorbell. The client ports the throwaway prototype (`public/battleship-preview.html`) into a three.js scene class driven by the polled match view.

**Tech Stack:** Next.js 16.2.4 (read `node_modules/next/dist/docs/` before writing routes/pages; this version has breaking changes), React 19, TypeScript, MongoDB 7 driver, Ably, Vitest + mongodb-memory-server, three.js `0.160.0`.

**Spec:** `docs/superpowers/specs/2026-11-09-battleship-cup-design.md`

## Global Constraints

- All UI text in English. No Vietnamese anywhere in the UI.
- No bots and no play-vs-computer mode. Battleship is always a Bo1 cup with no format picker.
- Sea 6×6 (cells 0–35, `cell = row * 6 + col`, columns A–F, rows 1–6). Fleet: `galleon` "Galleon" 3, `brig` "Brig" 2, `sloop` "Sloop" 2.
- Room codes are 4 characters (Caro 6, Sudoku 5), from `CODE_ALPHABET`.
- Clocks: no-show 60 s, placement 45 s, turn 20 s, shot grace 3 s, 3 missed turns in a row → `afk` loss, disconnect detect 5 s + grace 30 s.
- Players per cup: 2–32.
- Opponent ship cells must never appear in any response, view or Ably payload until that ship sinks or the match is finished. Ably payloads are `{ v: version }` only.
- Caro and Sudoku behaviour must not change. All existing tests stay green.
- Both fleets use the pirate ship models (`ship-pirate-large|medium|small` ↔ `galleon|brig|sloop`).
- Model URL base: `/assets/Models/GLB%20format/`.
- `three` is pinned to exact version `0.160.0` (and `@types/three` `0.160.0`).

## Review Focus

1. **A double-tapped or retried FIRE** must record exactly one shot. Covered in Task 3 by `fire is idempotent per seq`.
2. **A FIRE request arriving just after the turn deadline**, when settle has already auto-fired, must not add a second shot. The auto-shot took that seq, so the request returns the stored state without an error, and the client shows the auto-shot. Covered in Task 3 by `late fire after auto-shot is refused, not doubled`.
3. **A reload during placement** must return the partially placed fleet, and the deadline must keep those ships. Covered in Task 3 by `deadline auto-places only the missing ships`, and in Task 5 by `reload mid-placement returns the saved ships`.
4. **A user already in a Caro or Sudoku room opening a Battleship invite**, or the reverse, must get `already_active` with that room's code. Covered in Task 5 by `one active room across three games`.
5. **Leaking an unsunk ship through a hit's ship key, a watcher view or the room view.** Covered in Task 4 by `hit shots never carry shipKey; watcher sees only sunk ships`.

---

### Task 1: Fleet rules, constants and types

**Files:**
- Create: `src/battleship/constants.ts`, `src/battleship/types.ts`, `src/battleship/fleet.ts`
- Modify: `src/tournament/types.ts` (extend `RoomErrorCode` with `'bad_fleet' | 'not_placing' | 'locked'`)
- Test: `tests/battleship/fleet.test.ts`

**Interfaces:**
- Produces, in `constants.ts`: `N = 6`, `CELLS = 36`, `FLEET: readonly { key: ShipKey; name: string; len: number }[]` in the order galleon, brig, sloop; `BATTLE_CODE_LEN = 4`, `MIN_PLAYERS = 2`, `MAX_PLAYERS = 32`, `PLACE_MS = 45_000`, `TURN_MS = 20_000`, `SHOT_GRACE_MS = 3_000`, `MAX_MISSED_TURNS = 3`, `NO_SHOW_MS = 60_000`, `DISCONNECT_DETECT_MS = 5_000`, `RECONNECT_GRACE_MS = 30_000`, `MATCH_ID_LEN = 4`. Re-export `LOBBY_TTL_MS` and `FINISHED_TTL_MS` from `src/tournament/constants`.
- Produces, in `types.ts`:
  - `ShipKey = 'galleon' | 'brig' | 'sloop'`
  - `Ship { key: ShipKey; cells: number[] }`
  - `Seat = 'a' | 'b'`
  - `ShotResult = 'miss' | 'hit' | 'sunk'`
  - `Shot { seq: number; cell: number; result: ShotResult; shipKey: ShipKey | null; at: number; auto: boolean }`. `shipKey` is set for hit and sunk on the server; views strip it from hits.
  - `BattleMatchStatus = 'waiting' | 'pending' | 'placing' | 'playing' | 'finished'`
  - `BattleEndReason = 'fleet_sunk' | 'no_show' | 'afk' | 'disconnect_timeout' | 'resign' | 'bye'`
  - `BattleMatch`, with fields: `id`, `round`, `slot`, `kind: 'normal' | 'third_place'`, `a: string | null`, `b: string | null`, `status`, `pendingSince: number | null`, `readyAt: Record<Seat, number | null>`, `placingStartedAt: number | null`, `placingDeadlineAt: number | null`, `fleets: Record<Seat, Ship[]>`, `lockedAt: Record<Seat, number | null>`, `startedAt: number | null` (battle start), `turn: Seat | null`, `turnDeadlineAt: number | null`, `missedTurns: Record<Seat, number>`, `shots: Record<Seat, Shot[]>` (shots fired **by** that seat), `winner: Seat | null`, `endReason: BattleEndReason | null`, `finishedAt: number | null`
  - `BattlePlayer { userId; name; avatarUrl: string | null; seed: number | null; joinedAt: number }`
  - `BattleRoom { _id; name; hostId; status: 'lobby' | 'running' | 'finished' | 'cancelled'; players: BattlePlayer[]; totalRounds: number; matches: BattleMatch[]; placements: { first: string | null; second: string | null; third: string | null }; version: number; createdAt: number; startedAt: number | null; finishedAt: number | null; expiresAt: Date }`
- Produces, in `fleet.ts`:
  - `shipCells(len: number, origin: number, horiz: boolean): number[] | null`: null when it leaves the board.
  - `centeredCells(len: number, cell: number, horiz: boolean): number[]`: the ship centred on `cell` (offset `floor((len-1)/2)`), shifted to stay inside the board.
  - `validateFleet(ships: Ship[], complete: boolean): void`: throws `RoomError('bad_fleet')`.
  - `randomFleet(rng: () => number, keep?: Ship[]): Ship[]`
  - `resolveShot(fleet: Ship[], prior: Shot[], cell: number): { result: ShotResult; shipKey: ShipKey | null }`
  - `fleetSunk(fleet: Ship[], shots: Shot[]): boolean`
  - `sunkKeys(shots: Shot[]): Set<ShipKey>`

- [ ] **Step 1: Write the failing tests** in `tests/battleship/fleet.test.ts`:
  - `shipCells`: `shipCells(3, 0, true)` → `[0,1,2]`; `shipCells(3, 4, true)` → `null`; `shipCells(2, 30, false)` → `null`; `shipCells(2, 24, false)` → `[24,30]`.
  - `centeredCells`: `centeredCells(3, 7, true)` → `[6,7,8]`; `centeredCells(3, 0, true)` → `[0,1,2]`; `centeredCells(3, 35, false)` → `[23,29,35]`.
  - `validateFleet` throws `bad_fleet` for each of:
    - an unknown key
    - a duplicate key
    - a wrong length
    - non-contiguous cells (`[0,2]`)
    - a diagonal (`[0,7]`)
    - a wrap across rows (`[5,6]`)
    - out-of-range cells (`-1`, `36`, `1.5`)
    - overlapping ships
    - `complete=true` with 2 ships
  - `validateFleet` passes for `complete=false` with 0–2 valid ships, and for touching ships.
  - `randomFleet`, over 200 seeds with `mulberry`: always passes `validateFleet(…, true)`, and keeps a given `keep` ship's cells exactly.
  - `resolveShot`: miss on an empty cell; `hit` with `shipKey` on a ship cell; `sunk` on the last cell of a ship given the prior hits.
  - `fleetSunk` is true only once all 7 cells are hit. `sunkKeys` returns the keys of `sunk` shots.

- [ ] **Step 2: Run the tests and verify they fail.** Run `pnpm vitest run tests/battleship/fleet.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the constants, the types, the `RoomErrorCode` additions and `fleet.ts`. `randomFleet` places the missing ships in `FLEET` order. It tries up to 200 placements that neither overlap nor touch any ship, then falls back to placements that only avoid overlap.
- [ ] **Step 4: Run the tests and verify they pass.** Run `pnpm vitest run tests/battleship/fleet.test.ts`, then `pnpm vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git add src/battleship tests/battleship src/tournament/types.ts && git commit -m "feat(battleship): fleet rules, types and constants"`

### Task 2: Bye bracket

**Files:**
- Modify: `src/tournament/bracket.ts` (add a function; `planBracket` stays unchanged)
- Test: `tests/tournament/bracket.test.ts` (append)

**Interfaces:**
- Produces: `planByeBracket<T>(entrants: T[], rng: () => number): { size: number; totalRounds: number; order: (T | null)[] }`.
  - `size` is the smallest power of two that is at least `max(2, n)`.
  - `null` marks a bye.
  - Every bye is the second element of its own round-1 pair. The pairs that get a bye are chosen at random.

- [ ] **Step 1: Write the failing tests:**
  - For `n` in 2..32: `order.length === size`; there are exactly `size - n` nulls; for every pair `s`, `order[2s] !== null`.
  - `[3 → size 4, 2 rounds]`, `[5 → 8, 3]`, `[32 → 32, 5]`.
  - Every entrant appears exactly once.
- [ ] **Step 2: Run** `pnpm vitest run tests/tournament/bracket.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `planByeBracket`, mirroring `planBracket`'s shuffle and pair choice with `null` in place of bot players.
- [ ] **Step 4: Run** the same command. Expected: PASS, including the existing `planBracket` tests.
- [ ] **Step 5: Commit.** `git commit -am "feat(tournament): bracket planning with byes"`

### Task 3: Cup and match state machine

**Files:**
- Create: `src/battleship/match.ts` (in-place transitions on an already-cloned room), `src/battleship/room.ts` (the public, pure API)
- Test: `tests/battleship/room.test.ts`

**Interfaces:**
- Consumes: Task 1 (`fleet.ts`, constants, types) and Task 2 (`planByeBracket`); `randomCode` and `RoomError` from `src/tournament`.
- Produces, in `room.ts`. Every function is pure: it clones its input, and `presence` is `Record<userId, lastSeenAt> | null`, where null means disconnects are not evaluated.
  - `createBattleRoom(p: { code: string; host: UserInfo; name?: string; now: number }): BattleRoom`, where `UserInfo = { userId; name; avatarUrl }`. The default name is `"<first word of host name>'s Battle"`, and `expiresAt = now + LOBBY_TTL_MS`.
  - `joinBattle(room, user: UserInfo, now)`: idempotent for a member. Throws `not_lobby`, or `full` at 32 players.
  - `leaveBattle(room, userId)`: throws `host_must_cancel`, `not_lobby`.
  - `cancelBattle(room, userId, now)`: throws `not_host`, `not_lobby`.
  - `startBattle(room, userId, now, rng)`: throws `not_host`, `not_lobby`, or `too_few_players` below 2.
  - `settleBattle(room, presence, now, rng): { room: BattleRoom; changed: boolean }`
  - `markBattleReady(room, matchId, userId, now, rng, presence)`
  - `saveFleet(room, matchId, userId, ships: Ship[], lock: boolean, now, rng, presence)`
  - `fire(room, matchId, userId, cell: number, seq: number, now, rng, presence)`
  - `resignBattle(room, matchId, userId, now, rng, presence)`
  - `isActiveBattle(room, userId): boolean`. This has the same meaning as Caro's `isActive`: in the lobby, or not yet knocked out of a running cup.
  - `seatOf(m: BattleMatch, userId: string): Seat | null`
- Behaviour that is not obvious from the signatures:
  - **Start:**
    - Seeds are `index + 1` for the non-null entries of `planByeBracket`.
    - Matches are laid out as in Caro's `startRoom` (rounds × slots, ids from `randomCode(MATCH_ID_LEN)`).
    - A round-1 pair with a bye is created already `finished`, with `endReason: 'bye'`, the present seat as winner, and `finishedAt = now`. The winner advances.
    - The `third_place` match exists only when `size >= 4` and no semifinal holds a bye. In practice that means it is missing only for 3 players.
  - **Advance:** same feeding rules as Caro's `advance` in `src/tournament/match.ts`. The next match's `a` comes from the even slot and `b` from the odd one. Semifinal losers feed the 3rd-place match. `pendingSince` is the later of the two feeders' `finishedAt`.
  - **Events and their times.** Each event happens at its deadline time; settle applies the earliest due event first, as in Caro's `stepMatch`.
    - `waiting → pending` when both `a` and `b` are set.
    - `pending`:
      - When both have `readyAt`, the match goes to `placing` at `max(readyAt)`, with `placingDeadlineAt = t + PLACE_MS`.
      - No-show: if `now - pendingSince > NO_SHOW_MS`, the ready player wins, or the lower seed number if neither is ready. `endReason: 'no_show'`.
    - `placing`:
      - When both have `lockedAt`, battle starts at `max(lockedAt)`.
      - At `placingDeadlineAt`, every unlocked seat gets `randomFleet(rng, current)` and `lockedAt = deadline`, and battle starts at the deadline.
    - Battle start at `t`: `status: 'playing'`, `startedAt = t`, `turn = rng() < 0.5 ? 'a' : 'b'`, `turnDeadlineAt = t + TURN_MS` (no grace on the first turn).
    - `playing`, at `turnDeadlineAt`:
      - The seat to move gets `missedTurns[seat] += 1`.
      - If that reaches `MAX_MISSED_TURNS`, the seat loses with `afk` at the deadline.
      - Otherwise the server fires one random unfired cell for it (`auto: true`, `seq = shots.length + 1`), then applies the normal after-shot rules at the deadline time.
    - Disconnect, in `placing` and `playing`: the deadline is `max(lastSeen ?? placingStartedAt, placingStartedAt) + DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS`. Once it is past, the other seat wins with `disconnect_timeout`.
  - **`fire`:**
    1. Settle first. A caller who is not in the match gets `not_participant`.
    2. If `seq <= shots[seat].length`, return the settled room unchanged. This makes retries idempotent, even after the match finished.
    3. If the match is not `playing`, throw `not_playing`.
    4. If it is not the caller's turn, throw `not_your_turn`. A non-integer cell or one outside 0–35 throws `out_of_bounds`. A cell this seat already fired at throws `occupied`.
    5. Otherwise: set `missedTurns[seat] = 0` and record the shot with `resolveShot`. If the opponent's fleet is sunk, the shooter wins with `fleet_sunk`. If not, the turn flips and `turnDeadlineAt = now + SHOT_GRACE_MS + TURN_MS`.
  - **`saveFleet`:** settle first.
    - Throws `locked` if this seat is already locked, and `not_placing` if the match is not `placing`.
    - Runs `validateFleet(ships, lock)`, stores the ships, and sets `lockedAt = now` when `lock` is true.
    - Settles again, which may start the battle.
  - **`resignBattle`:** allowed during `placing` and `playing`; the other seat wins with `resign`. If the match finished during this same settle, return the settled room instead of throwing. Otherwise throw `not_playing`.
  - **Finish:** the cup finishes when the final is finished and the 3rd-place match (if any) is too. Then set `placements`, `status: 'finished'`, `finishedAt` and `expiresAt = at + FINISHED_TTL_MS`.

- [ ] **Step 1: Write the failing tests** (use `mulberry` and `user` from `tests/tournament/helpers.ts`, and `T0 = 1_800_000_000_000`):
  - `lobby rules`: default name `"User's Battle"`; join is idempotent; 33rd join → `full`; host leave → `host_must_cancel`; start with 1 player → `too_few_players`; a non-host start → `not_host`.
  - `2 players: one match, no bye, no third place`.
  - `3 players: one bye match finished with endReason bye, its winner already in the final, no third_place match`.
  - `5 players: 3 bye matches, third_place exists`.
  - `ready then placing`: one `markBattleReady` keeps the match `pending`; the second moves it to `placing` with `placingDeadlineAt = t + 45_000`.
  - `no-show`: after 60 001 ms with only `a` ready → `a` wins with `no_show`; with neither ready → the lower seed wins.
  - `both lock → playing at the later lock`: `turnDeadlineAt = startedAt + 20_000`.
  - `deadline auto-places only the missing ships`: `a` saves `[galleon]` unlocked, the deadline passes, and `a`'s fleet has 3 ships with the same galleon cells.
  - `saveFleet errors`: `bad_fleet` (lock with 2 ships), `locked` (save after lock), `not_placing` (save in `pending`).
  - `fire: miss passes the turn with grace`: next `turnDeadlineAt = now + 23_000`.
  - `fire: hit, then sunk; sinking all ships wins with fleet_sunk`. The final match's winner becomes `placements.first`, and the room is `finished`.
  - `fire is idempotent per seq`: the same `seq` twice gives one shot; a lower `seq` changes nothing.
  - `fire errors`: `not_your_turn`, `out_of_bounds` (36, -1, 2.5), `occupied`, `not_participant`.
  - `turn timeout auto-fires and counts a miss`: after 20 001 ms the shooter has 1 `auto` shot, `missedTurns` is 1, and the turn has flipped.
  - `three missed turns in a row → afk loss`. A manual shot in between resets the counter.
  - `late fire after auto-shot is refused, not doubled`: at `deadline + 1` the player sends `seq` 1 for a different cell. The call returns without throwing, because the auto-shot already took seq 1. The player still has exactly 1 shot (`auto: true`), and the turn belongs to the opponent.
  - `disconnect during playing`: presence `{ a: startedAt }` at `startedAt + 35_001` → `b` wins with `disconnect_timeout`.
  - `resign during placing`.
  - `bracket advance`: in a 4-player cup, both semifinals finished → the final and the 3rd-place match go `pending`; finishing both finishes the room with `placements`.
  - `isActiveBattle`: true in the lobby; true while the player's match is unfinished; false after losing; true for the winner of a finished match whose next match is still `waiting`.
- [ ] **Step 2: Run** `pnpm vitest run tests/battleship/room.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `match.ts` and `room.ts` to the behaviour above. Use Caro's `src/tournament/match.ts` (`stepMatch`, `advance`, `finishMatch`) and `src/tournament/room.ts` (`settleInPlace`, `finishRoomIfDone`) as the structural template.
- [ ] **Step 4: Run** `pnpm vitest run tests/battleship`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/battleship tests/battleship && git commit -m "feat(battleship): cup and match state machine"`

### Task 4: Views and hidden information

**Files:**
- Create: `src/battleship/views.ts`
- Test: `tests/battleship/views.test.ts`

**Interfaces:**
- Consumes: Task 3 (`isActiveBattle`, `seatOf`) and `roundName` from `src/tournament/bracket.ts`.
- Produces:
  - `BattleSummary { code; name; hostName; status; playerCount; youAreIn: boolean; liveLabel: string | null }`, from `toBattleSummary(room, viewerId)`.
  - `BattleRoomView { code; name; status; isHost; players: { name; avatarUrl; isHost }[]; minPlayers: 2; rounds: { name: string; matches: BattleBracketMatch[] }[]; yourMatch: { id: string; opponentName: string } | null; placements: { first: string | null; second: string | null; third: string | null }; inviteUrl: string; serverNow: number }`, from `toBattleRoomView(room, viewerId, now, inviteUrl)`.
    - `BattleBracketMatch { id; a: { name: string } | null; b: { name: string } | null; winner: Seat | null; status; endReason: BattleEndReason | null; isYours: boolean }`
    - `yourMatch` is the viewer's `pending | placing | playing` match.
    - `placements` holds names.
  - `ShotView { cell: number; result: ShotResult; shipKey: ShipKey | null; auto: boolean }`. `shipKey` is non-null **only** when `result === 'sunk'`.
  - `NextStep = 'wait' | 'next_match' | 'eliminated' | 'champion' | 'podium'`. The meaning is the same as Caro's `NextStep` in `src/tournament/views.ts`.
  - `BattleMatchView { id; roundName; status; you: Seat | null; players: Record<Seat, { name: string; avatarUrl: string | null } | null>; fleets: Record<Seat, Ship[]>; locked: Record<Seat, boolean>; shots: Record<Seat, ShotView[]>; turn: Seat | null; turnRemainingMs: number | null; placingRemainingMs: number | null; pendingRemainingMs: number | null; missedTurns: Record<Seat, number>; opponentDisconnected: boolean; opponentReconnectRemainingMs: number | null; winner: Seat | null; endReason: BattleEndReason | null; nextStep: NextStep; nextMatchId: string | null; serverNow: number }`, from `toBattleMatchView(room, matchId, viewerId, now, presence)`.
    - `fleets`: once the match is finished, both full fleets. Before that: the viewer's own seat in full, and for any other seat only the ships whose key is in `sunkKeys(shots fired at that seat)`. Watchers get only sunk ships on both sides.
    - `turnRemainingMs = clamp(turnDeadlineAt - now, 0, TURN_MS)`, which hides the grace.
    - `opponentDisconnected` means `now - lastSeen > DISCONNECT_DETECT_MS` during `placing` or `playing`.

- [ ] **Step 1: Write the failing tests:**
  - `hit shots never carry shipKey; watcher sees only sunk ships`. Set up a match with one brig hit once and the sloop sunk:
    - the opponent's view has `fleets[otherSeat]` containing only the sloop;
    - the `hit` ShotView has `shipKey: null`, and the `sunk` one has `'sloop'`;
    - the watcher view (viewer `u9`) has only the sloop, on that seat;
    - `JSON.stringify(view)` does not contain the brig's unsunk cell numbers as a fleet entry.
  - `finished match reveals both fleets to everyone`.
  - `own fleet is always visible to its owner during placing` (partial, unlocked).
  - `turnRemainingMs hides the grace`: right after a shot it is `20_000`, not `23_000`.
  - `room view`: in a 3-player cup the bye match has `endReason 'bye'` and `b: null`; `yourMatch` points at the viewer's playable match; `minPlayers` is 2.
  - `nextStep`: `eliminated` after a loss; `champion` for the final's winner once the room is finished; `next_match` when the viewer's next match is `pending`.
- [ ] **Step 2: Run** `pnpm vitest run tests/battleship/views.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `views.ts`.
- [ ] **Step 4: Run** `pnpm vitest run tests/battleship`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(battleship): views that hide unsunk ships"` (after `git add src/battleship/views.ts tests/battleship/views.test.ts`)

### Task 5: Store, service, realtime and cross-game wiring

**Files:**
- Create: `src/server/battleship-store.ts`, `src/server/battleship-service.ts`
- Modify:
  - `src/realtime/channels.ts`: add `battleshipRoomChannel(code)` → `battleship:<CODE>` and `battleshipMatchChannel(code, matchId)` → `battleship:<CODE>:<matchId>`.
  - `src/server/realtime.ts`: add `'battleship:*': ['subscribe']` to the token capability, and re-export the new channel helpers.
  - `src/server/db.ts`: optional `MONGODB_DB` env overrides `DB_NAME`; `battleship_rooms` indexes `expiresAt` TTL, `{status:1, createdAt:-1}` and `players.userId`.
  - `src/server/http.ts`:
    - add `getBattleshipService()`;
    - set each service's `activeElsewhere` to check the other two games, in order caro, sudoku, battleship;
    - add `parseFleetBody` and `parseFireBody`.
  - `app/api/me/route.ts`: add battleship to the active lookup, which becomes `{ game: 'caro' | 'sudoku' | 'battleship', code, matchId }`.
  - `src/client/routes.ts`: `roomPath` sends a 4-character code to `/b/<code>`.
- Test: `tests/server/battleship-service.test.ts`, and append to `tests/server/http.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–4; `PresenceStore` and `MemoryPresenceStore` / `MongoPresenceStore` from `src/server/stores.ts`, reused as-is. Codes of different lengths never collide.
- Produces:
  - `BattleStore`, mirroring `SudokuStore`: `get`, `insert`, `replace(room, expectedVersion)`, `listOpen(limit)` (status lobby|running), `findByPlayer(userId)`. Implemented by `MemoryBattleStore` and by `MongoBattleStore` (collection `battleship_rooms`).
  - `BattleshipService`, constructed with `{ rooms: BattleStore; presence: PresenceStore; now; rng; inviteUrl; activeElsewhere?; notify? }`. Methods:
    - `me(user): Promise<{ code: string; matchId: string | null } | null>`, where `matchId` is a `pending | placing | playing` match
    - `activeCode(userId)`, `list(user)`, `create(user, name?)`
    - `getRoom(code, user)`, `join(code, user)`, `leave(code, user)`, `cancel(code, user)`, `start(code, user)`
    - `getMatch(code, matchId, user)`: marks ready and touches presence for participants; a watcher only settles.
    - `saveFleet(code, matchId, user, ships, lock)`, `fire(code, matchId, user, cell, seq)`, `resign(code, matchId, user)`
    - Room commands return `BattleRoomView`; match commands return `BattleMatchView`.
  - `parseFleetBody(json): { ships: Ship[]; lock: boolean }`. It checks shape only: `ships` is an array of at most 3 items `{ key: string, cells: integer[] }`, and `lock` is a boolean. Anything else throws a 400 `bad_request`. `parseFireBody(json): { cell: number; seq: number }`, with integers and `seq >= 1`.
- `mutate` loop: copy `RoomService.mutate` (touch caller presence → read presence for `placing`/`playing` matches → command → CAS write → notify), without bots, learning or move signals. Notify the room channel when the bracket shape changes (status, players, placements, each match's `[id, status, a, b, winner]`), and the match channel for every match whose JSON changed.

- [ ] **Step 1: Write the failing tests** (`MemoryBattleStore` and `MemoryPresenceStore`, an injected clock, `mulberry`):
  - `4-char codes and invite url`.
  - `one active room across three games`:
    - `activeElsewhere` returning `'CAROXX'` → `create` and `join` throw `already_active` with `{ activeCode: 'CAROXX' }`;
    - a user active in a battleship lobby gets `already_active` when creating a second one;
    - `activeCode` returns the code while the user is in a cup and null after they are knocked out.
  - `full 2-player cup through the service`: create, join, start, both `getMatch` (ready), both `saveFleet(lock)`, alternate `fire` until one fleet sinks. The room view then shows `finished` and the winner in `placements.first`.
  - `reload mid-placement returns the saved ships`: `saveFleet([galleon], false)`, then `getMatch` returns the galleon in `fleets[you]` and `placingRemainingMs <= 45_000`.
  - `opponent view never contains the other fleet before a sink`: after both lock, `getMatch` for `a` has `fleets.b` equal to `[]`.
  - `notify`: a `fire` notifies `battleship:<CODE>:<matchId>` and not the room channel. Finishing the match notifies both.
  - In `tests/server/http.test.ts`: `parseFleetBody` rejects a non-array, more than 3 ships, non-integer cells and a missing `lock`. `parseFireBody` rejects `seq: 0`. `roomPath('ABCD')` is `/b/ABCD`, and the 5- and 6-character codes route as before.
- [ ] **Step 2: Run** `pnpm vitest run tests/server/battleship-service.test.ts tests/server/http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** `pnpm vitest run`. Expected: everything PASS (Caro and Sudoku included).
- [ ] **Step 5: Commit.** `git add -A src/server src/realtime src/client/routes.ts app/api/me tests/server && git commit -m "feat(battleship): service, store and cross-game wiring"`

### Task 6: API routes

**Files:**
- Create:
  - `app/api/battleship/route.ts`: GET list, POST create (body `{ name? }` via `parseCreateBody`).
  - `app/api/battleship/[code]/route.ts`: GET room.
  - `app/api/battleship/[code]/[action]/route.ts`: POST `join | leave | cancel | start`.
  - `app/api/battleship/[code]/matches/[matchId]/route.ts`: GET match.
  - `app/api/battleship/[code]/matches/[matchId]/[action]/route.ts`: POST `fleet | fire | resign`.
- Test: none new (the routes are thin; Task 5 covers the parsers and the service). Verify with a build.

**Interfaces:**
- Consumes: `getBattleshipService`, `authenticate`, `errorResponse`, `codeOf`, `readJson`, `parseFleetBody`, `parseFireBody`, `parseCreateBody`.
- Copy the shape of the `app/api/sudoku/**` handlers exactly: `export const dynamic = 'force-dynamic'`, `RouteContext<'/api/battleship/...'>` params, and an unknown action → 404 `{ error: 'not_found' }`.

- [ ] **Step 1: Read** `node_modules/next/dist/docs/` for route handlers in this Next version, and copy the sudoku handlers' pattern.
- [ ] **Step 2: Create** the five route files.
- [ ] **Step 3: Run** `pnpm build`. Expected: the build succeeds, and the route list includes `/api/battleship/[code]/matches/[matchId]/[action]`.
- [ ] **Step 4: Commit.** `git add app/api/battleship && git commit -m "feat(battleship): api routes"`

### Task 7: Home, game picker card, lobby and bracket screens

**Files:**
- Create: `app/battleship/page.tsx` (home: **＋ Create cup**, an "Open cups" list with Join/View, an already-active banner); `app/b/[code]/page.tsx` (lobby, then bracket).
- Modify: `app/page.tsx` (add a "Battleship" `GameCard` with badge `KNOCKOUT CUP`, blurb `"Hide your pirate fleet, then sink theirs. 6×6 sea, Bo1 knockout, friends only."`, stat `Format` / `Bo1`, art from `/assets/Previews/ship-pirate-large.png`; `activePath` sends `battleship` with a matchId to `/b/<code>/m/<matchId>`; the hero pill changes from `2 GAMES` to `3 GAMES`).
- Test: manual (Task 10).

**Interfaces:**
- Consumes: `/api/battleship*` (Task 6), `BattleSummary`, `BattleRoomView`, `usePoll`, `battleshipRoomChannel`, `shareInvite`, `roomPath`.
- `app/b/[code]/page.tsx` follows `app/r/[code]/page.tsx`. Keep the `?join=1` auto-join, the already-active banner, the auto-route into `yourMatch` (the session key `auto:<matchId>`), polling at 3 s (15 s when live) and the Share invite button (`shareInvite(view.inviteUrl, "Join my Battleship cup: <name>")`). Remove the format and bot pickers and the bot counts. Start is enabled at `players.length >= 2`, with the error copy `"Need at least 2 players to start."`. In the bracket, a bye shows as `"bye"` in place of the empty entrant. Tapping any non-waiting match opens `/b/<code>/m/<id>`, so watching works.
- `app/battleship/page.tsx` follows `app/sudoku/page.tsx` without the solo and difficulty parts. Create posts to `/api/battleship` and navigates to `/b/<code>`.

- [ ] **Step 1: Build** the three screens above.
- [ ] **Step 2: Run** `pnpm lint && pnpm build`. Expected: no errors.
- [ ] **Step 3: Commit.** `git add app && git commit -m "feat(battleship): home, picker card, lobby and bracket"`

### Task 8: 3D scene (port of the prototype)

**Files:**
- Modify: `package.json` (dependency `three: 0.160.0`, devDependency `@types/three: 0.160.0`, both exact; run `pnpm add three@0.160.0 && pnpm add -D @types/three@0.160.0`)
- Create:
  - `src/client/battleship/models.ts`
  - `src/client/battleship/scene.ts`
  - `src/client/battleship/sync.ts`
- Test: `tests/client/battleship-sync.test.ts`

**Interfaces:**
- Consumes: `Ship`, `ShotView`, `Seat`, `BattleMatchView` (Tasks 1 and 4); `centeredCells` (Task 1).
- Produces:
  - `models.ts`:
    - `MODEL_NAMES`: the 31 GLB basenames the prototype loads. That is the `NAMES` array in `public/battleship-preview.html`, without `ship-large`, `ship-medium` and `ship-small`, which nothing uses any more.
    - `type Models = Record<string, THREE.Group>`
    - `loadModels(base = '/assets/Models/GLB%20format/'): Promise<Models>`
    - `fit(src: THREE.Object3D, opts: { len?: number; maxXZ?: number; height?: number }): THREE.Group`, ported from the prototype.
  - `scene.ts`: `class BattleScene`, with `constructor(canvas: HTMLCanvasElement, models: Models)` and these methods:
    - `resize(width: number, height: number): void`
    - `dispose(): void`
    - `focus(board: 'me' | 'enemy'): Promise<void>`: camera pan of 0.9 s.
    - `setFleet(board, ships: Ship[]): void`: diffs the ship models in place, with no animation.
    - `setShots(board, shots: ShotView[]): void`: diffs the miss and hit markers and the fires, with no animation. Used for the first paint and for resyncs.
    - `playShot(board, shot: ShotView, sunkShip: Ship | null): Promise<void>`: aim, recoil, muzzle flash, smoke, cannonball arc, then splash or explosion; when `sunkShip` is given, it reveals that ship and sinks it.
    - `setTarget(cell: number | null): void`, which aims your cannon.
    - `pickCell(clientX: number, clientY: number, board): number`, returning -1 off the board.
    - `showGhost(key: ShipKey, cells: number[], ok: boolean): void`, `hideGhost(): void`, `dropShip(ship: Ship): void`
    - `screenPointAbove(board, ship: Ship): { x: number; y: number } | null`, for the floating ↻ button.
    - `setDanger(on: boolean): void`: a red stage edge during the opponent's turn. Optional; it can be done in CSS instead.
  - `sync.ts` (pure):
    - `boardOf(you: Seat | null, seat: Seat): 'me' | 'enemy'`. For a watcher, seat `a` is `'me'`.
    - `newShots(prev: BattleMatchView | null, next: BattleMatchView): { board: 'me' | 'enemy'; shot: ShotView; sunkShip: Ship | null }[]`: the shots in `next` beyond `prev`'s counts, oldest first. `board` is the board being shot at, which is the shooter's opposite. `sunkShip` is taken from `next.fleets`.
- Port these from `public/battleship-preview.html`, with the same values:
  - the water shader (calm flat blue);
  - the boards with labels and wooden frame;
  - `decorate`/`decorateMiddle` with the foam rings;
  - the cannons (`cannon-mobile`, barrel along +Z, muzzle at `box.max.z`, yaw lerp `dt * 7`, recoil 0.24);
  - the particle bursts (`soft`, `push`);
  - the smooth fires and smoke;
  - the sinking tween;
  - the camera framing (`fov 42`, `camDir (0,1,0.78)`, half-height 5.4);
  - the screen shake.
- Board placement in the world: `me` at x = −7, `enemy` at x = +7. Both fleets use `ship-pirate-<large|medium|small>` for `galleon|brig|sloop`.
- The three.js code must only load in the browser. Import `three` inside client components or dynamically, never from server code.

- [ ] **Step 1: Write the failing tests** in `tests/client/battleship-sync.test.ts`:
  - `boardOf('a','a')` → `'me'`; `boardOf('a','b')` → `'enemy'`; `boardOf(null,'a')` → `'me'`.
  - `newShots(null, v)` returns every shot. With `prev` holding 2 shots by `a` and `next` holding 3 by `a` and 1 by `b`, it returns the 3rd `a` shot on board `'enemy'` (viewer `a`) and the `b` shot on board `'me'`.
  - A `sunk` ShotView in `next` comes with `sunkShip` equal to the matching ship in `next.fleets`.
- [ ] **Step 2: Run** `pnpm vitest run tests/client/battleship-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sync.ts`, then `models.ts` and `scene.ts`.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm lint && pnpm build`. Expected: PASS and no errors.
- [ ] **Step 5: Commit.** `git add package.json pnpm-lock.yaml src/client/battleship tests/client && git commit -m "feat(battleship): three.js scene"`

### Task 9: Match screen (placement, battle, result)

**Files:**
- Create:
  - `app/b/[code]/m/[matchId]/page.tsx`
  - `src/client/battleship/use-battle-scene.ts`
  - `src/client/battleship/placement-controls.tsx`
  - `src/client/battleship/battle-controls.tsx`
  - `src/client/battleship/match-hud.tsx`
- Test: manual (Task 10).

**Interfaces:**
- Consumes: `BattleScene`, `newShots` and `boardOf` (Task 8); `BattleMatchView` (Task 4); `centeredCells`, `validateFleet` and `randomFleet` (Task 1); `usePoll`, `apiPost`, `battleshipMatchChannel`.
- `useBattleScene(canvasRef): { scene: BattleScene | null; error: string | null }`. It loads the models once, creates the scene, and resizes it with a `ResizeObserver`.
- Page layout, matching the owner's sketch and the prototype:
  - **Info bar (`match-hud.tsx`):** both avatars and names, fleet pips (own hits red, enemy sunk greyed), the turn pill (`"Place your fleet"`, `"Your turn"`, `"Opponent's turn"`), and a clock showing whichever of `placingRemainingMs`, `turnRemainingMs` or `pendingRemainingMs` applies, counted down locally from `serverNow`.
  - **3D stage:** fills the middle, with toasts at the top and a hint line at the bottom.
  - **Bottom controls:** depend on the status.
- Polling: `usePoll<BattleMatchView>('/api/battleship/<code>/matches/<id>', 1_000, { channel: battleshipMatchChannel(code, id), liveIntervalMs: 2_000 })`. Action responses win when their `serverNow` is newer, as in the Caro match page.
- **Placing** (`placement-controls.tsx`). This is the prototype's behaviour:
  - a ship tray (Galleon, Brig, Sloop chips);
  - tap or drag on your sea, with a ghost from `centeredCells` that is green or red according to the overlap check;
  - tapping a placed ship picks it up;
  - the floating ↻ button sits over the last placed ship, and the bottom `↻ Rotate`, `READY` and `Random` buttons work as in the prototype.
  - Every change posts `fleet { ships, lock: false }`, debounced by 400 ms. READY posts `lock: true`.
  - After locking: the hint reads `"Waiting for <opponent> to place their fleet"`, and the controls are disabled.
  - The first paint after a reload rebuilds the tray from `view.fleets[you]`.
- **Playing** (`battle-controls.tsx`):
  - On your turn the camera focuses on `'enemy'`; on theirs, on `'me'`.
  - Tapping a cell you have not fired at sets the target. FIRE posts `fire { cell, seq: view.shots[you].length + 1 }`.
  - Every new shot from `newShots` plays through `scene.playShot`, one at a time and in order, before the camera pans to the next turn.
  - `not_your_turn` and `occupied` errors just trigger a refresh.
  - A Give up button (with an in-page confirm, never `confirm()`) posts `resign`.
  - When `missedTurns[you] >= 1`, a toast reads `"Missed turn: a random shot was fired for you (N/3)"`.
- **Watcher** (`you === null`): no controls; the badge reads `"👁 Watching"`.
- **Finished:** a result panel with the winner banner, shots fired, accuracy (`hits / shots`) and the end-reason copy:
  - `fleet_sunk` → "Fleet sunk"
  - `no_show` → "Opponent didn't show up"
  - `afk` → "Too many missed turns"
  - `disconnect_timeout` → "Opponent disconnected"
  - `resign` → "Opponent gave up"
  The panel has a Back to bracket button (`/b/<code>`) and, when `nextMatchId` is set, a Next match button. Both fleets are drawn.
- **Opponent disconnected:** a toast reads `"Opponent disconnected · <s>s"` while `opponentReconnectRemainingMs` is set.

- [ ] **Step 1: Build** the hook, the three components and the page.
- [ ] **Step 2: Run** `pnpm lint && pnpm build`. Expected: no errors.
- [ ] **Step 3: Commit.** `git add app/b src/client/battleship && git commit -m "feat(battleship): match screen"`

### Task 10: Assets, cleanup and end-to-end check

**Files:**
- Add to git: the 31 GLBs in `MODEL_NAMES` under `public/assets/Models/GLB format/`, plus `public/assets/Models/GLB format/Textures/colormap.png`, `public/assets/License.txt`, and `public/assets/Previews/ship-pirate-large.png` (used by the picker card).
- Delete: `public/battleship-preview.html`, `public/battleship-ui.html`.
- Do not delete or commit the rest of `public/assets/`.

- [ ] **Step 1: Stage exactly the files above.** Write a one-off node script in the scratchpad that imports `MODEL_NAMES` and runs `git add` per file. Then confirm with `git status --short public/assets` that only those files are staged.
- [ ] **Step 2: Delete** the two prototype pages, and run `pnpm vitest run && pnpm lint && pnpm build`. Expected: all green.
- [ ] **Step 3: Ask the owner** which database to use for manual testing. Suggest `MONGODB_DB=caro_dev`, and don't touch Atlas without a yes.
- [ ] **Step 4: Manual check** with `pnpm dev`, three tabs `?dev=1:Ann`, `?dev=2:Ben`, `?dev=3:Cal`, at a 400 px wide viewport:
  1. Ann creates a cup; Ben and Cal join through `/b/<code>?join=1`.
  2. Ann starts. The bracket shows one bye, and there is no 3rd-place match.
  3. In the playable match: place the fleet (tray, drag, ↻, Rotate, Random, READY), and reload mid-placement to confirm the ships come back.
  4. Fire until the match ends. Check the cannon, the hits, a sink reveal, and the camera panning between turns.
  5. Let a turn time out three times to see the `afk` loss.
  6. The winner plays the final against the bye player. The cup finishes and the podium appears.
  7. Open a live match from a fourth tab, `?dev=4:Dan`, and confirm the watcher sees only shots and sunk ships.
- [ ] **Step 5: Commit.** `git add -A public/battleship-preview.html public/battleship-ui.html && git commit -m "chore(battleship): commit used 3D assets, remove prototypes"` (the asset files are already staged from Step 1).
