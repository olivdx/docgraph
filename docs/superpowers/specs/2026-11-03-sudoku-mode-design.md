# Sudoku Mode: Design

Date: 2026-11-03
Status: Draft, waiting for owner review
Builds on: `2026-11-02-caro-tournament-design.md` (Caro Cup). Everything there still applies to Caro unless this document says otherwise.

## 1. Intent

The owner wants the Telegram Mini App to become **one game package with two modes**: the existing **Caro** (Caro Cup tournaments, unchanged) and a new **Sudoku** battle mode. When you open the app, you pick Caro or Sudoku.

Sudoku is for people only. There is no bot. You can play it **alone** (just solve a random puzzle against the clock), or **with others** in a room that works like a Caro Cup room: the host creates it, shares the link in a Telegram chat, people join, the host presses Start, and everyone races on **the same random puzzle**.

## 2. Goals, non-goals, anti-goals

**Goals**
- One Mini App with a home screen offering Caro and Sudoku.
- Standard 9×9 Sudoku, with a new random puzzle every game. Each puzzle has exactly one solution.
- Solo play: pick a difficulty, then solve against a 30-minute clock.
- Multiplayer rooms that work like Caro Cup rooms (create, share link, join, host starts). Everyone gets the same puzzle.
- A multiplayer winner, decided as the owner described:
  1. The first player to **completely and correctly solve** the puzzle wins right away.
  2. If time runs out and nobody has finished, the player with the **most correct cells** wins.
- A wrong number is **flagged immediately** and **costs 30 seconds** of that player's clock.
- The host chooses the difficulty.
- Reload-safe, like Caro: a player who reloads or reconnects comes back to the same grid and the same clock.

**Non-goals**
- Sudoku bots, or bots filling Sudoku rooms.
- Sudoku sizes other than 9×9, and Sudoku variants (killer, diagonal, and so on).
- Rankings, history, or stats across games. As in Caro, nothing is kept after a room ends.
- Changes to Caro gameplay.

**Anti-goals (failure even if it "works")**
- A player can read the solution from the client (devtools or the network tab) in a multiplayer room.
- A puzzle with more than one solution. The game would then mark a valid answer as "wrong."
- A reload costing someone their progress or resetting their clock.
- Vietnamese UI text. All UI text stays English (same rule as Caro).

## 3. Decisions made with the owner

| Topic | Decision |
|---|---|
| Packaging | Same Mini App. Home screen with two choices: Caro and Sudoku. |
| Bots | None in Sudoku. People only. |
| Player count | Solo or multiplayer, both supported. |
| Multiplayer flow | Rooms like Caro Cup: host creates, shares link, people join, host presses Start, and everyone gets the same puzzle. |
| Winner | First to finish correctly. If time runs out first, most correct cells. |
| Wrong entry | Flagged immediately, minus 30 s from that player's clock. |
| Time | 30 minutes per game. |
| Difficulty | The host chooses it (solo: the player chooses it). |

## 4. Calls made by Claude (owner may override)

**Home and routing**
- `/` becomes the game picker: two large cards, **Caro** and **Sudoku**. The current Caro home moves to `/caro`. Sudoku home is `/sudoku`. The app's top-level title becomes "Game Cup", with Caro Cup keeping its name inside the Caro section.
- Ref links keep the format `startapp=<code>`. Sudoku room codes are **5 characters**, while Caro codes are 6 (same alphabet). That makes the game obvious from the code alone: on boot, a 5-character code routes to the Sudoku room and a 6-character code routes to the Caro room. Existing Caro links keep working.
- On boot the app still jumps straight into your active room (Caro match, Caro room, or Sudoku room), exactly as Caro does today. Otherwise it shows the game picker.
- The "Game Cup" title is a placeholder until the owner names the package.
- "Where am I?" on boot covers both games. A user can be active in **only one room across both games**: a Caro tournament they're still alive in, or an unfinished Sudoku room. The same "You're already playing in <X> → Go back" banner is reused.

**Difficulty**
- Three levels, set by how many cells are given at the start: **Easy** 38–42, **Medium** 30–34, **Hard** 25–28. Default is Medium.
- Every generated puzzle is checked to have a unique solution before it's used.

**Entering numbers**
- Tap a cell, then tap a number on a 1–9 keypad below the grid. Given cells can't be changed.
- A **correct** number locks in. It turns the normal "filled" color and can't be erased. It doesn't need to be, because it's correct.
- A **wrong** number flashes red for about 1 s and then clears, with "−30 s" floating over the clock. The cell stays empty. This avoids a wrong number sitting on the grid and misleading the player.
- A **Notes** toggle lets players pencil in small candidate numbers. Notes are client-only (kept in local storage per room), never sent to the server, and never scored.
- Usual helpers: highlight the selected cell's row, column, and box, and highlight every cell with the same number. No "hint" button, because it would break a race.

**Clock**
- Each player has their own deadline: `startedAt + 30 min − 30 s × mistakes`. All players start at the same moment (when the host presses Start), so the clock is fair.
- When a player's deadline passes, their grid freezes, and their correct-cell count is final.
- The clock can go to zero through penalties alone. That ends that player's game early.

**Ending a multiplayer room**
- The room ends as soon as either of these happens:
  - someone finishes the puzzle (they win), or
  - every player has finished or run out of time.
- When someone wins by finishing, the others are stopped immediately. Their result screen shows the winner, and their own correct-cell count is recorded for the ranking.
- **Ranking** (for the result screen):
  1. Finishers, by finish time.
  2. Everyone else, by correct cells (more is better).
  3. Then by fewer mistakes.
  4. Then by who reached their last correct cell earlier.
