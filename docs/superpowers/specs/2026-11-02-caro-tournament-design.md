# Caro Cup: Tournament Mode Design

Date: 2026-11-02
Status: Ready for owner review
Supersedes: `2026-04-23-caro-telegram-2p-design.md` (quick match, private 1v1 rooms, ELO, Postgres/Prisma are all dropped)

UI reference mock: `.superpowers/brainstorm/2751-1793605468/content/flow-v5.html` (approved look and flow)

## 1. Intent

Caro Cup is a Telegram Mini App for running small knockout tournaments of Caro (gomoku with the blocked-ends rule) among friends. Anyone can create a tournament, share a link in a Telegram chat, have people sign up, and then play through a bracket until there's a champion. When a tournament has too few players, bots fill the empty slots, and they should be real opponents.

It's for fun, not ranking. Nothing about the players is kept once a tournament is over.

## 2. Goals, non-goals, anti-goals

**Goals**
- Anyone can create a tournament and invite people with a Telegram link.
- Single-elimination bracket with a 3rd-place match, played to a champion.
- Bots fill missing slots and play genuinely hard.
- A player who reloads, closes Telegram, or loses connection mid-game comes back to the exact game state (same board, same turn, same clock).
- Runs on Vercel.

**Non-goals**
- 1v1 quick match or private 1v1 rooms. The app is tournaments only.
- ELO, rankings, match history, player profiles.
- Spectating someone else's live game (people can only see the bracket).
- Telegram bot messages or notifications ("your match is ready"). There is no bot webhook. Players learn their match is ready only inside the app.
- Multi-game series. Every match is one game.

**Anti-goals (failure even if it "works")**
- A reload or brief network blip costs someone their game or seat.
- A bot that is trivially easy to beat.
- Tournament or player data that sticks around after the tournament is over.
- UI text in Vietnamese. All UI text is English.

## 3. Decisions made with the owner

| Topic | Decision |
|---|---|
| Who can create | Anyone |
| Joining | Home lists open rooms (no code-entry box). Opening the app via a ref link (`startapp=<roomCode>`) skips Home and goes straight into that room's lobby, auto-registering if it's still in the lobby phase. |
| Registration | Sign-up only, using the Telegram identity (id, display name, avatar). No accounts. |
| Start | The host presses Start, which locks the roster. |
| Bracket size | Round up to the next power of 2. Empty slots become bots. |
| Bots | A real player paired with a bot plays a real game against it. Bot strength is set to "you have to genuinely try to win." |
| Match format | One game per match. |
| Rules | 5 in a row wins **unless both ends are blocked**. 25 s per turn (timeout = loss). 30 s reconnect grace (expiry = loss). |
| Storage | MongoDB (existing Atlas cluster). Tournament data is deleted after the tournament ends. No ELO. |
| Hosting | Vercel |
| Language | English UI |
| Look | Dark slate app shell, bracket as in the owner's screenshot. Board is a light "graph paper" grid with blue X and red O, both drawn with thick (≈4px) strokes and centered in the cell. The last move is highlighted. No zoom: fixed 32 px cells, drag to pan, and a single ⌖ button that recenters on the last move. Beyond the board edge the dark shell shows. |

## 4. Calls made by Claude (owner may override)

- Minimum 2 real players to start. Maximum 32 players.
- Round-1 seeding is random. Bots are placed so that every bot faces a real player in round 1. Bot-vs-bot in later rounds is simulated instantly server-side.
- A human vs. a bot: the human plays X and moves first. A human vs. a human: X is assigned at random.
- **Leaving the lobby is explicit only.** There's a **Leave** button for players and a **Cancel tournament** button for the host. Closing the app or switching chats never removes anyone from the lobby.
- A player can be in only one active tournament at a time. "Active" means not yet eliminated: an eliminated player is free to join another tournament but can still view the old bracket. Home pins the active tournament on top with a **Resume** button.
- If a ref link to room B is opened while the user is active in room A, the user sees B read-only with a banner "You're already playing in <A> → Go back". A ref link to a running or finished room opens its bracket read-only.
- The mock's "deleted once everyone leaves" text changes to "This room closes in 10 minutes."
- Matches in a round run in parallel. The next round's match opens as soon as both its feeder matches are finished (it doesn't wait for the whole round).
- The 3rd-place match is between the semifinal losers. It's played in parallel with the final.
- The tournament is deleted 10 minutes after it ends, and lobbies with no Start are deleted 2 hours after creation (MongoDB TTL index).
- 100×100 board (−50..49), drag to pan, centered on (0,0). The board edge counts as a blocking end. Moves outside −50..49 are rejected (`out_of_bounds`).
- Bot "thinking" delay is 0.5–1 s, so its moves feel natural.
- Tournament name defaults to "<host first name>'s Cup". The host can edit it at creation.
- Prisma and Postgres are removed from the project. `src/server/persistence/elo.ts` and its test are deleted.

