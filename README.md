# Caro Cup

Caro Cup is a Telegram Mini App for running small knockout tournaments of Caro (gomoku with the blocked-ends rule) among friends. Anyone can create a tournament, share an invite link in a Telegram chat, let people sign up, and play through a single-elimination bracket (with a 3rd-place match) until there is a champion. When there are too few players the bracket is filled with bots, and the bots play genuinely hard.

It is for fun, not ranking: there is no ELO, and all tournament data is deleted automatically (finished or cancelled rooms 10 minutes after they end, lobbies that never start 2 hours after creation).

## How it works

- Next.js 16 (App Router) + TypeScript + Tailwind, MongoDB (native driver) as the single source of truth. Designed for Vercel: no long-lived processes, no WebSockets. Clients poll (about 1 s in a match, 3 s in lobby/bracket, 10 s on Home) and time-based rules (turn timeout, disconnect, bot moves) are settled lazily by whichever request touches the match.
- Rules: 5 or more in a row wins unless both ends are blocked (the board edge counts as blocking). 100×100 board (−50..49), drag to pan (no zoom), 25 s per turn, 30 s reconnect grace after a 5 s detection window, one game per match.
- 2 to 32 players. The bracket is rounded up to the next power of 2 and empty slots become bots (never bot-vs-bot in round 1). A human facing a bot plays X and moves first.
- Identity is the Telegram `initData`, verified server-side with the bot token. No cookies or sessions.
- Design spec: `docs/superpowers/specs/2026-11-02-caro-tournament-design.md`.

## Limits

Caro Cup is designed for small friend groups. Every open client polls the server (about once a second during a match), and each poll reads, and sometimes writes, the room document. A handful of concurrent tournaments is fine on free tiers, but near the 32-player bound on MongoDB Atlas M0 and Vercel Hobby expect throttling (slower responses, occasional retries) from the free-tier operation and connection limits.

## Environment variables

Copy `.env.example` to `.env.local` and fill it in. Never commit real credentials.

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | one of the two Mongo options | Full MongoDB connection string. Overrides everything below. Use it for tests/CI or any non-default cluster. |
| `MONGO_USER` / `MONGO_PASS` | one of the two Mongo options | Atlas username and password. The URI is built as `mongodb+srv://<user>:<pass>@labs.wnk6exl.mongodb.net/` and the database name is `caro`. The legacy names `User` / `pass` are also accepted. |
| `TELEGRAM_BOT_TOKEN` | production | Bot token from BotFather. Used to verify the signature of `initData`. |
| `TELEGRAM_BOT_USERNAME` | yes | Bot username without the `@`, used to build invite links. |
| `TELEGRAM_MINIAPP_SHORTNAME` | yes | Short name of the Mini App registered with BotFather (see below). |

The invite link has the form `https://t.me/<TELEGRAM_BOT_USERNAME>/<TELEGRAM_MINIAPP_SHORTNAME>?startapp=<ROOM_CODE>`.

## Local development

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # unit + integration tests (mongodb-memory-server, no real DB needed)
pnpm lint
pnpm build
```

Outside Telegram there is no `initData`, so in development (`NODE_ENV=development`, i.e. `pnpm dev`) a fake user can be chosen with the `dev` query parameter, in the form `?dev=<id>:<name>`. Open several tabs, each as a different player:

- Tab 1: `http://localhost:3000/?dev=1:Ann` (create a tournament)
- Tab 2: `http://localhost:3000/?dev=2:Ben`
- Tab 3: `http://localhost:3000/?dev=3:Cat`

To follow an invite link, add the room code as `startapp`, which is what Telegram does with the `startapp` parameter: `http://localhost:3000/?dev=2:Ben&startapp=ABC123`.

The dev bypass works through the `x-dev-user` header (`1:Ann`) and is disabled in production builds, where a valid Telegram `initData` is always required.

## Register the Mini App with BotFather

1. In Telegram, talk to [@BotFather](https://t.me/BotFather). If you do not have a bot yet, run `/newbot` and note the token (`TELEGRAM_BOT_TOKEN`) and the username (`TELEGRAM_BOT_USERNAME`).
2. Run `/newapp` and choose your bot.
3. Give the app a title, a description and a 640x360 photo (a GIF is optional).
4. When asked for the Web App URL, enter your deployed HTTPS URL (for example `https://your-project.vercel.app`).
5. When asked for the short name, enter something like `cup`. This is the `<shortname>` in `https://t.me/<bot>/<shortname>`; set it as `TELEGRAM_MINIAPP_SHORTNAME`. You can see it again later with `/myapps`.

Opening `https://t.me/<bot>/<shortname>?startapp=<ROOM_CODE>` then launches the Mini App straight into that room's lobby.

## Deploy to Vercel

1. Push the repository to GitHub/GitLab/Bitbucket and import it in Vercel (framework preset: Next.js; the default build command and pnpm install work as is).
2. In Project Settings, Environment Variables, add `MONGO_USER` and `MONGO_PASS` (or a single `MONGODB_URI`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `TELEGRAM_MINIAPP_SHORTNAME` for the Production (and Preview if you use it) environment, then redeploy.
3. MongoDB Atlas, Network Access: Vercel functions use dynamic IP addresses, so add `0.0.0.0/0` (allow access from anywhere) to the IP access list, or use Vercel's Atlas integration / static outbound IPs if you need something tighter. Keep strong database credentials since the allow-list is open.
4. Put the production URL into BotFather (`/newapp` or `/editapp`) as the Web App URL.
5. Open `https://t.me/<bot>/<shortname>` in Telegram to check it loads.

TTL indexes (`expiresAt`, `expireAfterSeconds: 0`) are created automatically on the first request after a cold start. Note that MongoDB's TTL monitor runs roughly once a minute, so expired rooms disappear shortly after their `expiresAt`.
