# Caro Telegram 2P - Design Spec

Date: 2026-04-23
Status: Draft for review
Owner: Product + Engineering

## 1) Scope and Goals

This spec defines the MVP design for a two-player Caro game running inside Telegram WebApp, with a Next.js server backend.

MVP goals:
- Support both private room and quick match.
- Enforce Caro rule: 5 in a row wins only if not blocked at both ends.
- Support reconnect grace period: 30 seconds, otherwise disconnect loss.
- Support per-turn time limit: 25 seconds, timeout is a loss.
- Provide mobile-first board interaction: large cells with pan/scroll.
- Persist match history and update ranking via ELO.

Out of scope for this MVP:
- Bot AI mode.
- Spectator mode.
- Tournament mode.
- Cross-device synchronized multi-session control for one user.

## 2) Product Decisions Already Confirmed

- Match modes: private room + quick match.
- Win rule: 5+ connected stones, both ends blocked means not a win.
- Disconnect handling: reconnect within 30s or lose.
- Board UX on phone: larger tap targets, allow pan/scroll.
- Competitive progression: include ranking/ELO.
- Turn clock: strict per-turn timeout enabled, 25s default.

## 3) Architecture Overview

Recommended architecture: in-memory authoritative game engine with asynchronous DB persistence.

Main components:
- Telegram WebApp client
  - Renders board and HUD (turn, timers, reconnect status).
  - Sends user intents only (create/join/move/resign/rematch).
  - Applies server snapshots/events to render state.
- Realtime gateway (Next.js runtime)
  - Authenticates Telegram `initData`.
  - Manages realtime sessions and room subscriptions.
  - Forwards actions to game engine and returns authoritative updates.
- Game engine (authoritative in memory)
  - Owns active match states (board, turn, timers, connectivity).
  - Validates and applies moves.
  - Determines end-game outcomes and reasons.
- Matchmaking and room service
  - Quick match queue (FIFO for MVP).
  - Private room create/join by code.
  - Starts match and assigns X/O roles.
- Persistence layer
  - Stores users, matches, moves, rating changes.
  - Updates ELO at match end.

Rationale:
- Keeps latency low for mobile gameplay.
- Keeps implementation simple enough for MVP.
- Supports later migration to Redis-backed shared state via a `GameStateStore` interface.

## 4) Data Model

### 4.1 Persistent tables

`users`
- `id` (pk)
- `telegram_user_id` (unique)
- `display_name`
- `avatar_url` (nullable)
- `rating` (default 1200)
- `games_played` (default 0)
- `wins` (default 0)
- `losses` (default 0)
- `created_at`

`matches`
- `id` (pk)
- `mode` (`quick` | `private`)
- `status` (`ongoing` | `finished`)
- `player_x_id` (fk users)
- `player_o_id` (fk users)
- `winner_id` (nullable fk users)
- `end_reason` (`five_in_row` | `turn_timeout` | `disconnect_timeout` | `resign`)
- `board_size`
- `started_at`
- `ended_at` (nullable)

`match_moves`
- `id` (pk)
- `match_id` (fk matches)
- `move_no`
- `player_id` (fk users)
- `x`
- `y`
- `played_at`

`rating_changes`
- `id` (pk)
- `match_id` (fk matches)
- `user_id` (fk users)
- `rating_before`
- `rating_after`
- `delta`
- `created_at`

### 4.2 In-memory authoritative state

`GameState`
- `matchId`
- `mode`
- `board`
- `boardSize`
- `currentTurn` (`X` | `O`)
- `moveNo`
- `turnDeadlineAt`
- `players` (session/online info per side)
- `disconnectDeadlineAt` (optional per disconnected player)
- `status` (`waiting` | `playing` | `finished`)
- `winner` (nullable)
- `endReason` (nullable)

## 5) Realtime Event Contract

### 5.1 Client -> Server

- `auth.init`
  - payload: `{ telegramInitData }`
- `room.createPrivate`
  - payload: `{ preferredBoardPreset }`
- `room.joinPrivate`
  - payload: `{ roomCode }`
- `queue.joinQuickMatch`
  - payload: `{ preferredBoardPreset }`
- `game.makeMove`
  - payload: `{ matchId, x, y, clientMoveNo }`
- `game.resign`
  - payload: `{ matchId }`
- `game.requestRematch`
  - payload: `{ matchId }`
- `presence.ping` (optional heartbeat)

### 5.2 Server -> Client

- `match.found` / `room.ready`
  - payload: match metadata and assigned side.
- `game.state`
  - full snapshot, used for initial sync and reconnect sync.
- `game.moveAccepted`
  - accepted move, next turn, next deadline.
- `game.invalidMove`
  - reason code (`not_your_turn`, `occupied_cell`, `game_finished`, and others).
- `player.disconnected`
  - disconnected player and reconnect deadline.
