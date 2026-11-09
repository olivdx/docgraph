import { BATTLE_CODE_LEN, LOBBY_TTL_MS } from '@/src/battleship/constants'
import {
  cancelBattle,
  createBattleRoom,
  fire,
  isActiveBattle,
  joinBattle,
  leaveBattle,
  markBattleReady,
  resignBattle,
  saveFleet,
  settleBattle,
  startBattle,
} from '@/src/battleship/room'
import type { BattleRoom, Ship } from '@/src/battleship/types'
import {
  toBattleMatchView,
  toBattleRoomView,
  toBattleSummary,
  type BattleMatchView,
  type BattleRoomView,
  type BattleSummary,
} from '@/src/battleship/views'
import { battleshipMatchChannel, battleshipRoomChannel } from '@/src/realtime/channels'
import { randomCode } from '@/src/tournament/codes'
import { RoomError } from '@/src/tournament/types'
import type { BattleStore } from './battleship-store'
import type { PresenceStore } from './stores'
import type { TelegramUser } from './telegram-auth'

export interface BattleshipServiceDeps {
  rooms: BattleStore
  presence: PresenceStore
  now: () => number
  rng: () => number
  inviteUrl: (code: string) => string
  /** The code of a room the user is active in in another game (Caro, Sudoku), or null. */
  activeElsewhere?: (userId: string) => Promise<string | null>
  /** Called after each successful write with the realtime channels whose content changed. */
  notify?: (channels: string[], version: number) => void
}

const MAX_ATTEMPTS = 5
const MAX_CODE_ATTEMPTS = 10
const LIST_LIMIT = 50

type Presence = Record<string, number>
/** `loaded` is the room as read; `settled()` settles it lazily (at most once per attempt). */
type Command = (loaded: BattleRoom, presence: Presence, now: number, settled: () => BattleRoom) => BattleRoom

const userInfo = (u: TelegramUser) => ({ userId: u.id, name: u.name, avatarUrl: u.avatarUrl })
const LIVE = ['pending', 'placing', 'playing']

function isParticipant(room: BattleRoom, matchId: string, userId: string): boolean {
  const m = room.matches.find((x) => x.id === matchId)
  return !!m && (m.a === userId || m.b === userId)
}

/** What the lobby/bracket shows: a change here rings the room channel (shots alone don't). */
function bracketShape(room: BattleRoom): string {
  return JSON.stringify([
    room.status,
    room.name,
    room.players,
    room.placements,
    room.matches.map((m) => [m.id, m.status, m.a, m.b, m.winner]),
  ])
}

export function changedChannels(before: BattleRoom, after: BattleRoom): string[] {
  const out: string[] = []
  if (bracketShape(before) !== bracketShape(after)) out.push(battleshipRoomChannel(after._id))
  for (const m of after.matches) {
    const prev = before.matches.find((x) => x.id === m.id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) out.push(battleshipMatchChannel(after._id, m.id))
  }
  return out
}

export class BattleshipService {
  constructor(private deps: BattleshipServiceDeps) {}

  // ---- queries ---------------------------------------------------------------------------------

  /** The cup this user is active in (and their live match there), else null. */
  async me(user: Pick<TelegramUser, 'id'>): Promise<{ code: string; matchId: string | null } | null> {
    const now = this.deps.now()
    for (const loaded of await this.deps.rooms.findByPlayer(user.id)) {
      const presence = await this.readPresence(loaded)
      const { room } = settleBattle(loaded, presence, now, this.deps.rng)
      if (!isActiveBattle(room, user.id)) continue
      const m = room.matches.find((x) => (x.a === user.id || x.b === user.id) && LIVE.includes(x.status))
      return { code: room._id, matchId: m?.id ?? null }
    }
    return null
  }

  async activeCode(userId: string): Promise<string | null> {
    return (await this.me({ id: userId }))?.code ?? null
  }

  async list(user: TelegramUser): Promise<BattleSummary[]> {
    return (await this.deps.rooms.listOpen(LIST_LIMIT)).map((r) => toBattleSummary(r, user.id))
  }

  // ---- room commands ---------------------------------------------------------------------------

