/**
 * Offline bootstrap: simulate games where Gauntlet plays `full` against a weaker bot (`prelude` or
 * `duel`), then upserts weights into MongoDB `gauntlet_book` / `gauntlet_games` (same shape as
 * GauntletLearning). Requires the same env as the app (`MONGODB_URI` or `User` + `pass` + host from db.ts).
 *
 * Usage (from repo root):
 *   npm run seed:gauntlet-book -- --games 200 --weak duel --gauntlet O
 *   npm run seed:gauntlet-book -- --games 50 --weak prelude --dry-run
 */

import { MongoClient } from 'mongodb'
import { bookMove, isForcedPosition } from '@/src/game/bot-gauntlet'
import { chooseBotMove, strengthForLevel } from '@/src/game/bot'
import { deltasFromGame, gameId, type BookDelta, type GameRecord } from '@/src/game/gauntlet-learn'
import { buildBoard, findWin, sideToMove } from '@/src/game/rules'
import type { BotLevel } from '@/src/tournament/types'
import type { Cell, Move, Side } from '@/src/game/types'
import { MAX_BOT_GAME_MOVES } from '@/src/tournament/constants'
import { mongoUri } from '@/src/server/db'
import { MongoGauntletBookStore, GAMES_TTL_MS } from '@/src/server/gauntlet-book-store'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function parseArgs(argv: string[]): {
  games: number
  weak: BotLevel
  gauntlet: Side
  seed: number
  dryRun: boolean
} {
  let games = 100
  let weak: BotLevel = 'duel'
  let gauntlet: Side = 'O'
  /** Unsigned 32-bit RNG seed for stable reproduction in logs. */
  let seed = Date.now() >>> 0
  let dryRun = false
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--games' && next) {
      games = Math.max(1, parseInt(next, 10) || games)
      i++
    } else if (a === '--weak' && next) {
      if (next === 'prelude' || next === 'duel') weak = next
      else throw new Error('--weak must be prelude or duel')
      i++
    } else if (a === '--gauntlet' && next) {
      if (next === 'X' || next === 'O') gauntlet = next
      else throw new Error('--gauntlet must be X or O')
      i++
    } else if (a === '--seed' && next) {
      seed = parseInt(next, 10) >>> 0
      i++
    } else if (a === '--dry-run') {
      dryRun = true
    }
  }
  return { games, weak, gauntlet, seed, dryRun }
}

function playGame(
  rng: () => number,
  weak: BotLevel,
  gauntletSide: Side,
): { moves: Move[]; winner: Side } | null {
  const moves: Move[] = []
  let at = 0
  const weakBudget = strengthForLevel(weak).timeBudgetMs
  const gauntletBudget = strengthForLevel('gauntlet').timeBudgetMs

  for (let ply = 0; ply < MAX_BOT_GAME_MOVES; ply++) {
    const side = sideToMove(moves)
    const level: BotLevel = side === gauntletSide ? 'gauntlet' : weak
    const timeBudgetMs = side === gauntletSide ? gauntletBudget : weakBudget
    const cell: Cell =
      level === 'gauntlet'
        ? chooseBotMove(moves, side, { mode: 'full', level: 'gauntlet', rng, timeBudgetMs })
        : chooseBotMove(moves, side, { mode: 'full', level: weak, rng, timeBudgetMs })

    const move: Move = { ...cell, side, at: at++ }
    const board = buildBoard([...moves, move])
    const line = findWin(board, move)
    moves.push(move)
    if (line) return { moves, winner: side }
  }
  return null
}

async function main(): Promise<void> {
  const { games, weak, gauntlet: gauntletSide, seed, dryRun } = parseArgs(process.argv)
  const rng = mulberry32(seed)
  const runId = `${Date.now().toString(36)}-${process.pid}`

  let played = 0
  let skippedNoResult = 0
  let skippedInsert = 0
  const deltasBatched: BookDelta[] = []

  const memoryRows: GameRecord[] = []

  for (let i = 0; i < games; i++) {
    const g = playGame(rng, weak, gauntletSide)
    if (!g) {
      skippedNoResult++
      continue
    }
    played++
    const now = Date.now()
    const rec: GameRecord = {
      _id: gameId(`seed-${runId}`, 'bootstrap', i + 1),
      roomCode: `seed-${runId}`,
      matchId: 'bootstrap',
      gameIndex: i + 1,
      moves: g.moves,
      botSide: gauntletSide,
      winnerSide: g.winner,
      endReason: 'five_in_row',
      createdAt: now,
    }
    const deltas = deltasFromGame(rec, isForcedPosition, (ms, s) => bookMove(ms, s) !== null)
    memoryRows.push(rec)
    deltasBatched.push(...deltas)
  }

  console.log(
    JSON.stringify(
      {
        gamesRequested: games,
        gamesFinished: played,
        skippedNoResult,
        weak,
        gauntletSide,
        seed,
        dryRun,
        totalDeltas: deltasBatched.length,
      },
      null,
      2,
    ),
  )

  if (dryRun) {
    console.log('[seed-gauntlet-book] dry-run: no Mongo write')
    return
  }

  const uri = mongoUri()
  const client = new MongoClient(uri, { maxPoolSize: 2 })
  await client.connect()
  try {
    const db = client.db('caro')
    const store = new MongoGauntletBookStore(db)
    for (const rec of memoryRows) {
      const ok = await store.insertGame(rec)
      if (!ok) skippedInsert++
    }
    await store.applyDeltas(deltasBatched, Date.now())
    // Ensure TTL index exists (same as ensureIndexes)
    await db.collection('gauntlet_games').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    console.log('[seed-gauntlet-book] wrote to Mongo; skippedInsert (duplicate _id):', skippedInsert)
  } finally {
    await client.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
