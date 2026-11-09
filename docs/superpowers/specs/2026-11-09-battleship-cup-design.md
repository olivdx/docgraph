# Battleship Cup: Design

Date: 2026-11-09
Status: Draft, waiting for owner review
Builds on: `2026-11-02-caro-tournament-design.md` (Caro Cup) and `2026-11-03-sudoku-mode-design.md` (Sudoku). Everything there still applies to Caro and Sudoku; this document only adds a third game.

## 1. Intent

The owner wants a third game in the Telegram Mini App: **Battleship**, played in 3D with the Kenney pirate kit already in `public/assets/Models/` (CC0 license, `public/assets/License.txt`).

Battleship is **tournament only and people only**. A host creates a cup, shares the invite link in a Telegram chat exactly as in Caro, friends join, the host starts, and the players fight a **Bo1 knockout bracket**. Each match: both players secretly place their fleet, then take turns firing at the other's sea until one fleet is sunk.

A throwaway prototype shows the intended look and feel: `public/battleship-preview.html` (playable vs a local AI) and `public/battleship-ui.html` (static screen mockups). They are references, not code to keep (see section 10).

## 2. Goals, non-goals, anti-goals

**Goals**
- Battleship as the third card on the game picker (`/`), next to Caro and Sudoku.
- Cup rooms that work like Caro Cup rooms: create, share the Telegram invite link, join, host presses Start.
- Knockout bracket, every match Bo1, 2 to 32 human players.
- A 3D match screen in the style of the prototype: fleet placement, aiming, cannon fire, hits, misses, sinking.
- The server alone knows where ships are. A player can never learn the opponent's layout from the client.
- Reload-safe, like Caro: a reload or reconnect returns to the same match state and clocks.

