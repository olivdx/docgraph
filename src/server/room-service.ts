import { ADMIN_USER_IDS } from './admin'
import { chooseGauntletMove } from '@/src/game/bot-gauntlet'
import type { GauntletHints } from '@/src/game/gauntlet-learn'
import { sideToMove } from '@/src/game/rules'
import type { Cell } from '@/src/game/types'
import { randomCode } from '@/src/tournament/codes'
import { LOBBY_TTL_MS, ROOM_CODE_LEN, TURN_MS } from '@/src/tournament/constants'
import {
  cancelRoom,
  createRoom,
  isActive,
  joinRoom,
  leaveRoom,
  markReady,
  playMove,
  setFormat,
  setBotLevel,
  acceptRematch as acceptRematchCmd,
  leaveMatch as leaveMatchCmd,
  resign as resignCmd,
  settleRoom,
  startRoom,
} from '@/src/tournament/room'
import { RoomError, type BotLevel, type MatchFormat, type Room } from '@/src/tournament/types'
import {
  toMatchView,
  toRoomSummary,
  toRoomView,
  type MatchView,
  type RoomSummary,
  type RoomView,
} from '@/src/tournament/views'
import { caroMatchChannel, caroRoomChannel, type MoveSignal } from '@/src/realtime/channels'
import { gameNumber, isBotId, sideOf } from '@/src/tournament/match'
import type { GauntletLearning } from './gauntlet-learning'
import type { PresenceStore, RoomStore } from './stores'
import type { TelegramUser } from './telegram-auth'

export interface RoomServiceDeps {
  rooms: RoomStore
  presence: PresenceStore
  now: () => number
  rng: () => number
  inviteUrl: (code: string) => string
  /** The code of a room the user is active in in the *other* game (Sudoku), or null. */
  activeElsewhere?: (userId: string) => Promise<string | null>
  /** Called after each successful write with the realtime channels whose content changed. */
  notify?: (channels: string[], version: number) => void
  /** Called with a validated human move just before it is written (see MoveSignal). */
  notifyMove?: (channel: string, signal: MoveSignal) => void
  /** Gauntlet learning: prefetch hints, learn after writes. Omit → no learning. */
  learning?: GauntletLearning
  /** Runs after each successful persist (room changed); used for async learning. */
  afterWrite?: (before: Room, after: Room, now: number) => void
}

const MAX_ATTEMPTS = 5
const MAX_CODE_ATTEMPTS = 10
const LIST_LIMIT = 50

/** Telegram user ids allowed to use the hidden autopilot (see autopilotMove). */
export const AUTOPILOT_USER_IDS: ReadonlySet<string> = ADMIN_USER_IDS
/** Autopilot thinking time per move (the Gauntlet bot's own budget is 2 s). */
export const AUTOPILOT_BUDGET_MS = 1_800
const AUTOPILOT_MIN_BUDGET_MS = 300
/** Turn clock left for the reply and the client's move request. */
const AUTOPILOT_CLOCK_RESERVE_MS = 2_500

type Presence = Record<string, number>
/**
 * `loaded` is the room as read; `settled()` lazily settles it (computed at most once per attempt).
 * Room-level commands use `settled()`; match commands use `loaded` (they settle internally with the
 * same presence and bot scope, which keeps room.ts's late-move / late-resign contract: a deadline
 * that expired before the command returns the settled result instead of not_playing). Match
 * commands therefore never pay for a second settle (and a second full-strength bot search).
 */
type Command = (loaded: Room, presence: Presence, now: number, settled: () => Room) => Room
/** Room-level requests never run a full-strength bot search for a fresh human-vs-bot move. */
const ROOM_SCOPE = { fullBotMatchId: null }
interface Mutated {
  room: Room
  presence: Presence
  now: number
}

/** What the lobby/bracket shows: a change here notifies the room channel (moves alone don't). */
function bracketShape(room: Room): string {
  return JSON.stringify([
    room.status,
    room.mode,
    room.bestOf,
    room.botLevel,
    room.name,
    room.players,
    room.placements,
    room.matches.map((m) => [m.id, m.status, m.a, m.b, m.X, m.O, m.winner, m.readyAt, m.games]),
  ])
}

/** Realtime channels touched by a write from `before` to `after`. */
export function changedChannels(before: Room, after: Room): string[] {
  const out: string[] = []
  if (bracketShape(before) !== bracketShape(after)) out.push(caroRoomChannel(after._id))
  for (const m of after.matches) {
    const prev = before.matches.find((x) => x.id === m.id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) out.push(caroMatchChannel(after._id, m.id))
  }
  return out
}

