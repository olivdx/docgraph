import { randomCode } from '@/src/tournament/codes'
import { RoomError } from '@/src/tournament/types'
import { SUDOKU_CODE_LEN } from '@/src/sudoku/constants'
import {
  cancelSudoku,
  createSudokuRoom,
  enterDigit,
  giveUp,
  isActiveSudoku,
  joinSudoku,
  leaveSudoku,
  setDifficulty,
  settleSudoku,
  startSudoku,
} from '@/src/sudoku/room'
import type { Difficulty, SudokuRoom } from '@/src/sudoku/types'
import { toSudokuSummary, toSudokuView, type SudokuSummary, type SudokuView } from '@/src/sudoku/views'
import { sudokuChannel } from '@/src/realtime/channels'
import type { SudokuStore } from './sudoku-store'
import type { TelegramUser } from './telegram-auth'

export interface SudokuServiceDeps {
  rooms: SudokuStore
  now: () => number
  rng: () => number
  inviteUrl: (code: string) => string
  /** The code of a room the user is active in in the *other* game (Caro), or null. */
  activeElsewhere?: (userId: string) => Promise<string | null>
  /** Called after each successful write with the realtime channels whose content changed. */
  notify?: (channels: string[], version: number) => void
}

const MAX_ATTEMPTS = 5
const MAX_CODE_ATTEMPTS = 10
const LIST_LIMIT = 50

type Command = (settled: SudokuRoom, now: number) => SudokuRoom

const userInfo = (u: TelegramUser) => ({ userId: u.id, name: u.name, avatarUrl: u.avatarUrl })

export class SudokuService {
  constructor(private deps: SudokuServiceDeps) {}

  /** Code of the Sudoku room this user is active in (lobby, or still racing), else null. */
  async activeCode(userId: string): Promise<string | null> {
    const now = this.deps.now()
    for (const loaded of await this.deps.rooms.findByPlayer(userId)) {
      const { room } = settleSudoku(loaded, now)
      if (isActiveSudoku(room, userId)) return room._id
    }
    return null
  }

  async list(user: TelegramUser): Promise<SudokuSummary[]> {
    const now = this.deps.now()
    return (await this.deps.rooms.listOpen(LIST_LIMIT))
      .map((r) => settleSudoku(r, now).room)
      .filter((r) => r.status === 'lobby' || r.status === 'playing')
      .map((r) => toSudokuSummary(r, user.id))
  }

  async create(user: TelegramUser, name?: string, difficulty?: Difficulty): Promise<SudokuView> {
    await this.assertNotActiveElsewhere(user.id, null)
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const now = this.deps.now()
      const room = createSudokuRoom({ code: randomCode(SUDOKU_CODE_LEN, this.deps.rng), host: userInfo(user), name, difficulty, now })
      if (await this.deps.rooms.insert(room)) return this.view(room, user, now)
    }
    throw new RoomError('conflict')
  }

  get(code: string, user: TelegramUser) {
    return this.run(code, user, (r) => r)
  }

  async join(code: string, user: TelegramUser) {
    await this.assertNotActiveElsewhere(user.id, code)
    return this.run(code, user, (r, t) => joinSudoku(r, userInfo(user), t))
  }

  leave(code: string, user: TelegramUser) {
    return this.run(code, user, (r) => leaveSudoku(r, user.id))
  }

  cancel(code: string, user: TelegramUser) {
    return this.run(code, user, (r, t) => cancelSudoku(r, user.id, t))
  }

  start(code: string, user: TelegramUser) {
    return this.run(code, user, (r, t) => startSudoku(r, user.id, t, this.deps.rng))
  }

  difficulty(code: string, user: TelegramUser, d: Difficulty) {
    return this.run(code, user, (r) => setDifficulty(r, user.id, d))
  }

  enter(code: string, user: TelegramUser, cell: number, digit: number, seq: number) {
    return this.run(code, user, (r, t) => enterDigit(r, user.id, cell, digit, seq, t))
  }

  giveUp(code: string, user: TelegramUser) {
    return this.run(code, user, (r, t) => giveUp(r, user.id, t))
  }

  // ---- internals -------------------------------------------------------------------------------

  private view(room: SudokuRoom, user: TelegramUser, now: number): SudokuView {
    return toSudokuView(room, user.id, now, this.deps.inviteUrl(room._id))
  }

  private async assertNotActiveElsewhere(userId: string, exceptCode: string | null): Promise<void> {
    const other = await this.deps.activeElsewhere?.(userId)
    if (other) throw new RoomError('already_active', { activeCode: other })
    const mine = await this.activeCode(userId)
    if (mine && mine !== exceptCode) throw new RoomError('already_active', { activeCode: mine })
  }

  /**
   * get → settle → command → CAS write if changed, retried on a lost race. If the command throws a
   * RoomError but settling changed the room (a clock ran out), the settled room is still saved
   * before the error is rethrown.
   */
  private async run(code: string, user: TelegramUser, command: Command): Promise<SudokuView> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loaded = await this.deps.rooms.get(code)
      if (!loaded) throw new RoomError('not_found')
      const now = this.deps.now()
      const settled = settleSudoku(loaded, now)
      let next: SudokuRoom
      try {
        next = command(settled.room, now)
      } catch (e) {
        if (!(e instanceof RoomError) || !settled.changed) throw e
        if (await this.deps.rooms.replace(settled.room, loaded.version)) {
          this.deps.notify?.([sudokuChannel(code)], loaded.version + 1)
          throw e
        }
        continue
      }
      if (next === loaded || JSON.stringify(next) === JSON.stringify(loaded)) return this.view(loaded, user, now)
      if (await this.deps.rooms.replace(next, loaded.version)) {
        this.deps.notify?.([sudokuChannel(code)], loaded.version + 1)
        return this.view({ ...next, version: loaded.version + 1 }, user, now)
      }
    }
    throw new RoomError('conflict')
  }
}