**Non-goals**
- Playing against the computer, in any form: no bots in brackets, no solo/practice mode. (The prototype's AI is not carried over.)
- Choosing a match format. There is no Bo1/Bo3/Free picker; Battleship is always a Bo1 cup.
- Bot difficulty settings, rankings, history, stats across rooms.
- Any change to Caro or Sudoku gameplay.

**Anti-goals (failure even if it "works")**
- Ship positions of the opponent visible in any API response, Ably message, or client state before that ship sinks or the match ends.
- A reload losing a placed fleet, a shot, or resetting a clock.
- A stalled match: two players who stop playing must still produce a winner through clocks.
- Vietnamese UI text. All UI text is English (same rule as Caro and Sudoku).
- A recreation of an existing commercial game's branding or art. Use the Kenney kit and the project's own UI.

## 3. Decisions made with the owner

| Topic | Decision |
|---|---|
| Packaging | Third game in the same Mini App. |
| Invite | Same mechanism as Caro: `https://t.me/<bot>/<app>?startapp=<code>`, shared through Telegram's share sheet. |
| Mode | Tournament only. |
| Format | Bo1, no picker. |
| Opponents | Humans only. No bots, no play-vs-computer mode at all. |
| 3D | Models from the Kenney pirate kit in `public/assets/Models/GLB format/`. Both fleets use the pirate ships. |
| Layout | Phone screen: info bar on top, 3D view in the middle, one round action button at the bottom (owner's sketch). |
| Water | Simple, calm, flat blue with a very soft swell. No sparkles. |
| Placement | A fleet-placement step before battle: drag/tap to place, Rotate (bottom button and a floating ↻ button over the selected ship), Random, Ready. |
| Decor | Islands, forts, wreck, flotsam, foam rings around islands (as in the prototype). |

## 4. Calls made by Claude (owner may override)

**Rules of one match**
- Sea 6×6, columns A–F, rows 1–6. Fleet: **Galleon** (3 cells), **Brig** (2), **Sloop** (2). Ships are straight lines, horizontal or vertical.
- Placement rule: ships may not overlap; touching is allowed. (Random placement still avoids touching, as the prototype does, because it looks cleaner.)
- Who fires first is random. Turns strictly alternate; a hit does **not** grant another shot.
- A ship sinks when all its cells are hit. When it sinks, its position is revealed to the shooter. The match ends when one fleet is fully sunk.
- With 7 ship cells out of 36, a match is at most 70 shots (35 each); in practice 20–40.

**Match flow and clocks**
- `pending`: created when both slots are filled. Ready check exactly like Caro: a player is ready the first time they open the match screen. No-show rule: not opened within 60 s of `pending` loses with `no_show`; if both no-show, the higher seed advances.
- `placing`: starts when both are ready. Each player has **45 s** to place and press Ready. A player who hasn't locked in when the 45 s run out gets the rest of their fleet placed randomly (ships already placed are kept) and is locked in. Battle starts as soon as both are locked in.
- `playing`: each turn has **20 s**. When it runs out, the server fires one random shot at an unfired cell for that player. **Three missed turns in a row** lose the match with `afk`. A shot the player makes resets their counter.
- Animation grace: after any shot, the next turn's deadline is `shot time + 3 s + 20 s`. The 3 s (`SHOT_GRACE_MS`) cover the poll delay and the cannon/hit animation; the client counts down only the 20 s part, so the player always sees a full 20 s. The very first turn has no grace.
- Presence and disconnect: same as Caro (heartbeat from match-screen polls, disconnected after 5 s, loses with `disconnect_timeout` after 35 s), during `placing` and `playing`.
- **Give up** button during `placing` and `playing`, with a confirm: loses the match with `resign`.
- End reasons: `fleet_sunk`, `no_show`, `afk`, `disconnect_timeout`, `resign`.

**Tournament**
- 2 to 32 players; Start needs at least 2. Start closes the room to new joiners.
- Bracket size is the next power of two. Empty slots are **byes**: a player paired with a bye advances at once, without playing. Byes are spread randomly so no player gets two byes before anyone has played (the existing `planBracket` already spreads bots this way; Battleship needs the same idea with byes instead of bot players).
- 3rd-place match between the semifinal losers, as in Caro, when the bracket has semifinals (4+ players). If a semifinal was decided by a bye there is no loser for that side; then there is no 3rd-place match.
- A player knocked out is no longer "active" and may join another room right away (same as Caro).
- Lobby TTL 2 h, finished rooms deleted after 10 min (same as Caro).

**Home, routing, codes**
- `/battleship`: Battleship home with **＋ Create cup** and an "Open cups" list (Join / View), like Caro's home.
- Room codes are **4 characters**, same alphabet as Caro. Caro is 6, Sudoku 5, so the game is known from the code: `roomPath` routes a 4-character code to `/b/<code>`. Existing Caro and Sudoku links keep working.
- Room page `/b/<code>` (lobby, then bracket), match page `/b/<code>/m/<matchId>`. The app auto-routes a player to their ready match, as Caro does.
- One active room per user across all three games; `/api/me` and the "You're already playing in X" banner learn the new game.
- Room name defaults to "<host first name>'s Battle".

**Watching**
- Anyone with the link can watch a live or finished match read-only, like Caro. Watchers see **shots only** on both seas (hits, misses, sunk ships), never unsunk ships. After the match ends, both fleets are shown.

**Screens** (look follows the prototype and the existing app shell)
1. Game picker: add a Battleship card.
2. Battleship home: Create cup, Open cups.
3. Lobby: code, Share invite link, player list with host badge, Start (host, enabled at 2+) or Waiting. Leave / Cancel as in Caro. No format or bot pickers.
4. Bracket: as Caro's, Bo1 scores, byes shown as "bye".
5. Match, placement step: your sea, tray of three ships, ghost preview with green/red cells, floating ↻ button over the selected ship, bottom Rotate / READY / Random, 45 s clock.
6. Match, battle: info bar (both avatars, fleet pips, turn clock), 3D view panning between the pirate sea (your turn) and your sea (their turn), cannons that aim and fire, mini-map of your fleet, bottom FIRE button with the target coordinate.
7. Result: winner banner, shots and accuracy, both fleets revealed, buttons Back to bracket / Home.

## 5. Architecture

Same Vercel shape as Caro and Sudoku: MongoDB is the source of truth, time rules are settled lazily on each request, identity comes from verified Telegram `initData`, and Ably is only a doorbell.

- **Hidden information.** Fleets live only in the room document. The match view for a player contains: their own fleet, all shots both ways with results, and the cells of the opponent's **sunk** ships. Watchers get shots and sunk ships only. Full fleets are included only once the match is `finished`. Ably messages carry nothing but `{ v: version }`.
- **API** (shape mirrors Sudoku/Caro; names are suggestions):
  - `POST /api/battleship` create; `GET /api/battleship/<code>` room view; `POST /api/battleship/<code>/<action>` join, leave, start, cancel.
  - `GET /api/battleship/<code>/matches/<id>` match view (also the presence heartbeat and the settle trigger).
  - `POST …/matches/<id>/fleet { ships: [{ key, cells }], lock: boolean }`: save the layout during `placing`; `lock: true` is Ready. The server validates shape, bounds and overlaps.
  - `POST …/matches/<id>/fire { cell, seq }`: only on your turn; `seq` makes retries idempotent. Response is the updated match view (hit, miss, sunk).
  - `POST …/matches/<id>/resign`.
- **Settle** for a match: no-show, placement deadline (auto-place and lock), turn deadline (random shot, missed-turn count, `afk`), disconnect timeout, then advance the bracket. Same version compare-and-set as Caro for concurrency.
- **Realtime:** channels `battleship:<code>` (lobby/bracket) and `battleship:<code>:<matchId>` (match), `changed` doorbell after each write. The token endpoint's capability gains `battleship:*`. No fast `move`-style signal in the first version.
- **Polling:** match screen 1 s (2 s while Ably is live), lobby/bracket 3 s (15 s with Ably), home 10 s; stop when hidden. Same as Caro.
- **Code layout:** `src/battleship/` (rules: placement validation, random fleet, shot resolution; room and match logic; views), `src/server/battleship-service.ts` and a Mongo store, `app/battleship/…`, `app/b/[code]/…`, `app/api/battleship/…`. Reuse `telegram-auth`, `http`, `db`, `api`, `use-poll`, `telegram`, realtime, and the bracket helpers from `src/tournament/bracket.ts` (generalized for byes) without changing Caro behavior.
- **3D client:** `three` as an npm dependency (exact version pinned), used in a client-only component. Models load from `/assets/Models/GLB format/*.glb` (they reference `Textures/colormap.png` next to them). The scene, camera framing, cannon aiming/recoil, effects, decor, placement ghost and floating ↻ button follow the prototype.

## 6. Data model (MongoDB)

New collection `battleship_rooms`, one document per cup with matches embedded (like Caro's `rooms`):
- `_id` (4-char code), `name`, `hostId`, `status`: `lobby | running | finished | cancelled`
- `players[]`: `{ userId, name, avatarUrl, seed, joinedAt }`
- `totalRounds`, `matches[]`, `winnerId`, `version`, `createdAt`, `expiresAt` (TTL index)
- Match: `{ id, round, slot, kind: normal | third_place, a, b (userId | null; null with a bye), status: waiting | pending | placing | playing | finished, pendingSince, readyAt { a, b }, placingDeadlineAt, fleets { a, b: Ship[] }, locked { a, b }, firstShooter, turn (userId), turnDeadlineAt, missedTurns { a, b }, shots: [{ by, cell, result: miss | hit | sunk, shipKey?, at, seq }], lastSeenAt { a, b }, winner, endReason, startedAt, finishedAt }`
- Ship: `{ key: galleon | brig | sloop, cells: number[] }` (cell = row × 6 + col)

## 7. Assets

- Only the GLB files the game uses are loaded (ships, cannon, cannonball, flags, islands, rocks, palms, tower, dock, rowboat, wreck, chest, crate, barrel, bottle, ghost ship): 31 files, about 1.6 MB.
- Committed: exactly those GLB files, `public/assets/Models/GLB format/Textures/colormap.png`, and `public/assets/License.txt` (CC0). The rest of the kit (FBX, OBJ, unused GLBs, previews, `.url` shortcuts) stays untracked on the owner's disk; nothing is deleted.

## 8. Testing

- **Unit:** fleet validation (bounds, straightness, lengths, overlaps, wrong ship set); random fleet always valid; shot resolution (miss, hit, sunk, repeat cell refused, not your turn refused, idempotent `seq` retry); fleet-sunk detection; placement-deadline auto-place keeps already-placed ships; turn timeout random shot and the 3-missed-turns `afk` rule; bracket with byes for 2, 3, 5, 7, 8, 32 players; 3rd-place rule with byes.
- **Hidden information:** every view variant (player, opponent, watcher) before finish never contains unsunk opponent cells; after a sink only that ship is revealed; after finish both fleets appear.
- **Integration** (`mongodb-memory-server`, like Caro): a 3-player cup played to a winner; a match won by `afk`; reload mid-placement keeps the placed ships and clock.
- **Manual:** multi-tab dev mode with fake users (`?dev=id:name`), on a phone-sized viewport and in a real Telegram client. New optional env `MONGODB_DB` overrides the database name (default `caro`), so local testing can use e.g. `caro_dev` instead of production data. Still ask the owner before running any test against the Atlas cluster.

## 9. Open for the owner

- None blocking. The timings (45 s placement, 20 s turn, 3 missed turns) and the "touching allowed" rule are Claude's calls and easy to change.

## 10. Left to the builder

Component structure; exact 3D scene code (follow the prototype's look); how the bracket helper is generalized for byes; API route names; local-storage keys; exact polling intervals; whether to share Caro's lobby/bracket components or copy them. The prototype files `public/battleship-preview.html` and `public/battleship-ui.html` are throwaway references: delete them once the real screens exist.
