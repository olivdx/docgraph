'use client'

import type { Side } from '@/src/game/types'
import type { MatchView } from '@/src/tournament/views'

type EndReason = NonNullable<MatchView['endReason']>

const HOW: Record<EndReason, string> = {
  five_in_row: 'Open five',
  turn_timeout: 'timed out',
  disconnect_timeout: 'disconnected',
  resign: 'resigned',
  no_show: "didn't show up",
  board_full: 'Board full',
  left: 'left',
}

const opposite = (s: Side): Side => (s === 'X' ? 'O' : 'X')

type Props = {
  view: MatchView
  /** ms left to accept, already ticked down locally */
  remainingMs: number
  busy: boolean
  onRematch: () => void
  onLeave: () => void
}

/**
 * Free play, after a game: the game's result, the running score and the rematch choice. A bottom
 * sheet rather than a full overlay, so the finished board (and its winning line) stays readable.
 */
export function RematchPanel({ view, remainingMs, busy, onRematch, onLeave }: Props) {
  const r = view.rematch
  const g = view.lastGame
  if (!r || !g) return null
  const { you } = view
  const loser = view.players[opposite(g.winner)]?.name ?? '?'
  const winnerName = view.players[g.winner]?.name ?? '?'
  const opp = you ? view.players[opposite(you)] : null
  const oppName = opp?.name ?? 'Opponent'
  const how = g.endReason === 'five_in_row' || g.endReason === 'board_full' ? HOW[g.endReason] : `${loser} ${HOW[g.endReason]}`
  const title = you ? (g.winner === you ? 'You win this one!' : 'You lose this one') : `${winnerName} wins game ${view.gameNo}`
  const secs = Math.ceil(remainingMs / 1000)

  return (
    <div className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-md rounded-[20px] border border-accent/50 bg-panel/95 p-4 text-center shadow-2xl backdrop-blur-md">
      <div className="font-display text-lg text-white">{title}</div>
      <div className="mt-0.5 text-xs text-muted">
        Game {view.gameNo} · {how}
      </div>
      <div className="my-2.5 font-display text-2xl tabular-nums text-lime">
        {you
          ? `You ${view.score[you]} – ${view.score[opposite(you)]} ${oppName}`
          : `${view.players.X?.name ?? '?'} ${view.score.X} – ${view.score.O} ${view.players.O?.name ?? '?'}`}
      </div>

      {you ? (
        <>
          {r.opponent && !r.you && (
            <div className="mb-2 rounded-lg bg-[var(--lime-bg)] px-2 py-1.5 font-display text-xs text-lime">
              {opp?.isBot ? `${oppName} is ready` : `${oppName} wants a rematch!`}
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button
              type="button"
              disabled={busy || r.you}
              onClick={onRematch}
              className="arcade-glow rounded-xl bg-accent p-3 font-display text-sm tracking-wider text-white uppercase disabled:opacity-60"
            >
              {r.you ? `Waiting for ${oppName}…` : 'Rematch · sides swap'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onLeave}
              className="rounded-xl border border-line bg-panel2 px-4 font-display text-sm tracking-wider text-muted uppercase disabled:opacity-60"
            >
              Leave
            </button>
          </div>
        </>
      ) : (
        <div className="text-xs text-muted">Waiting for a rematch…</div>
      )}
      <div className="mt-2 text-[11px] text-muted">The room closes in {secs}s without a rematch.</div>
    </div>
  )
}
