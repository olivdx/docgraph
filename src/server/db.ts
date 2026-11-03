import { MongoClient, type Db } from 'mongodb'

const DB_NAME = 'caro'
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
  await Promise.all([
    rooms.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    rooms.createIndex({ status: 1, createdAt: -1 }),
    rooms.createIndex({ 'players.userId': 1 }),
    // presence _id is `${code}:${userId}` (the default _id index)
    presence.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
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
        const db = client.db(DB_NAME)
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