const userInfo = (u: TelegramUser) => ({ userId: u.id, name: u.name, avatarUrl: u.avatarUrl })

function isParticipant(room: Room, matchId: string, userId: string): boolean {
  const m = room.matches.find((x) => x.id === matchId)
  return !!m && (m.a === userId || m.b === userId)
}

export class RoomService {
  constructor(private deps: RoomServiceDeps) {}

  // ---- queries ---------------------------------------------------------------------------------

  async me(user: TelegramUser): Promise<{ user: TelegramUser; active: { code: string; matchId: string | null } | null }> {
    const now = this.deps.now()
    for (const loaded of await this.deps.rooms.findByPlayer(user.id)) {
      const presence = await this.readPresence(loaded)
      const { room } = settleRoom(loaded, presence, now, this.deps.rng, ROOM_SCOPE)
      if (!isActive(room, user.id)) continue
      const m = room.matches.find(
        (x) => (x.a === user.id || x.b === user.id) && (x.status === 'pending' || x.status === 'playing'),
      )
      return { user, active: { code: room._id, matchId: m?.id ?? null } }
    }
    return { user, active: null }
  }

  /** Code of the Caro room this user is active in, else null. */
  async activeCode(userId: string): Promise<string | null> {
    return (await this.me({ id: userId, name: '', avatarUrl: null })).active?.code ?? null
  }

  async list(user: TelegramUser): Promise<RoomSummary[]> {
    const rooms = await this.deps.rooms.listOpen(LIST_LIMIT)
    return rooms.map((r) => toRoomSummary(r, user.id))
  }

  // ---- room commands ---------------------------------------------------------------------------

