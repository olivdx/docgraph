import { RoomService } from './room-service'
import { getDb } from './db'
import { MongoPresenceStore, MongoRoomStore } from './stores'
import { RoomError } from '@/src/tournament/types'

let servicePromise: Promise<RoomService> | null = null

/** `https://t.me/<bot>/<app>?startapp=<code>`, or '' when the bot username or app short name is not configured. */
export function buildInviteUrl(code: string, env: Partial<Record<string, string>> = process.env): string {
  const bot = env.TELEGRAM_BOT_USERNAME
  const app = env.TELEGRAM_MINIAPP_SHORTNAME
  if (!bot || !app) return ''
  return `https://t.me/${bot}/${app}?startapp=${code}`
}

/** Lazy singleton: never touches Mongo until the first request. */
export function getService(): Promise<RoomService> {
  servicePromise ??= getDb()
    .then(
      (db) =>
        new RoomService({
          rooms: new MongoRoomStore(db),
          presence: new MongoPresenceStore(db),
          now: Date.now,
          rng: Math.random,
          inviteUrl: (code) => buildInviteUrl(code),
        }),
    )
    .catch((e) => {
      servicePromise = null
      throw e
    })
  return servicePromise
}

const STATUS: Record<string, number> = {
  not_found: 404,
  not_host: 403,
  not_participant: 403,
  conflict: 409,
  already_active: 409,
  not_lobby: 409,
  full: 409,
}

export function errorResponse(e: unknown): Response {
  if (e instanceof Response) return e
  if (e instanceof RoomError) {
    return Response.json({ error: e.code, ...e.extra }, { status: STATUS[e.code] ?? 400 })
  }
  console.error(e)
  return Response.json({ error: 'internal' }, { status: 500 })
}

function badRequest(): Response {
  return Response.json({ error: 'bad_request' }, { status: 400 })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseMoveBody(json: unknown): { x: number; y: number; clientMoveNo: number } {
  if (!isObject(json)) throw badRequest()
  const { x, y, clientMoveNo } = json
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(clientMoveNo)) throw badRequest()
  return { x: x as number, y: y as number, clientMoveNo: clientMoveNo as number }
}

export function parseCreateBody(json: unknown): string | undefined {
  if (json === undefined || json === null) return undefined
  if (!isObject(json)) throw badRequest()
  if (json.name === undefined) return undefined
  if (typeof json.name !== 'string') throw badRequest()
  return json.name.trim().slice(0, 40).trim() || undefined
}

/** Reads a JSON body; an empty or invalid body yields undefined. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

export const codeOf = (c: string) => c.toUpperCase()