## 5. Architecture (Vercel-shaped)

Vercel has no long-lived processes and no WebSocket server, so:

- **MongoDB is the single source of truth** for all live state: tournaments, matches, board, clocks, and presence. No in-memory state is relied on between requests.
- **Clients poll.** Each screen polls a state endpoint about every 1 s, sending the version it has, and the server answers "unchanged" cheaply. Polling also counts as the presence heartbeat. (Server-Sent Events capped below the function timeout is an acceptable alternative if the builder prefers. Plain polling is the baseline.)
- **Time-based rules are evaluated lazily.** Turn deadlines and reconnect deadlines are stored as timestamps. Any request that touches a match (a poll or a move from either side) first "settles" the match: it applies any expired deadline (timeout loss, disconnect loss) and any due bot move, then responds. Because the opponent of the stalled player is polling, a stall is always settled within about 1 s.
- **Bracket progression is lazy too.** Settling a finished match advances the winner into the next bracket slot, creates the next match when both slots are filled, and runs bot-vs-bot matches to completion inline.
- **Concurrency.** Every match/tournament document carries a `version`. Writes are compare-and-set (`findOneAndUpdate` on `{_id, version}`), and a write that loses the race re-reads and re-settles. Moves carry `clientMoveNo` for idempotency.
- **Bot moves.** Compute happens inside the request that settles the match once `botMoveDueAt` has passed. It must finish well under Vercel's function limit, so target under 300 ms of search per move.

### Identity
- The client sends Telegram `initData` with every request. The server verifies its HMAC with the bot token and extracts the Telegram user. There are no cookies or sessions.
- "Rejoin after reload" works because seats are keyed by Telegram user id. On load, the app asks the server "where am I?" and routes to that user's active match, else their tournament's lobby or bracket, else Home (or the ref room if `start_param` is present).
- Dev mode (`NODE_ENV=development` only): a fake user can be chosen with a query param so the app can be tested in a normal browser with several tabs.

### Match start (ready check), Claude's call
- A new match is created as `pending` as soon as both slots are filled. Clocks do **not** run yet.
- Each human becomes "ready" the first time they open the match screen. The bracket shows "Your match is ready → Enter match", and the app auto-routes them there on next load. A bot is always ready.
- When both sides are ready, the match switches to `playing` and the first turn clock starts.
- **No-show rule:** if a human hasn't opened the match within 60 s of it becoming `pending`, they forfeit with `endReason: no_show`. If both no-show, the higher seed advances.

### Realtime (Ably), added 2026-11-04

