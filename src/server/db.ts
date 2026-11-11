import { MongoClient, type Db } from 'mongodb'

const DEFAULT_DB_NAME = 'caro'
/** `MONGODB_DB` overrides the database name, e.g. `caro_dev` for local testing. */
export const dbName = (env: NodeJS.ProcessEnv = process.env) => env.MONGODB_DB || DEFAULT_DB_NAME
const HOST = 'labs.wnk6exl.mongodb.net'

/** Builds the connection URI. `MONGODB_URI` wins; otherwise `.env` User/pass (MONGO_USER/MONGO_PASS also accepted). */
export function mongoUri(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MONGODB_URI) return env.MONGODB_URI
  const user = env.MONGO_USER ?? env.User
  const pass = env.MONGO_PASS ?? env.pass
  if (!user || !pass) {
    throw new Error('MongoDB is not configured: set MONGODB_URI, or User and pass (MONGO_USER/MONGO_PASS) in the environment')
  }
  return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${HOST}/?retryWrites=true&w=majority`
}

export async function ensureIndexes(db: Db): Promise<void> {
  const rooms = db.collection('rooms')
  const presence = db.collection('presence')
  const sudoku = db.collection('sudoku_rooms')
  const battleship = db.collection('battleship_rooms')
  const gauntletGames = db.collection('gauntlet_games')
  const battleRatings = db.collection('battleship_ratings')
  const battleRatingEvents = db.collection('battleship_rating_events')
  await Promise.all([
    rooms.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    rooms.createIndex({ status: 1, createdAt: -1 }),
    rooms.createIndex({ 'players.userId': 1 }),
    // presence _id is `${code}:${userId}` (the default _id index)
    presence.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sudoku.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sudoku.createIndex({ status: 1, createdAt: -1 }),
    sudoku.createIndex({ 'players.userId': 1 }),
    battleship.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    battleship.createIndex({ status: 1, createdAt: -1 }),
    battleship.createIndex({ 'players.userId': 1 }),
    gauntletGames.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    battleRatings.createIndex({ rating: -1, updatedAt: 1 }),
    battleRatingEvents.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    battleRatingEvents.createIndex({ kind: 1, key: 1, at: 1 }),
  ])
}

type DbCache = { promise: Promise<Db> | null }
const g = globalThis as typeof globalThis & { __caroDb?: DbCache }

/** One MongoClient per warm serverless instance (cached on globalThis); indexes ensured once per cold start. */
export function getDb(): Promise<Db> {
  const cache = (g.__caroDb ??= { promise: null })
  if (!cache.promise) {
    cache.promise = (async () => {
      const client = new MongoClient(mongoUri(), { maxPoolSize: 5 })
      await client.connect()
      try {
        const db = client.db(dbName())
        await ensureIndexes(db)
        return db
      } catch (e) {
        // don't leak the connected client: the next request builds a fresh one
        await client.close().catch(() => {})
        throw e
      }
    })().catch((e) => {
      cache.promise = null
      throw e
    })
  }
  return cache.promise
}