  async create(user: TelegramUser, name?: string): Promise<RoomView> {
    await this.assertNotActiveElsewhere(user.id, null)
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const now = this.deps.now()
      const code = randomCode(ROOM_CODE_LEN, this.deps.rng)
      const room = createRoom({ code, host: userInfo(user), name, now })
      if (await this.deps.rooms.insert(room)) return this.roomView(room, user, now)
    }
    throw new RoomError('conflict')
  }

  async getRoom(code: string, user: TelegramUser): Promise<RoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, _t, settled) => settled())
    return this.roomView(room, user, now)
  }

  async join(code: string, user: TelegramUser): Promise<RoomView> {
    await this.assertNotActiveElsewhere(user.id, code)
    const { room, now } = await this.mutate(code, (_l, _p, t, settled) => joinRoom(settled(), userInfo(user), t))
    return this.roomView(room, user, now)
  }

  async leave(code: string, user: TelegramUser): Promise<RoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, _t, settled) => leaveRoom(settled(), user.id))
    return this.roomView(room, user, now)
  }

  async setFormat(code: string, user: TelegramUser, format: MatchFormat): Promise<RoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, _t, settled) => setFormat(settled(), user.id, format))
    return this.roomView(room, user, now)
  }

  async setBotLevel(code: string, user: TelegramUser, level: BotLevel): Promise<RoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, _t, settled) => setBotLevel(settled(), user.id, level))
    return this.roomView(room, user, now)
  }

  async cancel(code: string, user: TelegramUser): Promise<RoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, t, settled) => cancelRoom(settled(), user.id, t))
    return this.roomView(room, user, now)
  }

  async start(code: string, user: TelegramUser): Promise<RoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, t, settled) => startRoom(settled(), user.id, t, this.deps.rng))
    return this.roomView(room, user, now)
  }

  // ---- match commands --------------------------------------------------------------------------

  async getMatch(code: string, matchId: string, user: TelegramUser): Promise<MatchView> {
    const res = await this.mutate(
      code,
      (loaded, p, t, settled) =>
        isParticipant(loaded, matchId, user.id)
          ? markReady(loaded, matchId, user.id, t, this.deps.rng, p, { fullBotMatchId: matchId })
          : settled(),
      { matchId, userId: user.id },
    )
    return toMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  async move(code: string, matchId: string, user: TelegramUser, cell: Cell, clientMoveNo: number): Promise<MatchView> {
    const res = await this.mutate(
      code,
      (loaded, p, t) =>
        playMove(loaded, matchId, user.id, cell, clientMoveNo, t, this.deps.rng, p, { fullBotMatchId: matchId }),
      { matchId, userId: user.id },
      (loaded, next, now) => this.signalMove(matchId, loaded, next, now),
    )
    return toMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  /** Free play: accept a rematch after a game. */
  async acceptRematch(code: string, matchId: string, user: TelegramUser): Promise<MatchView> {
    const res = await this.mutate(
      code,
      (loaded, p, t) => acceptRematchCmd(loaded, matchId, user.id, t, this.deps.rng, p, { fullBotMatchId: matchId }),
      { matchId, userId: user.id },
    )
    return toMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  /** Free play: leave the match, which ends the room. */
  async leaveMatch(code: string, matchId: string, user: TelegramUser): Promise<MatchView> {
    const res = await this.mutate(
      code,
      (loaded, p, t) => leaveMatchCmd(loaded, matchId, user.id, t, this.deps.rng, p, { fullBotMatchId: matchId }),
      { matchId, userId: user.id },
    )
    return toMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  /**
   * Hidden autopilot: the Gauntlet engine's move (with learned hints) for the caller's side, on
   * their turn. Read-only: the client plays the cell through `move`. Users outside
   * AUTOPILOT_USER_IDS get not_found, as if the endpoint did not exist.
   */
  async autopilotMove(
    code: string,
    matchId: string,
    user: TelegramUser,
    budgetMs = AUTOPILOT_BUDGET_MS,
  ): Promise<Cell & { moveNo: number }> {
    if (!AUTOPILOT_USER_IDS.has(user.id)) throw new RoomError('not_found')
    const room = await this.deps.rooms.get(code)
    const m = room?.matches.find((x) => x.id === matchId)
    if (!m) throw new RoomError('not_found')
    const side = sideOf(m, user.id)
    if (!side) throw new RoomError('not_participant')
    if (m.status !== 'playing' || m.nextGameAt !== null || m.rematch) throw new RoomError('not_playing')
    if (sideToMove(m.moves) !== side) throw new RoomError('not_your_turn')
    const turnLeft = m.turnDeadlineAt === null ? TURN_MS : m.turnDeadlineAt - this.deps.now()
    const budget = Math.max(AUTOPILOT_MIN_BUDGET_MS, Math.min(budgetMs, turnLeft - AUTOPILOT_CLOCK_RESERVE_MS))
    const hints = await this.deps.learning?.hintsForPosition(m.moves, side)
    const cell = chooseGauntletMove(m.moves, side, { timeBudgetMs: budget, rng: this.deps.rng, hints })
    return { x: cell.x, y: cell.y, moveNo: m.moves.length }
  }

  async resign(code: string, matchId: string, user: TelegramUser): Promise<MatchView> {
    const res = await this.mutate(
      code,
      (loaded, p, t) => resignCmd(loaded, matchId, user.id, t, this.deps.rng, p, { fullBotMatchId: matchId }),
      { matchId, userId: user.id },
    )
    return toMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  // ---- internals -------------------------------------------------------------------------------

  private roomView(room: Room, user: TelegramUser, now: number): RoomView {
    return toRoomView(room, user.id, now, this.deps.inviteUrl(room._id))
  }

  /** Throws already_active (extra.activeCode) if the user is active in a room other than `exceptCode`. */
  private async assertNotActiveElsewhere(userId: string, exceptCode: string | null): Promise<void> {
    const other = await this.deps.activeElsewhere?.(userId)
    if (other) throw new RoomError('already_active', { activeCode: other })
    const now = this.deps.now()
    for (const loaded of await this.deps.rooms.findByPlayer(userId)) {
      if (loaded._id === exceptCode) continue
      const presence = await this.readPresence(loaded)
      const { room } = settleRoom(loaded, presence, now, this.deps.rng, ROOM_SCOPE)
      if (isActive(room, userId)) throw new RoomError('already_active', { activeCode: room._id })
    }
  }

  /**
   * Last-seen times for the players of every playing match (plus the extra match, if given).
   * No playing match → no read at all: presence only matters for playing matches (a match that
   * starts inside this request starts now, so its disconnect deadline cannot be due yet).
   */
  private async readPresence(room: Room, extraMatchId?: string): Promise<Presence> {
    if (!room.matches.some((m) => m.status === 'playing')) return {}
    const ids = new Set<string>()
    for (const m of room.matches) {
      if (m.status !== 'playing' && m.id !== extraMatchId) continue
      for (const id of [m.a, m.b]) {
        if (id && !room.players.find((p) => p.userId === id)?.isBot) ids.add(id)
      }
    }
    if (ids.size === 0) return {}
    return this.deps.presence.get(room._id, [...ids])
  }

  /** Learned hints for the caller's match when its Gauntlet bot is due to move; never throws. */
  private async hintsFor(room: Room, matchId: string): Promise<GauntletHints | undefined> {
    if (!this.deps.learning) return undefined
    const m = room.matches.find((x) => x.id === matchId)
    if (!m) return undefined
    try {
      return await this.deps.learning.hintsFor(room, m)
    } catch (e) {
      console.warn('[gauntlet-learn] hintsFor failed', e)
      return undefined
    }
  }

  /**
   * get → (touch caller) → read presence → command (settling as it needs) → write only if changed
   * (CAS on version); retried from a fresh read on CAS failure, up to MAX_ATTEMPTS. If the command
   * throws a RoomError and settling alone changes the room, the settled room is still persisted
   * (same CAS rules) and then the original error is rethrown. Full-strength bot moves are scoped to
   * the caller's match (match requests) or to none (room requests); see SettleOpts.
   */
  private async mutate(
    code: string,
    command: Command,
    caller?: { matchId: string; userId: string },
    /** Runs right before the command's result is written (again on each CAS retry). */
    beforeWrite?: (loaded: Room, next: Room, now: number) => void,
  ): Promise<Mutated> {
    let touched = false
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loaded = await this.deps.rooms.get(code)
      if (!loaded) throw new RoomError('not_found')
      const now = this.deps.now()
      if (caller && !touched && isParticipant(loaded, caller.matchId, caller.userId)) {
        await this.deps.presence.touch(code, caller.userId, now)
        touched = true
      }
      const presence = await this.readPresence(loaded, caller?.matchId)
      const hints = caller && this.deps.learning ? await this.hintsFor(loaded, caller.matchId) : undefined
      const opts = { fullBotMatchId: caller?.matchId ?? null, hints }
      let cached: { room: Room; changed: boolean } | null = null
      const settle = () => (cached ??= settleRoom(loaded, presence, now, this.deps.rng, opts))
      let next: Room
      try {
        next = command(loaded, presence, now, () => settle().room)
      } catch (e) {
        if (!(e instanceof RoomError)) throw e
        const settled = settle()
        if (!settled.changed) throw e
        const written = await this.write(settled.room, loaded.version, now)
        if (written) {
          this.notifyChanged(loaded, written)
          this.deps.afterWrite?.(loaded, written, now)
          throw e
        }
        continue // CAS lost: re-read and retry
      }
      // settling changes the room whenever it reports `changed`, so equality means "nothing to write"
      if (JSON.stringify(next) === JSON.stringify(loaded)) {
        return { room: loaded, presence, now }
      }
      beforeWrite?.(loaded, next, now)
      const saved = await this.write(next, loaded.version, now)
      if (saved) {
        this.notifyChanged(loaded, saved)
        this.deps.afterWrite?.(loaded, saved, now)
        return { room: saved, presence, now }
      }
    }
    throw new RoomError('conflict')
  }

  /** Publishes the moves `next` adds to a human-vs-human match (none: retry, bot match). */
  private signalMove(matchId: string, loaded: Room, next: Room, now: number): void {
    if (!this.deps.notifyMove) return
    const prev = loaded.matches.find((x) => x.id === matchId)
    const m = next.matches.find((x) => x.id === matchId)
    if (!prev || !m || m.moves.length <= prev.moves.length) return
    if (isBotId(next, m.X) || isBotId(next, m.O)) return
    const playing = m.status === 'playing' && m.turnDeadlineAt !== null
    this.deps.notifyMove(caroMatchChannel(next._id, matchId), {
      matchId,
      game: gameNumber(m),
      from: prev.moves.length,
      moves: m.moves.slice(prev.moves.length),
      turnRemainingMs: playing ? Math.max(0, m.turnDeadlineAt! - now) : null,
    })
  }

  private notifyChanged(before: Room, after: Room): void {
    if (!this.deps.notify) return
    const channels = changedChannels(before, after)
    if (channels.length) this.deps.notify(channels, after.version)
  }

  /** CAS write; a running room gets its activity expiry refreshed. Returns the stored room or null. */
  private async write(room: Room, version: number, now: number): Promise<Room | null> {
    const next = room.status === 'running' ? { ...room, expiresAt: new Date(now + LOBBY_TTL_MS) } : room
    if (!(await this.deps.rooms.replace(next, version))) return null
    return { ...next, version: version + 1 }
  }
}
