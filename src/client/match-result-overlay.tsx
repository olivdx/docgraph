'use client'

import { useLayoutEffect, useRef } from 'react'
import type { MatchView } from '@/src/tournament/views'
import type { Side } from '@/src/game/types'
import { animateResultOverlayIn, animateResultOverlayOut } from './gsap-animations'

type EndReason = NonNullable<MatchView['endReason']>

const WIN_REASON: Record<EndReason, string> = {
  five_in_row: 'Open five',
  turn_timeout: 'Opponent timed out',
  disconnect_timeout: 'Opponent disconnected',
  resign: 'Opponent resigned',
  no_show: "Opponent didn't show up",
  board_full: 'Board full',
  left: 'Opponent left',
}
const LOSE_REASON: Record<EndReason, string> = {
  five_in_row: 'Opponent made open five',
  turn_timeout: 'You timed out',
  disconnect_timeout: 'You disconnected',
  resign: 'You resigned',
  no_show: "You didn't show up",
  board_full: 'Board full',
  left: 'You left',
}
const loserReason = (loser: string): Record<EndReason, string> => ({
  five_in_row: 'Open five',
  turn_timeout: `${loser} timed out`,
  disconnect_timeout: `${loser} disconnected`,
  resign: `${loser} resigned`,
  no_show: `${loser} didn't show up`,
  board_full: 'Board full',
  left: `${loser} left`,
})

const ROUND_ORDER = ['Quarterfinal', 'Semifinal', 'Final']
function nextRoundAfter(round: string): string {
  const m = /^Round of (\d+)$/.exec(round)
  if (m) {
    const n = Number(m[1]) / 2
    return n === 8 ? 'Quarterfinal' : n === 4 ? 'Semifinal' : n === 2 ? 'Final' : `Round of ${n}`
  }
  const i = ROUND_ORDER.indexOf(round)
  return i >= 0 && i < ROUND_ORDER.length - 1 ? ROUND_ORDER[i + 1] : 'the next round'
}

const opposite = (s: Side): Side => (s === 'X' ? 'O' : 'X')

type Props = {
  view: MatchView
  onBracket: () => void
  onNext: (() => void) | null
  onClose: () => void
}

export function MatchResultOverlay({ view, onBracket, onNext, onClose }: Props) {
  const scrimRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const closing = useRef(false)

  const { you, winner, endReason } = view
  const winnerName = winner ? (view.players[winner]?.name ?? '?') : null
  const loserName = winner ? (view.players[opposite(winner)]?.name ?? '?') : '?'
  const won = you !== null && winner === you
  const lost = you !== null && winner !== null && winner !== you
  const kind = lost ? 'lose' : 'win'

  const title = you
    ? won
      ? 'You win!'
      : lost
        ? 'You lose'
        : 'Match over'
    : winnerName
      ? `${winnerName} wins`
      : 'Match over'
  const free = view.mode === 'free'
  // Free play is decided on score, so whoever left or dropped is not necessarily the loser.
  const reason = !endReason
    ? null
    : free && endReason === 'left'
      ? 'Free play ended'
      : free && endReason === 'disconnect_timeout'
        ? 'A player disconnected'
        : you
          ? (won ? WIN_REASON : LOSE_REASON)[endReason]
          : loserReason(loserName)[endReason]

  let next: string | null = null
  if (you && !free) {
    if (view.nextStep === 'champion') next = 'Champion!'
    else if (view.nextStep === 'eliminated') next = "You're out. Thanks for playing!"
    else if (view.nextStep === 'next_match')
      next = `Advancing to ${won ? nextRoundAfter(view.roundName) : '3rd Place'}`
    else if (view.nextStep === 'podium') next = won ? 'Third place! 🥉' : 'Runner-up! 🥈'
  }

  const emoji = lost ? '😔' : view.nextStep === 'champion' ? '🏆' : '🎉'

  useLayoutEffect(() => {
    const scrim = scrimRef.current
    const modal = modalRef.current
    if (!scrim || !modal) return
    animateResultOverlayIn(scrim, modal, kind)
  }, [kind])

  const requestClose = () => {
    if (closing.current) return
    closing.current = true
    const scrim = scrimRef.current
    const modal = modalRef.current
    if (!scrim || !modal) {
      onClose()
      return
    }
    animateResultOverlayOut(scrim, modal, () => {
      closing.current = false
      onClose()
    })
  }

  return (
    <div
      ref={scrimRef}
      className="fixed inset-0 z-10 flex items-center justify-center bg-bg/75 p-4 opacity-0 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-sm rounded-[22px] border border-line bg-panel p-5 text-center shadow-2xl"
      >
        <div className="result-emoji text-[40px]">{emoji}</div>
        <div className="result-stagger font-display text-[22px] text-white uppercase">{title}</div>
        {(view.bestOf === 3 || free) && (
          <div className="result-stagger mt-1 font-display text-[15px] tabular-nums text-lime">
            {you
              ? `${view.score[you]} – ${view.score[opposite(you)]}`
              : `${view.players.X?.name ?? '?'} ${view.score.X} – ${view.score.O} ${view.players.O?.name ?? '?'}`}
          </div>
        )}
        <div className="result-stagger mt-1.5 mb-3.5 text-[13px] text-muted">
          {[reason, next].filter(Boolean).join(' · ')}
        </div>
        {onNext && (
          <div className="result-next-box mb-2.5 rounded-2xl border border-accent bg-[linear-gradient(90deg,rgba(108,121,255,0.14),var(--panel))] p-3">
            <div className="result-stagger mb-2 font-display text-sm text-white">Your next match is ready</div>
            <button
              type="button"
              onClick={onNext}
              className="result-stagger-btn arcade-glow block w-full rounded-xl bg-accent p-[13px] font-display text-sm tracking-wider text-white uppercase"
            >
              ENTER MATCH →
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onBracket}
          className={`result-stagger-btn block w-full rounded-xl p-[13px] font-display text-sm tracking-wider uppercase ${
            onNext ? 'border border-line bg-panel2 text-text' : 'arcade-glow bg-accent text-white'
          }`}
        >
          {free ? 'BACK TO ROOMS' : 'VIEW BRACKET'}
        </button>
        <button
          type="button"
          onClick={requestClose}
          className="result-link-btn mt-2 font-display text-xs tracking-wider text-muted uppercase underline"
        >
          VIEW BOARD
        </button>
      </div>
    </div>
  )
}
