import { after } from 'next/server'
import { publishChanged, publishMove, realtimeEnabled } from './realtime'
import type { MoveSignal } from '@/src/realtime/channels'
import { RoomService } from './room-service'
import { getDb } from './db'
import { createGauntletLearning } from './gauntlet-learning'
import { MongoGauntletBookStore } from './gauntlet-book-store'
import { MongoPresenceStore, MongoRoomStore } from './stores'
import { SudokuService } from './sudoku-service'
import { MongoSudokuStore } from './sudoku-store'
import { isDifficulty, type Difficulty } from '@/src/sudoku/types'
import { isBotLevel, isMatchFormat, RoomError, type BotLevel, type MatchFormat } from '@/src/tournament/types'

/** `https://t.me/<bot>/<app>?startapp=<code>`, or '' when the bot username or app short name is not configured. */
export function buildInviteUrl(code: string, env: Partial<Record<string, string>> = process.env): string {
  const bot = env.TELEGRAM_BOT_USERNAME
  const app = env.TELEGRAM_MINIAPP_SHORTNAME
  if (!bot || !app) return ''
  return `https://t.me/${bot}/${app}?startapp=${code}`
}

/** Publish after the response is sent, so a move's reply never waits on Ably. */
function notify(channels: string[], version: number): void {
  if (!realtimeEnabled()) return
  after(() => publishChanged(channels, version))
}

/** Starts publishing a move right now (before the write); `after` only keeps the function alive until it lands. */
function notifyMove(channel: string, signal: MoveSignal): void {
  if (!realtimeEnabled()) return
  const sent = publishMove(channel, signal)
  after(() => sent)
}

interface Services {
  caro: RoomService
  sudoku: SudokuService
}
let servicesPromise: Promise<Services> | null = null

/** Lazy singleton: never touches Mongo until the first request. Each game checks the other for an active room. */
function getServices(): Promise<Services> {
  servicesPromise ??= getDb()
    .then((db) => {
      const out = {} as Services
      const learning = createGauntletLearning(new MongoGauntletBookStore(db))
      out.caro = new RoomService({
        rooms: new MongoRoomStore(db),
        presence: new MongoPresenceStore(db),
        now: Date.now,
        rng: Math.random,
        inviteUrl: (code) => buildInviteUrl(code),
        activeElsewhere: (userId) => out.sudoku.activeCode(userId),
        notify,
        notifyMove,
        learning,
        afterWrite: (beforeRoom, afterRoom, now) =>
          after(() => learning.learnFromWrite(beforeRoom, afterRoom, now)),
      })
      out.sudoku = new SudokuService({
        rooms: new MongoSudokuStore(db),
        now: Date.now,
        rng: Math.random,
        inviteUrl: (code) => buildInviteUrl(code),
        activeElsewhere: (userId) => out.caro.activeCode(userId),
        notify,
      })
      return out
    })
    .catch((e) => {
      servicesPromise = null
      throw e
    })
  return servicesPromise
}

export const getService = async (): Promise<RoomService> => (await getServices()).caro
export const getSudokuService = async (): Promise<SudokuService> => (await getServices()).sudoku

const STATUS: Record<string, number> = {
  not_found: 404,
  not_host: 403,
  not_participant: 403,
  conflict: 409,
  already_active: 409,
  not_lobby: 409,
  full: 409,
  too_many_players: 409,
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

export function parseFormatBody(json: unknown): MatchFormat {
  if (!isObject(json) || !isMatchFormat(json.format)) throw badRequest()
  return json.format
}

export function parseBotLevelBody(json: unknown): BotLevel {
  if (!isObject(json) || !isBotLevel(json.level)) throw badRequest()
  return json.level
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

export function parseSudokuCreateBody(json: unknown): { name?: string; difficulty?: Difficulty } {
  const name = parseCreateBody(json)
  if (!isObject(json) || json.difficulty === undefined) return { name }
  if (!isDifficulty(json.difficulty)) throw badRequest()
  return { name, difficulty: json.difficulty }
}

export function parseDifficultyBody(json: unknown): Difficulty {
  if (!isObject(json) || !isDifficulty(json.difficulty)) throw badRequest()
  return json.difficulty
}

export function parseEntryBody(json: unknown): { cell: number; digit: number; seq: number } {
  if (!isObject(json)) throw badRequest()
  const { cell, digit, seq } = json
  if (!Number.isInteger(cell) || !Number.isInteger(digit) || !Number.isInteger(seq)) throw badRequest()
  const [c, d, n] = [cell as number, digit as number, seq as number]
  if (c < 0 || c > 80 || d < 1 || d > 9 || n < 1) throw badRequest()
  return { cell: c, digit: d, seq: n }
}

export const codeOf = (c: string) => c.toUpperCase()
