import type { Cell } from '@/src/game/types'
import { randomCode } from '@/src/tournament/codes'
import { LOBBY_TTL_MS, ROOM_CODE_LEN } from '@/src/tournament/constants'
import {
  cancelRoom,
  createRoom,
  isActive,
  joinRoom,
  leaveRoom,
  markReady,
  playMove,
  resign as resignCmd,
  settleRoom,
  startRoom,
} from '@/src/tournament/room'
import { RoomError, type Room } from '@/src/tournament/types'
import {
  toMatchView,
  toRoomSummary,
  toRoomView,
  type MatchView,
  type RoomSummary,
  type RoomView,
} from '@/src/tournament/views'
import type { PresenceStore, RoomStore } from './stores'
import type { TelegramUser } from './telegram-auth'

export interface RoomServiceDeps {
  rooms: RoomStore
  presence: PresenceStore
  now: () => number
  rng: () => number
  inviteUrl: (code: string) => string
}

const MAX_ATTEMPTS = 5
const MAX_CODE_ATTEMPTS = 10
const LIST_LIMIT = 50

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
    )
    return toMatchView(res.room, matchId, user.id, res.now, res.presence)
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
    const now = this.deps.now()
    for (const loaded of await this.deps.rooms.findByPlayer(userId)) {
      if (loaded._id === exceptCode) continue
      const presence = await this.readPresence(loaded)
      const { room } = settleRoom(loaded, presence, now, this.deps.rng, ROOM_SCOPE)
      if (isActive(room, userId)) throw new RoomError('already_active', { activeCode: room._id })
    }
  }

  /** Last-seen times for the players of every playing match (plus the extra match, if given). */
  private readPresence(room: Room, extraMatchId?: string): Promise<Presence> {
    const ids = new Set<string>()
    for (const m of room.matches) {
      if (m.status !== 'playing' && m.id !== extraMatchId) continue
      for (const id of [m.a, m.b]) {
        if (id && !room.players.find((p) => p.userId === id)?.isBot) ids.add(id)
      }
    }
    return this.deps.presence.get(room._id, [...ids])
  }

  /**
   * get → (touch caller) → read presence → command (settling as it needs) → write only if changed
   * (CAS on version); retried from a fresh read on CAS failure, up to MAX_ATTEMPTS. If the command
   * throws a RoomError and settling alone changes the room, the settled room is still persisted
   * (same CAS rules) and then the original error is rethrown. Full-strength bot moves are scoped to
   * the caller's match (match requests) or to none (room requests); see SettleOpts.
   */
  private async mutate(code: string, command: Command, caller?: { matchId: string; userId: string }): Promise<Mutated> {
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
      const opts = { fullBotMatchId: caller?.matchId ?? null }
      let cached: { room: Room; changed: boolean } | null = null
      const settle = () => (cached ??= settleRoom(loaded, presence, now, this.deps.rng, opts))
      let next: Room
      try {
        next = command(loaded, presence, now, () => settle().room)
      } catch (e) {
        if (!(e instanceof RoomError)) throw e
        const settled = settle()
        if (!settled.changed) throw e
        if (await this.write(settled.room, loaded.version, now)) throw e
        continue // CAS lost: re-read and retry
      }
      // settling changes the room whenever it reports `changed`, so equality means "nothing to write"
      if (JSON.stringify(next) === JSON.stringify(loaded)) {
        return { room: loaded, presence, now }
      }
      const saved = await this.write(next, loaded.version, now)
      if (saved) return { room: saved, presence, now }
    }
    throw new RoomError('conflict')
  }

  /** CAS write; a running room gets its activity expiry refreshed. Returns the stored room or null. */
  private async write(room: Room, version: number, now: number): Promise<Room | null> {
    const next = room.status === 'running' ? { ...room, expiresAt: new Date(now + LOBBY_TTL_MS) } : room
    if (!(await this.deps.rooms.replace(next, version))) return null
    return { ...next, version: version + 1 }
  }
}