- Ably is a doorbell, not a data channel. After every successful write the server publishes `changed` with `{ v: version }` on the affected channels: `caro:<code>` when the lobby/bracket shape changes, `caro:<code>:<matchId>` for each match that changed, and `sudoku:<code>` for any Sudoku room write. Clients re-fetch through the normal API, so MongoDB stays the single source of truth and no game data (or Sudoku solution) goes through Ably.
- Publishing runs in Next's `after()`, so a move's response never waits on Ably. Failures are logged and ignored.
- `GET /api/realtime/token` (Telegram-authenticated) returns a signed Ably token request: subscribe-only on `caro:*` and `sudoku:*`, 1 hour. Clients can't publish. Without `ABLY_API_KEY` the endpoint returns 404, the client never loads the SDK, and everything runs on polling alone.
- While the channel is live, polling relaxes: lobby/bracket 3 s → 15 s, Sudoku room 2 s → 5 s. The Caro match screen goes 1 s → 2 s vs a human (it's still the presence heartbeat; disconnects show after 5 s), with an extra fetch just after each known deadline. It stays at 1 s vs a bot, because a bot reply is only played when a request settles the match.
- After a realtime reconnect, the screen re-fetches once to cover missed signals.

### Polling budget, Claude's call
- Design for the free tiers (Vercel Hobby, Atlas M0). Use the global cached `MongoClient` pattern, with a small pool.
- Adaptive polling: about 1 s on the Match screen, about 3 s on Lobby and Bracket, about 10 s on Home. Polling stops when the page is hidden (`visibilitychange`). Presence is only needed during a match, and the returning player re-polls on visibility.
- Bot-vs-bot matches are decided with a fast, shallow bot (no deep search, a few ms per move), so a whole game completes in one request well under the function timeout. Human-vs-bot uses the full-strength bot.

### Presence and disconnect
- `lastSeenAt` per player per match is updated on every Match-screen poll. It only applies once the match is `playing`.
- A player is shown as "disconnected" when `now − lastSeenAt > 5 s`. They lose by `disconnect_timeout` when `now − lastSeenAt > 35 s` (5 s detection plus 30 s grace).
- Turn timeout applies independently. Whichever deadline hits first decides the game.

### Environment
- MongoDB: the existing `User` / `pass` variables in `.env`, host `labs.wnk6exl.mongodb.net`, database `caro`. Build the URI from those. Never hard-code credentials.
- New variables to add (the owner will fill these in): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_MINIAPP_SHORTNAME`. The ref link format is `https://t.me/<BOT_USERNAME>/<MINIAPP_SHORTNAME>?startapp=<roomCode>`.
- Next.js 16 has breaking changes. Read `node_modules/next/dist/docs/` before writing route handlers or other app code.

## 6. Data model (MongoDB)

`tournaments`
- `_id`, `code` (6 chars, unique, A–Z/2–9 without ambiguous chars), `name`, `hostId`
- `status`: `lobby | running | finished | cancelled`
- `players[]`: `{ userId, name, avatarUrl, isBot, seed }`
- `bracket`: rounds → slots, each slot referencing a `matchId` or empty
- `version`, `createdAt`, `startedAt`, `finishedAt`, `expiresAt` (TTL index)
- `placements`: champion / runner-up / 3rd, once known

`matches`
- `_id`, `code` (short match code shown in UI, e.g. `#A3F9`), `tournamentId`, `round`, `slot`, `kind`: `normal | third_place`
- `players`: `{ X: {userId, isBot}, O: {userId, isBot} }`
- `moves[]`: `{ x, y, side, at }`. The board is derived from the moves (a sparse board keyed by cell; only occupied cells exist).
- `turn`, `turnDeadlineAt`, `botMoveDueAt?`, `lastSeenAt: { X, O }`
- `status`: `pending | playing | finished`, `readyAt: { X?, O? }`, `pendingSince`, `winner`, `endReason`: `five_in_row | turn_timeout | disconnect_timeout | resign | no_show | board_full`, `winLine?`
- `version`, `expiresAt` (TTL, same as its tournament)

A draw (board full) is practically impossible on 100×100. `board_full` remains only as a safety cap for bot-run games: a bot-vs-bot game (or a due bot move) at 900 moves without a winner ends with X winning, recorded as `endReason: board_full`.

## 7. Screens (see mock)

1. **Home**: title, greeting, a **＋ Create** button, "Your tournament" (pinned with Resume, if any), "Open rooms" (lobby rooms with **Join**, running rooms with **View**), pull to refresh.
2. **Lobby**: room code, **Share invite link** (opens Telegram share with the ref link), player list (host badge), a "N players → M-slot bracket, K bots added" hint, and **Start tournament** (host only, enabled when there are 2 or more humans). Non-hosts see "Waiting for host to start…".
3. **Bracket**: horizontally scrollable rounds (Round of 32 … Quarterfinal, Semifinal, Final, 3rd-place). Winners are bold with a green score, losers are dimmed, live matches are tagged, and your match is outlined. A "Your match is ready → Enter match" card appears when applicable.
4. **Match**: HUD with both players, mark, turn state and countdown. A disconnect banner shows the reconnect countdown. The board is dragged to pan (no zoom, no pinch; a short tap places a stone, a drag of 8 px or more only pans) with a ⌖ recenter button, and there's a Resign button (with confirm). Move number and match code are shown.
5. **Result**: win/lose card after each match. Champion screen with podium when the tournament ends, then **Back to rooms**.

## 8. Game logic

- **Move validation:** the match is playing, the caller is a participant, it's their turn, the cell is in bounds and empty, and the deadline hasn't passed.
- **Win check** on the last move in 4 directions: count the contiguous chain. It wins if `length ≥ 5` and at least one end is open. An end is blocked by the board edge or an opponent stone.
- **Bot:** threat-based evaluation (open/closed 2-3-4, double threats) that understands the blocked-ends rule, plus alpha-beta search over candidate moves near existing stones (depth around 4, time-boxed). It always takes an immediate win and always blocks an immediate opponent win or open four. The target is that a casual player loses most games against it.

## 9. Testing

- **Unit:** win detection, including the blocked-ends edge cases; move validation; settle logic (turn timeout, disconnect timeout, bot due); bracket building (sizes 2–32, bot placement so no round-1 bot-vs-bot); progression including the 3rd-place match; bot always wins or blocks in one; initData verification.
- **Integration** (against a test Mongo database or `mongodb-memory-server`): full tournament with 3 humans and 1 bot to a champion; reload mid-match returns identical state; concurrent moves with only one accepted; TTL fields set.
- **Manual:** dev-mode multi-tab tournament; a real Telegram run once the bot token is set.

## 10. Left to the builder

Component structure, styling approach (Tailwind is already set up), the exact polling cadence and backoff, the bot search details within the time box, the room/match code alphabet, and the Mongo driver choice (native `mongodb` driver preferred over an ODM).