  async create(user: TelegramUser, name?: string): Promise<BattleRoomView> {
    await this.assertNotActiveElsewhere(user.id, null)
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const now = this.deps.now()
      const room = createBattleRoom({ code: randomCode(BATTLE_CODE_LEN, this.deps.rng), host: userInfo(user), name, now })
      if (await this.deps.rooms.insert(room)) return this.roomView(room, user, now)
    }
    throw new RoomError('conflict')
  }

  async getRoom(code: string, user: TelegramUser): Promise<BattleRoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, _t, settled) => settled())
    return this.roomView(room, user, now)
  }

  async join(code: string, user: TelegramUser): Promise<BattleRoomView> {
    await this.assertNotActiveElsewhere(user.id, code)
    const { room, now } = await this.mutate(code, (_l, _p, t, settled) => joinBattle(settled(), userInfo(user), t))
    return this.roomView(room, user, now)
  }

  async leave(code: string, user: TelegramUser): Promise<BattleRoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, _t, settled) => leaveBattle(settled(), user.id))
    return this.roomView(room, user, now)
  }

  async cancel(code: string, user: TelegramUser): Promise<BattleRoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, t, settled) => cancelBattle(settled(), user.id, t))
    return this.roomView(room, user, now)
  }

  async start(code: string, user: TelegramUser): Promise<BattleRoomView> {
    const { room, now } = await this.mutate(code, (_l, _p, t, settled) => startBattle(settled(), user.id, t, this.deps.rng))
    return this.roomView(room, user, now)
  }

  // ---- match commands --------------------------------------------------------------------------

  /** Opens a match: a participant is marked ready (and counted as present); a watcher only settles. */
  async getMatch(code: string, matchId: string, user: TelegramUser): Promise<BattleMatchView> {
    const res = await this.mutate(
      code,
      (loaded, p, t, settled) =>
        isParticipant(loaded, matchId, user.id) ? markBattleReady(loaded, matchId, user.id, t, this.deps.rng, p) : settled(),
      { matchId, userId: user.id },
    )
    return toBattleMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  async saveFleet(code: string, matchId: string, user: TelegramUser, ships: Ship[], lock: boolean): Promise<BattleMatchView> {
    const res = await this.mutate(code, (loaded, p, t) => saveFleet(loaded, matchId, user.id, ships, lock, t, this.deps.rng, p), {
      matchId,
      userId: user.id,
    })
    return toBattleMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  async fire(code: string, matchId: string, user: TelegramUser, cell: number, seq: number): Promise<BattleMatchView> {
    const res = await this.mutate(code, (loaded, p, t) => fire(loaded, matchId, user.id, cell, seq, t, this.deps.rng, p), {
      matchId,
      userId: user.id,
    })
    return toBattleMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  async resign(code: string, matchId: string, user: TelegramUser): Promise<BattleMatchView> {
    const res = await this.mutate(code, (loaded, p, t) => resignBattle(loaded, matchId, user.id, t, this.deps.rng, p), {
      matchId,
      userId: user.id,
    })
    return toBattleMatchView(res.room, matchId, user.id, res.now, res.presence)
  }

  // ---- internals -------------------------------------------------------------------------------

  private roomView(room: BattleRoom, user: TelegramUser, now: number): BattleRoomView {
    return toBattleRoomView(room, user.id, now, this.deps.inviteUrl(room._id))
  }

  private async assertNotActiveElsewhere(userId: string, exceptCode: string | null): Promise<void> {
    const other = await this.deps.activeElsewhere?.(userId)
    if (other) throw new RoomError('already_active', { activeCode: other })
    const mine = await this.activeCode(userId)
    if (mine && mine !== exceptCode) throw new RoomError('already_active', { activeCode: mine })
  }

  /** Last-seen times of the players in placing/playing matches (plus the caller's match). */
  private async readPresence(room: BattleRoom, extraMatchId?: string): Promise<Presence> {
    const ids = new Set<string>()
    for (const m of room.matches) {
      if (m.status !== 'placing' && m.status !== 'playing' && m.id !== extraMatchId) continue
      for (const id of [m.a, m.b]) if (id) ids.add(id)
    }
    if (ids.size === 0) return {}
    return this.deps.presence.get(room._id, [...ids])
  }

  /**
   * get → (touch caller) → read presence → command → CAS write if changed, retried on a lost race.
   * If the command throws a RoomError but settling alone changed the room (a clock ran out), the
   * settled room is still saved before the error is rethrown.
   */
  private async mutate(
    code: string,
    command: Command,
    caller?: { matchId: string; userId: string },
  ): Promise<{ room: BattleRoom; presence: Presence; now: number }> {
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
      let cached: { room: BattleRoom; changed: boolean } | null = null
      const settle = () => (cached ??= settleBattle(loaded, presence, now, this.deps.rng))
      let next: BattleRoom
      try {
        next = command(loaded, presence, now, () => settle().room)
      } catch (e) {
        if (!(e instanceof RoomError)) throw e
        const settled = settle()
        if (!settled.changed) throw e
        const written = await this.write(settled.room, loaded.version, now)
        if (written) {
          this.notifyChanged(loaded, written)
          throw e
        }
        continue
      }
      if (JSON.stringify(next) === JSON.stringify(loaded)) return { room: loaded, presence, now }
      const saved = await this.write(next, loaded.version, now)
      if (saved) {
        this.notifyChanged(loaded, saved)
        return { room: saved, presence, now }
      }
    }
    throw new RoomError('conflict')
  }

  private notifyChanged(before: BattleRoom, after: BattleRoom): void {
    if (!this.deps.notify) return
    const channels = changedChannels(before, after)
    if (channels.length) this.deps.notify(channels, after.version)
  }

  /** CAS write; a running cup gets its activity expiry refreshed. Returns the stored room or null. */
  private async write(room: BattleRoom, version: number, now: number): Promise<BattleRoom | null> {
    const next = room.status === 'running' ? { ...room, expiresAt: new Date(now + LOBBY_TTL_MS) } : room
    if (!(await this.deps.rooms.replace(next, version))) return null
    return { ...next, version: version + 1 }
  }
}
