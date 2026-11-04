import type { Side } from '@/src/game/types'
import type { MoveSignal } from '@/src/realtime/channels'
import type { MatchView } from '@/src/tournament/views'

/** How long a drawn move signal outranks fetched views that don't have it yet. */
export const SIGNAL_GRACE_MS = 3_000

/**
 * A move signal drawn ahead of the server: until `until`, a fetched view of an earlier game, or of
 * game `game` with fewer than `count` moves, is stale.
 */
export interface PendingSignal {
  game: number
  count: number
  until: number
}

const opposite = (s: Side): Side => (s === 'X' ? 'O' : 'X')

/**
 * The shown view with a move signal applied, or null when it doesn't fit: another match or game,
 * no one is to move (not playing, or a break between games), or the signal doesn't start right
 * after the last shown move (already shown, or a gap; the next fetch fills it in).
 */
export function applyMoveSignal(view: MatchView, s: MoveSignal): MatchView | null {
  if (s.matchId !== view.id || s.game !== view.gameNo) return null
  if (view.status !== 'playing' || view.turn === null) return null
  if (s.from !== view.moves.length || s.moves.length === 0) return null
  const moves = [...view.moves, ...s.moves]
  return {
    ...view,
    moves,
    // no clock means the move ended the game: no one moves until the next fetch says what's next
    turn: s.turnRemainingMs === null ? null : opposite(moves[moves.length - 1].side),
    turnRemainingMs: s.turnRemainingMs,
    // whoever just moved is evidently connected
    opponentDisconnected: false,
    opponentReconnectRemainingMs: null,
  }
}

/** True when a fetched view predates a signalled move we already drew, within the grace period. */
export function isBehindSignal(view: MatchView, pending: PendingSignal | null, now: number): boolean {
  if (pending === null || now >= pending.until) return false
  return view.gameNo < pending.game || (view.gameNo === pending.game && view.moves.length < pending.count)
}
