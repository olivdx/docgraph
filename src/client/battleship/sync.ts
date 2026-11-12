/** Pure helpers that turn polled match views into scene updates. */
import type { Seat, Ship } from '@/src/battleship/types'
import type { BattleMatchView, ShotView } from '@/src/battleship/views'

export type Board = 'me' | 'enemy'

/** The viewer's own sea is 'me'; a watcher sees seat a as 'me'. */
export function boardOf(you: Seat | null, seat: Seat): Board {
  return seat === (you ?? 'a') ? 'me' : 'enemy'
}

export interface NewShot {
  /** The board being shot at (the shooter's opposite). */
  board: Board
  shot: ShotView
  /** The ship this shot sank, from the next view's fleets. */
  sunkShip: Ship | null
}

/** Shots in `next` that `prev` didn't have yet, seat a's first, each seat oldest first. */
export function newShots(prev: BattleMatchView | null, next: BattleMatchView): NewShot[] {
  const out: NewShot[] = []
  for (const shooter of ['a', 'b'] as const) {
    const target: Seat = shooter === 'a' ? 'b' : 'a'
    const from = prev?.shots[shooter].length ?? 0
    for (const shot of next.shots[shooter].slice(from)) {
      const sunkShip =
        shot.result === 'sunk' && shot.shipKey ? (next.fleets[target].find((s) => s.key === shot.shipKey) ?? null) : null
      out.push({ board: boardOf(next.you, target), shot, sunkShip })
    }
  }
  return out
}

type Stamped = Pick<BattleMatchView, 'version' | 'serverNow'>

/**
 * Whether `next` shows the match later than `prev`. The room version decides: a request stamps
 * `serverNow` before its write lands, so a poll that read the room just before your shot was saved
 * carries a later clock but the older state. The clock only orders views of the same version.
 */
export function isNewerView(prev: Stamped, next: Stamped): boolean {
  return next.version > prev.version || (next.version === prev.version && next.serverNow > prev.serverNow)
}

/** The later of the answer to your own action and the polled view. */
export function latestView<T extends Stamped>(override: T | null, polled: T | null): T | null {
  if (!override || !polled) return override ?? polled
  return isNewerView(polled, override) ? override : polled
}