- `player.reconnected`
  - reconnected player.
- `game.ended`
  - winner, end reason, optional winning line metadata.
- `rating.updated`
  - before/after rating and delta for both players.

### 5.3 Contract guarantees

- Server is always source of truth for game state.
- `game.makeMove` is idempotent using `clientMoveNo`.
- Reconnect always receives `game.state` snapshot first, then incremental events.

## 6) Core Game Logic

### 6.1 Move validation

Reject move if:
- Match is not in playing state.
- Player is not a match participant.
- It is not player turn.
- Coordinates are out of bounds.
- Target cell is already occupied.

### 6.2 Win detection with blocked-ends rule

For latest move, evaluate 4 directions:
- Horizontal `(1, 0)`
- Vertical `(0, 1)`
- Main diagonal `(1, 1)`
- Anti diagonal `(1, -1)`

For each direction:
1. Count contiguous same-side stones both positive and negative.
2. Compute chain length.
3. Check the two outer boundary cells beyond the chain.
4. If chain length >= 5 and not blocked at both ends, declare winner.

Blocked end definition:
- End is blocked if next boundary is out of board, or occupied by opponent stone.
- End is open if next boundary is empty.

If chain length >= 5 but both ends blocked, no win is declared.

### 6.3 Timer rules

- Turn timer starts at turn begin: `turnDeadlineAt = now + 25s`.
- If deadline reached before a valid move, current side loses with `turn_timeout`.
- On valid move, timer resets for next side.

### 6.4 Disconnect rules

- On disconnect, mark side offline and broadcast `player.disconnected`.
- Start grace timer: `disconnectDeadlineAt = now + 30s`.
- If reconnect occurs before deadline:
  - restore session binding.
  - send full `game.state`.
  - continue match.
- If deadline expires before reconnect:
  - disconnected side loses with `disconnect_timeout`.

## 7) Matchmaking and Room Flows

### 7.1 Quick match

- User enters queue.
- FIFO pairing when two eligible users available.
- Create match, assign X/O, initialize state, emit `match.found`.

### 7.2 Private room

- Host creates room and receives room code/link.
- Guest joins by code.
- On successful join, create match, assign X/O, emit `room.ready`.

## 8) Ranking and ELO

MVP ELO configuration:
- Initial rating: 1200
- K-factor: 32

Expected score:
- `E = 1 / (1 + 10 ^ ((R_opp - R_player) / 400))`

Update:
- `R_new = R_old + K * (S - E)`
- `S = 1` for win, `S = 0` for loss.

Policy:
- `turn_timeout`, `disconnect_timeout`, and `resign` all count as normal losses.
- Persist rating change records in `rating_changes`.

## 9) Mobile UX Requirements (Telegram WebApp)

- Board uses large touch targets for move accuracy.
- Viewport supports pan/scroll for full-board navigation.
- Current turn and turn timer must stay visible in fixed HUD.
- Disconnect/reconnect countdown must be clearly visible.
- Reconnect and snapshot resync should not require manual refresh.

## 10) Reliability and Anti-abuse Baseline

- Verify Telegram `initData` on session bootstrap.
- Authorize all match actions by user identity and match membership.
- Apply per-user and per-session rate limiting for action endpoints/events.
- Log suspicious patterns (invalid move bursts, reconnect abuse).

## 11) Testing Strategy

### 11.1 Unit tests

- Move validation paths.
- Win-detection edge cases for blocked-ends rule.
- Turn-timeout behavior.
- Disconnect grace behavior (recover in-time vs lose on expiry).

### 11.2 Integration tests

- Quick match end-to-end flow.
- Private room end-to-end flow.
- Reconnect in active match with state resync.
- Near-simultaneous move submissions and single accepted action.

### 11.3 Client smoke tests

- Mobile board interaction (tap + pan/scroll).
- Turn indicator and timer accuracy.
- Reconnect UX and post-reconnect state correctness.

## 12) Delivery Phases

Phase 1:
- Realtime engine, quick/private match, rules, timers, reconnect.

Phase 2:
- Persistence for history, ELO update, leaderboard endpoints.

Phase 3:
- Mobile polish, rematch UX, telemetry and operational visibility.

## 13) Risks and Future Migration Notes

Known MVP risk:
- In-memory match state is instance-local.

Mitigation:
- Define `GameStateStore` abstraction from day one.
- Keep engine APIs independent of storage backend.

Future migration:
- Replace in-memory store with Redis-backed state and pub/sub fanout for multi-instance scaling.

## 14) Acceptance Criteria

MVP is acceptable when:
- Two users can complete games through both quick and private modes.
- Win/loss outcomes match blocked-ends Caro rule.
- 25s turn timeout and 30s reconnect timeout behave deterministically.
- Match results and ELO updates are persisted and queryable.
- Mobile Telegram gameplay remains usable with large-cell + pan/scroll board UX.
