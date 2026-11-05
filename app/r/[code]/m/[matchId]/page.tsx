'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ChevronLeftIcon } from '@/src/client/back-button'
import { MatchResultOverlay } from '@/src/client/match-result-overlay'
import { RematchPanel } from '@/src/client/rematch-panel'
import { markNavBack } from '@/src/client/nav-direction'
import { ApiError, apiGet, apiPost } from '@/src/client/api'
import { Board } from '@/src/client/board'
import { Mark } from '@/src/client/marks'
import { applyMoveSignal, isBehindSignal, SIGNAL_GRACE_MS, type PendingSignal } from '@/src/client/match-signal'
import { useRealtime } from '@/src/client/realtime'
import { caroMatchChannel, type MoveSignal } from '@/src/realtime/channels'
import { TURN_MS } from '@/src/tournament/constants'
import type { Cell, Side } from '@/src/game/types'
import type { MatchView } from '@/src/tournament/views'

const POLL_MS = 1_000
/** Poll interval when realtime is live vs a human: still the presence heartbeat (disconnect shows after 5 s). */
const LIVE_POLL_MS = 2_000
/** Spectators send no heartbeat, so with realtime live they only need a slow safety net. */
const WATCH_POLL_MS = 3_000
/** Fetch this long after a known deadline, so the server has settled it. */
const DEADLINE_SLACK_MS = 150
const NEXT_POLL_MS = 3_000 // after the match: waiting for the next match to become pending
const TICK_MS = 250

type EndReason = NonNullable<MatchView['endReason']>

const loserReason = (loser: string): Record<EndReason, string> => ({
  five_in_row: 'Open five',
  turn_timeout: `${loser} timed out`,
  disconnect_timeout: `${loser} disconnected`,
  resign: `${loser} resigned`,
  no_show: `${loser} didn't show up`,
  board_full: 'Board full',
  left: `${loser} left`,
})

const opposite = (s: Side): Side => (s === 'X' ? 'O' : 'X')

const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Delay before the next poll, or null to stop polling (finished, nothing left to wait for). */
function nextPollDelay(v: MatchView | null, live: boolean): number | null {
  if (!v) return POLL_MS
  if (v.status !== 'finished') {
    if (!live) return POLL_MS
    let base: number
    if (v.you === null) {
      base = WATCH_POLL_MS // the players' own requests settle the match; realtime tells us when
    } else {
      const opp = v.you === 'X' ? v.players.O : v.players.X
      // A bot's reply is only played when someone's request settles the match, so keep 1 s vs bots.
      if (!opp || opp.isBot) return POLL_MS
      base = LIVE_POLL_MS
    }
    const deadlines = [
      v.turnRemainingMs,
      v.pendingRemainingMs,
      v.opponentReconnectRemainingMs,
      v.nextGameRemainingMs,
      v.rematch?.remainingMs ?? null,
    ].filter(
      (d): d is number => d !== null && d >= 0,
    )
    return Math.min(base, ...deadlines.map((d) => d + DEADLINE_SLACK_MS))
  }
  if (v.nextStep === 'next_match' && !v.nextMatchId) return NEXT_POLL_MS
  return null
}

/** True only the first time this session for `key` (same guard as the bracket page's auto-enter). */
function firstTime(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return false
    sessionStorage.setItem(key, '1')
    return true
  } catch {
    return false
  }
}

interface Synced {
  view: MatchView
  at: number // local Date.now() when the view was received
}