- With the tie-breaks above, an exact tie is practically impossible. If one happens, players share the place.
- While playing, each player sees the others' **progress only**: name, avatar, a bar showing cells filled out of the cells to fill, and mistake count. Nobody sees another player's grid.

**Rooms**
- Minimum 2 players to start a multiplayer room. Maximum 32, same as Caro.
- Lobby screen same as Caro's: code, Share invite link, player list with host badge, a difficulty picker (host only; others see the chosen level), and Start (host) or Waiting (others). Leave and Cancel work the same as in Caro.
- **Give up:** during play a player can press Give up (with a confirm). Their grid freezes and they are ranked with the correct cells they had. A player who has finished, run out of time, or given up is no longer "active", so they are free to join another room right away (like an eliminated Caro player). A room in which everyone is done ends at once.
- **Start closes the room:** nobody can join once the host presses Start. Anyone who opens a running room's link sees it read-only: names, progress bars, and mistakes, never anyone's grid or the solution. After the room finishes, everyone who opens it sees the ranking and the solved grid.
- No disconnect penalty: Sudoku has no turns, so a player who drops out just keeps losing clock time. Reopening the app takes them back into the room.
- Deleted 10 minutes after the room ends. Lobbies with no Start are deleted after 2 hours (same TTL approach as Caro).

**Solo**
- Solo is fully local: the puzzle is generated in the browser, and the grid, clock, and mistakes are saved to local storage so a reload resumes it. No server calls, no room, no Telegram link. Cheating in solo only hurts the player, so the solution living in the browser is fine.
- Solo uses the same clock, penalty, and difficulty rules. When the solo game ends, it shows the time taken (or the correct cells if time ran out) and the mistakes, with **New game** and **Home** buttons.
- Starting a solo game doesn't make you "active." It doesn't block joining a room.

## 5. Architecture

Same Vercel shape as Caro: MongoDB is the source of truth for multiplayer, clients poll, time rules are settled lazily on each request, and identity comes from verified Telegram `initData`.

- **The solution never leaves the server** in multiplayer, until the room is finished. The client sends `{ cell, digit }`. The server answers correct or wrong, and updates that player's grid, mistake count, and deadline. The room view sends the puzzle's givens plus *your* grid, and only progress counts for others.
- **Puzzle generator:** a shared pure TypeScript module (used by the server for rooms and by the browser for solo). Fill a full grid with randomized backtracking, then remove cells in random order while a solver confirms the solution is still unique, until the target number of givens for the difficulty is reached. If the target isn't reached within a time box, start over. It must finish well inside a Vercel request (target under 200 ms, typically far less).
- **Settle** for a Sudoku room: mark players whose deadline has passed as timed out. If a player has finished, or everyone is done, finish the room and compute the ranking.
- **Concurrency:** the same version compare-and-set as Caro. Entries carry a client sequence number for idempotency, so a retried request can't double-charge a mistake.
- **Polling:** about 2 s in a Sudoku match (only others' progress changes), about 3 s in the lobby. Same stop-on-hidden behavior.
- Sudoku code lives beside Caro's: something like `src/sudoku/` (generator, rules, room logic, views) and `app/sudoku/...`, plus API routes under `app/api/sudoku/...`. It reuses the shared pieces (`telegram-auth`, `http`, `db`, `api`, `use-poll`, `telegram`).

## 6. Data model (MongoDB)

New collection `sudoku_rooms`:
- `_id` (the room code), `name`, `hostId`, `difficulty`: `easy | medium | hard`
- `status`: `lobby | playing | finished | cancelled`
- `puzzle`: 81 digits, with 0 for empty cells. `solution`: 81 digits (never sent to clients before `finished`).
- `players[]`: `{ userId, name, avatarUrl, joinedAt, grid (81 digits: givens plus that player's correct entries), mistakes, deadlineAt, finishedAt | null, timedOutAt | null, lastCorrectAt | null, lastSeq }`
- `startedAt`, `finishedAt`, `winnerId`, `ranking[]`
- `version`, `createdAt`, `expiresAt` (TTL index)

Room name defaults to "<host first name>'s Sudoku".

## 7. Screens

1. **Game picker (`/`)**: two cards, Caro and Sudoku, and a pinned "Resume" card if you're active in either game.
2. **Sudoku home**: **Play solo** (difficulty picker, then play), **＋ Create room**, and an "Open rooms" list (Join / View), like Caro's home.
3. **Sudoku lobby**: as described in section 4.
4. **Sudoku game**: clock at the top (turns red under 1 min), 9×9 grid with bold 3×3 box lines, number keypad, Notes toggle, and in multiplayer an opponents' progress strip. A number on the keypad greys out once all nine of that number are placed.
5. **Sudoku result**: winner banner, ranking list (place, name, cells or finish time, mistakes), your own result highlighted, and the full solved grid revealed. Buttons: **Back to Sudoku** (multiplayer) or **New game / Home** (solo).

Look: reuse the Caro app shell (dark slate) and its button and card styles. The grid itself is light, like the Caro board, so numbers read well.

## 8. Testing

- **Unit:** the generator always produces unique-solution puzzles in the given-count range for each difficulty; solver correctness; entry validation (given cell, already-filled cell, out-of-range digit, after deadline, after finish); penalty and deadline math; ranking order including tie-breaks; idempotent retries don't double-penalize.
- **Integration** (`mongodb-memory-server`, like Caro): a 3-player room to a finish win; a room ending by time-out with a most-cells winner; reload returns the same grid and clock; room views never contain `solution` before finish.
- **Manual:** multi-tab dev mode with fake users (as Caro), and solo play including a reload mid-game.

## 9. Left to the builder

Component structure, exact keypad and grid styling within the existing look, local-storage key names, the generator's internals (as long as it meets the uniqueness and timing rules), and the exact polling intervals.
