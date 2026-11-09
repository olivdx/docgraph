import { after } from 'next/server'
import { publishChanged, publishMove, realtimeEnabled } from './realtime'
import type { MoveSignal } from '@/src/realtime/channels'
import { RoomService } from './room-service'
import { getDb } from './db'
import { createGauntletLearning } from './gauntlet-learning'
import { MongoGauntletBookStore } from './gauntlet-book-store'
import { MongoPresenceStore, MongoRoomStore } from './stores'
import { SudokuService } from './sudoku-service'
import { BattleshipService } from './battleship-service'
import { MongoBattleStore } from './battleship-store'
import type { Ship } from '@/src/battleship/types'
import { FLEET, MAX_SHIP_LEN } from '@/src/battleship/constants'
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
  battleship: BattleshipService
}
let servicesPromise: Promise<Services> | null = null

/** First active room code among the given games, checked in order. */
async function firstActive(userId: string, checks: ((id: string) => Promise<string | null>)[]): Promise<string | null> {
  for (const check of checks) {
    const code = await check(userId)
    if (code) return code
  }
  return null
}

/** Lazy singleton: never touches Mongo until the first request. Each game checks the others for an active room. */
function getServices(): Promise<Services> {
  servicesPromise ??= getDb()
    .then((db) => {
      const out = {} as Services
      const learning = createGauntletLearning(new MongoGauntletBookStore(db))
      const presence = new MongoPresenceStore(db)
      out.caro = new RoomService({
        rooms: new MongoRoomStore(db),
        presence,
        now: Date.now,
        rng: Math.random,
        inviteUrl: (code) => buildInviteUrl(code),
        activeElsewhere: (userId) =>
          firstActive(userId, [(u) => out.sudoku.activeCode(u), (u) => out.battleship.activeCode(u)]),
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
        activeElsewhere: (userId) =>
          firstActive(userId, [(u) => out.caro.activeCode(u), (u) => out.battleship.activeCode(u)]),
        notify,
      })
      out.battleship = new BattleshipService({
        rooms: new MongoBattleStore(db),
        presence, // Battleship codes are 4 chars, so presence keys never collide with Caro's
        now: Date.now,
        rng: Math.random,
        inviteUrl: (code) => buildInviteUrl(code),
        activeElsewhere: (userId) => firstActive(userId, [(u) => out.caro.activeCode(u), (u) => out.sudoku.activeCode(u)]),
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
export const getBattleshipService = async (): Promise<BattleshipService> => (await getServices()).battleship

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

/** Shape check only; validateFleet does the game rules. */
export function parseFleetBody(json: unknown): { ships: Ship[]; lock: boolean } {
  if (!isObject(json) || !Array.isArray(json.ships) || typeof json.lock !== 'boolean') throw badRequest()
  if (json.ships.length > FLEET.length) throw badRequest()
  const ships = json.ships.map((s: unknown) => {
    if (!isObject(s) || typeof s.key !== 'string' || !Array.isArray(s.cells)) throw badRequest()
    if (s.cells.length > MAX_SHIP_LEN || !s.cells.every((c: unknown) => Number.isInteger(c))) throw badRequest()
    return { key: s.key as Ship['key'], cells: s.cells as number[] }
  })
  return { ships, lock: json.lock }
}

export function parseFireBody(json: unknown): { cell: number; seq: number } {
  if (!isObject(json)) throw badRequest()
  const { cell, seq } = json
  if (!Number.isInteger(cell) || !Number.isInteger(seq) || (seq as number) < 1) throw badRequest()
  return { cell: cell as number, seq: seq as number }
}

export const codeOf = (c: string) => c.toUpperCase()