export default function MatchPage() {
  const { code, matchId } = useParams<{ code: string; matchId: string }>()
  const router = useRouter()
  const path = `/api/rooms/${code}/matches/${matchId}`

  const [state, setState] = useState<Synced | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [now, setNow] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [resultHidden, setResultHidden] = useState(false)
  const flying = useRef(false)
  const seq = useRef(0)
  const applied = useRef(0)
  const latest = useRef<MatchView | null>(null)

  const apply = useCallback((my: number, view: MatchView) => {
    if (my < applied.current) return
    applied.current = my
    latest.current = view
    const at = Date.now()
    setState({ view, at })
    setNow(at)
    setLoadError(null)
  }, [])

  // An opponent's move arrives over realtime before it is stored: draw it at once, and for a short
  // grace period ignore fetched views that don't have it yet (they were read before the write).
  const pendingSignal = useRef<PendingSignal | null>(null)
  const onMove = useCallback((s: MoveSignal) => {
    if (flying.current || !latest.current) return
    const next = applyMoveSignal(latest.current, s)
    if (!next) return
    const at = Date.now()
    pendingSignal.current = { game: next.gameNo, count: next.moves.length, until: at + SIGNAL_GRACE_MS }
    latest.current = next
    setState({ view: next, at })
    setNow(at)
  }, [])

  const kickRef = useRef<() => void>(() => {})
  const live = useRealtime(caroMatchChannel(code, matchId), () => kickRef.current(), onMove)
  const liveRef = useRef(live)
  useEffect(() => {
    liveRef.current = live
  }, [live])

  const poll = useCallback(async () => {
    const my = ++seq.current
    try {
      const v = await apiGet<MatchView>(path)
      if (flying.current) return // the move response will bring a fresher view
      if (isBehindSignal(v, pendingSignal.current, Date.now())) return
      apply(my, v)
    } catch (e) {
      if (my >= applied.current) setLoadError(e instanceof ApiError ? e : new ApiError(0, 'unknown'))
    }
  }, [path, apply])

  // Completion-chained polling: the next request is scheduled only after the previous one settled.
  // Paused while hidden; 1 s while the match is live (2 s, or until the next deadline, when realtime
  // signals are flowing vs a human), 3 s on the result card while waiting for the next match,
  // stopped otherwise. A realtime signal fetches right away (or right after the in-flight request).
  useEffect(() => {
    let stopped = false
    let running = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      timer = null
      if (stopped || running || document.hidden) return
      running = true
      await poll()
      running = false
      if (stopped) return
      if (again) {
        again = false
        void run()
        return
      }
      const delay = nextPollDelay(latest.current, liveRef.current)
      if (delay !== null) timer = setTimeout(() => void run(), delay)
    }
    const kick = () => {
      if (stopped || document.hidden) return
      if (running) {
        again = true
        return
      }
      if (timer) clearTimeout(timer)
      void run()
    }
    kickRef.current = kick
    const onVis = () => {
      if (!document.hidden) kick()
    }
    timer = setTimeout(() => void run(), 0)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      kickRef.current = () => {}
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [poll])

  // Your next match became pending: enter it automatically (once per session, like the bracket page).
  // (Also while watching someone else's match: your own match takes priority.)
  const nextMatchId = state?.view.nextMatchId ?? null
  useEffect(() => {
    if (nextMatchId && firstTime(`auto:${nextMatchId}`)) router.push(`/r/${code}/m/${nextMatchId}`)
  }, [nextMatchId, code, router])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 2_500)
    return () => clearTimeout(id)
  }, [toast])

  const play = useCallback(
    async (cell: Cell) => {
      if (flying.current || !state) return
      const prev = state.view
      if (!prev.you || prev.turn !== prev.you || prev.status !== 'playing') return
      flying.current = true
      setInFlight(true)
      const at = Date.now()
      setState({
        view: {
          ...prev,
          moves: [...prev.moves, { x: cell.x, y: cell.y, side: prev.you, at }],
          turn: opposite(prev.you),
          turnRemainingMs: null,
        },
        at,
      })
      try {
        const v = await apiPost<MatchView>(`${path}/move`, { x: cell.x, y: cell.y, clientMoveNo: prev.moves.length })
        flying.current = false
        // Ignore every response to a request sent before this one returned (it may predate the move).
        apply(++seq.current, v)
      } catch (e) {
        flying.current = false
        setState({ view: prev, at: state.at })
        const c = e instanceof ApiError ? e.code : 'unknown'
        setToast(
          c === 'network'
            ? 'Connection problem. Move not sent.'
            : c === 'occupied'
              ? 'That cell is taken.'
              : c === 'not_your_turn'
                ? 'Not your turn.'
                : 'Move rejected.',
        )
      } finally {
        setInFlight(false)
      }
      void poll()
    },
    [state, path, apply, poll],
  )

  const resign = useCallback(async () => {
    const free = state?.view.mode === 'free'
    const question = free ? 'Resign this game? Your opponent gets the point.' : 'Resign this match? Your opponent wins.'
    if (!state?.view.you || !window.confirm(question)) return
    try {
      const v = await apiPost<MatchView>(`${path}/resign`)
      apply(++seq.current, v)
    } catch {
      setToast('Could not resign. Try again.')
    }
  }, [state, path, apply])

  // Free play: rematch after a game, or leave (which ends the room for both players).
  const [freeBusy, setFreeBusy] = useState(false)
  const freeAction = useCallback(
    async (action: 'rematch' | 'leave') => {
      if (!state?.view.you || freeBusy) return
      if (action === 'leave' && !window.confirm('Leave free play? The room ends for both of you.')) return
      setFreeBusy(true)
      try {
        const v = await apiPost<MatchView>(`${path}/${action}`)
        apply(++seq.current, v)
      } catch {
        setToast(action === 'rematch' ? 'Could not start a rematch. Try again.' : 'Could not leave. Try again.')
      } finally {
        setFreeBusy(false)
      }
    },
    [state, freeBusy, path, apply],
  )

  // Free play has no bracket: "back" goes to the room list.
  const toBracket = () => router.push(state?.view.mode === 'free' ? '/caro' : `/r/${code}`)

  if (!state) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 p-4 text-sm text-muted">
        {loadError?.status === 404 ? (
          <>
            <div>Match not found.</div>
            <button
              onClick={toBracket}
              className="rounded-xl border border-line bg-panel2 px-5 py-3 font-semibold text-text"
            >
              View bracket
            </button>
          </>
        ) : loadError ? (
          'Could not load the match. Retrying…'
        ) : (
          'Loading…'
        )}
      </main>
    )
  }

  const { view, at } = state
  const elapsed = Math.max(0, now - at)
  const left = (ms: number | null) => (ms === null ? null : Math.max(0, ms - elapsed))
  const turnLeft = left(view.turnRemainingMs)
  const pendingLeft = left(view.pendingRemainingMs)
  const reconnectLeft = left(view.opponentReconnectRemainingMs)
  const nextGameLeft = left(view.nextGameRemainingMs)
  const bo3 = view.bestOf === 3
  const free = view.mode === 'free'
  const rematchLeft = left(view.rematch?.remainingMs ?? null)
  const sides: Side[] = view.you === 'O' ? ['O', 'X'] : ['X', 'O']
  const oppName = view.you ? (view.players[opposite(view.you)]?.name ?? 'opponent') : null
  const finished = view.status === 'finished'

  return (
    <main className="mx-auto flex h-dvh w-full max-w-md flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between gap-2 text-sm">
        <button
          onClick={() => {
            markNavBack()
            toBracket()
          }}
          className="flex min-w-0 items-center gap-2 text-left font-display text-sm text-white"
        >
          <span className="grid size-8 flex-none place-items-center rounded-xl border border-line bg-panel text-white">
            <ChevronLeftIcon size={18} />
          </span>
          <span className="truncate">
            {free ? 'Free play' : view.roundName} · #{view.id}
          </span>
        </button>
        {view.you === null && <span className="lime-pill">● WATCHING</span>}
        {free ? (
          <span className="lime-pill">FREE PLAY</span>
        ) : (
          <button
            onClick={toBracket}
            className="rounded-lg border border-line bg-panel px-2.5 py-1 font-display text-xs tracking-wider text-muted uppercase hover:text-white"
          >
            BRACKET
          </button>
        )}
      </div>

      <div className="flex items-stretch gap-2">
        {sides.map((s) => {
          const p = view.players[s]
          const isYou = view.you === s
          const active = view.status === 'playing' && view.turn === s
          const displayName = isYou ? 'You' : p?.name ?? 'TBD'
          const status = active
            ? isYou
              ? 'Your turn'
              : p?.isBot
                ? 'Thinking…'
                : view.you
                  ? 'Their turn'
                  : 'To move'
            : 'Waiting'
          const time = active ? (turnLeft === null ? '…' : clock(turnLeft)) : clock(TURN_MS)
          const timerLow = active && turnLeft !== null && turnLeft <= 5_000
          return (
            <div
              key={s}
              className={`flex min-h-[4.25rem] min-w-0 flex-1 items-center gap-2 rounded-[16px] border bg-panel px-3 py-2.5 ${
                active ? 'border-accent' : 'border-line'
              }`}
            >
              <Mark side={s} size={20} />
              <div className="min-w-0 flex-1 self-center">
                <div className="flex min-w-0 items-center gap-1">
                  {!isYou && p?.isBot ? (
                    <span className="shrink-0 text-sm leading-none" aria-hidden>
                      🤖
                    </span>
                  ) : null}
                  <b className="truncate font-display text-xs text-white">{displayName}</b>
                </div>
                <span className="mt-0.5 block text-[11px] leading-tight text-muted">{status}</span>
              </div>
              {bo3 || free ? (
                <span
                  aria-label={`${view.score[s]} games won`}
                  className="flex-none self-center rounded-md bg-panel2 px-1.5 py-0.5 font-display text-xs tabular-nums text-white"
                >
                  {view.score[s]}
                </span>
              ) : null}
              <span
                className={`ml-auto flex-none self-center rounded-lg px-2 py-1 font-display text-sm tabular-nums min-w-[3.25rem] text-center ${
                  active
                    ? timerLow
                      ? 'bg-rose-500/15 text-o'
                      : 'bg-[var(--lime-bg)] text-lime'
                    : 'bg-panel2 text-muted'
                }`}
              >
                {time}
              </span>
            </div>
          )
        })}
      </div>

      {view.lastGame && !finished && view.nextGameRemainingMs !== null && (
        <div className="rounded-[10px] border border-accent/50 bg-accent/15 px-2.5 py-2 text-center text-xs">
          <b>
            Game {view.gameNo}:{' '}
            {view.you
              ? view.lastGame.winner === view.you
                ? 'you win'
                : 'you lose'
              : `${view.players[view.lastGame.winner]?.name ?? '?'} wins`}
          </b>{' '}
          · {loserReason(view.players[opposite(view.lastGame.winner)]?.name ?? '?')[view.lastGame.endReason]} · Game{' '}
          {view.gameNo + 1} starts in {Math.ceil((nextGameLeft ?? 0) / 1000)}s, sides swap
        </div>
      )}
      {view.opponentDisconnected && reconnectLeft !== null && (
        <div className="rounded-[10px] border border-[#78591a] bg-[#3a2a0b] px-2.5 py-2 text-xs text-amber-200">
          ⚠ Opponent disconnected: {Math.ceil(reconnectLeft / 1000)}s to reconnect, otherwise they forfeit.
        </div>
      )}
      {view.status === 'pending' && pendingLeft !== null && (
        <div className="rounded-[10px] border border-[#78591a] bg-[#3a2a0b] px-2.5 py-2 text-xs text-amber-200">
          Waiting for {oppName ?? 'players'} to join… ({Math.ceil(pendingLeft / 1000)}s)
        </div>
      )}

      <Board
        moves={view.moves}
        winLine={view.winLine}
        you={view.you}
        turn={view.turn}
        disabled={inFlight || view.status !== 'playing' || view.turn === null}
        onPlay={(c) => void play(c)}
      />

      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span>
          {bo3 ? `Game ${view.gameNo} of 3 · ` : free ? `Game ${view.gameNo} · ` : ''}Move {view.moves.length}
          {bo3 || free ? '' : ' · blocked-ends rule'}
        </span>
        <span>#{view.id}</span>
        {view.you && !finished && free ? (
          <span className="flex gap-3">
            {view.turn !== null && (
              <button onClick={() => void resign()} className="text-[#fca5a5]">
                Resign
              </button>
            )}
            <button onClick={() => void freeAction('leave')} disabled={freeBusy} className="text-muted underline">
              Leave
            </button>
          </span>
        ) : view.you && !finished ? (
          <button onClick={() => void resign()} className="text-[#fca5a5]">
            Resign
          </button>
        ) : finished && resultHidden ? (
          <button onClick={() => setResultHidden(false)} className="text-accent">
            Show result
          </button>
        ) : (
          <span />
        )}
      </div>

      {!finished && view.rematch && (
        <RematchPanel
          view={view}
          remainingMs={rematchLeft ?? 0}
          busy={freeBusy}
          onRematch={() => void freeAction('rematch')}
          onLeave={() => void freeAction('leave')}
        />
      )}

      {finished && !resultHidden && (
        <MatchResultOverlay
          view={view}
          onBracket={toBracket}
          onNext={view.nextMatchId ? () => router.push(`/r/${code}/m/${view.nextMatchId}`) : null}
          onClose={() => setResultHidden(true)}
        />
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto max-w-md rounded-xl border border-line bg-panel p-3 text-center text-sm shadow-lg">
          {toast}
        </div>
      )}
    </main>
  )
}
