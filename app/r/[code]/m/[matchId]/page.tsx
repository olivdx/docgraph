'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ApiError, apiGet, apiPost } from '@/src/client/api'
import { Board } from '@/src/client/board'
import { Mark } from '@/src/client/marks'
import type { Cell, Side } from '@/src/game/types'
import type { MatchView } from '@/src/tournament/views'

const POLL_MS = 1_000
const TICK_MS = 250
const TURN_MS = 25_000 // mirrors the server's TURN_MS; display only (idle side's clock)

type EndReason = NonNullable<MatchView['endReason']>

const WIN_REASON: Record<EndReason, string> = {
  five_in_row: 'Open five',
  turn_timeout: 'Opponent timed out',
  disconnect_timeout: 'Opponent disconnected',
  resign: 'Opponent resigned',
  no_show: "Opponent didn't show up",
  board_full: 'Board full',
}
const LOSE_REASON: Record<EndReason, string> = {
  five_in_row: 'Opponent made open five',
  turn_timeout: 'You timed out',
  disconnect_timeout: 'You disconnected',
  resign: 'You resigned',
  no_show: "You didn't show up",
  board_full: 'Board full',
}
const loserReason = (loser: string): Record<EndReason, string> => ({
  five_in_row: 'Open five',
  turn_timeout: `${loser} timed out`,
  disconnect_timeout: `${loser} disconnected`,
  resign: `${loser} resigned`,
  no_show: `${loser} didn't show up`,
  board_full: 'Board full',
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

const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
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
  const flying = useRef(false)
  const seq = useRef(0)
  const applied = useRef(0)

  const apply = useCallback((my: number, view: MatchView) => {
    if (my < applied.current) return
    applied.current = my
    const at = Date.now()
    setState({ view, at })
    setNow(at)
    setLoadError(null)
  }, [])

  const poll = useCallback(async () => {
    const my = ++seq.current
    try {
      const v = await apiGet<MatchView>(path)
      if (flying.current) return // the move response will bring a fresher view
      apply(my, v)
    } catch (e) {
      if (my >= applied.current) setLoadError(e instanceof ApiError ? e : new ApiError(0, 'unknown'))
    }
  }, [path, apply])

  useEffect(() => {
    const first = setTimeout(() => void poll(), 0)
    const id = setInterval(() => {
      if (!document.hidden) void poll()
    }, POLL_MS)
    const onVis = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearTimeout(first)
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [poll])

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
    if (!state?.view.you || !window.confirm('Resign this match? Your opponent wins.')) return
    try {
      const v = await apiPost<MatchView>(`${path}/resign`)
      apply(++seq.current, v)
    } catch {
      setToast('Could not resign. Try again.')
    }
  }, [state, path, apply])

  const toBracket = () => router.push(`/r/${code}`)

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
  const sides: Side[] = view.you === 'O' ? ['O', 'X'] : ['X', 'O']
  const oppName = view.you ? (view.players[opposite(view.you)]?.name ?? 'opponent') : null
  const finished = view.status === 'finished'

  return (
    <main className="mx-auto flex h-dvh w-full max-w-md flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between text-sm text-slate-300">
        <button onClick={toBracket} className="-ml-1 truncate px-1 text-left">
          ← {view.roundName} · #{view.id}
        </button>
        <button onClick={toBracket} className="text-muted">
          Bracket
        </button>
      </div>

      <div className="flex items-center justify-between gap-2">
        {sides.map((s) => {
          const p = view.players[s]
          const isYou = view.you === s
          const active = view.status === 'playing' && view.turn === s
          const label = isYou ? 'You' : p ? `${p.isBot ? '🤖 ' : ''}${p.name}` : 'TBD'
          const status = active ? (isYou ? 'Your turn' : p?.isBot ? 'Thinking…' : 'Their turn') : 'Waiting'
          const time = active ? (turnLeft === null ? '…' : clock(turnLeft)) : clock(TURN_MS)
          return (
            <div
              key={s}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl border bg-panel px-2.5 py-2 ${
                active ? 'border-accent shadow-[0_0_0_1px_var(--accent)]' : 'border-line'
              }`}
            >
              <Mark side={s} size={20} />
              <div className="min-w-0 text-xs leading-[1.3]">
                <b className="block truncate">{label}</b>
                <span className="text-muted">{status}</span>
              </div>
              <span
                className={`ml-auto text-[15px] font-bold tabular-nums ${
                  active ? (turnLeft !== null && turnLeft <= 5_000 ? 'text-o' : '') : 'text-muted'
                }`}
              >
                {time}
              </span>
            </div>
          )
        })}
      </div>

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
        disabled={inFlight || view.status !== 'playing'}
        onPlay={(c) => void play(c)}
      />

      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span>Move {view.moves.length} · blocked-ends rule</span>
        <span>#{view.id}</span>
        {view.you && !finished ? (
          <button onClick={() => void resign()} className="text-[#fca5a5]">
            Resign
          </button>
        ) : (
          <span />
        )}
      </div>

      {finished && <Result view={view} onBracket={toBracket} />}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto max-w-md rounded-xl border border-line bg-panel p-3 text-center text-sm shadow-lg">
          {toast}
        </div>
      )}
    </main>
  )
}

function Result({ view, onBracket }: { view: MatchView; onBracket: () => void }) {
  const { you, winner, endReason } = view
  const winnerName = winner ? (view.players[winner]?.name ?? '?') : null
  const loserName = winner ? (view.players[opposite(winner)]?.name ?? '?') : '?'
  const won = you !== null && winner === you
  const lost = you !== null && winner !== null && winner !== you

  const title = you ? (won ? 'You win!' : lost ? 'You lose' : 'Match over') : winnerName ? `${winnerName} wins` : 'Match over'
  const reason = endReason
    ? you
      ? (won ? WIN_REASON : LOSE_REASON)[endReason]
      : loserReason(loserName)[endReason]
    : null

  let next: string | null = null
  if (you) {
    if (view.nextStep === 'champion') next = 'Champion!'
    else if (view.nextStep === 'eliminated') next = "You're out. Thanks for playing!"
    else if (view.nextStep === 'next_match') next = `Advancing to ${won ? nextRoundAfter(view.roundName) : '3rd Place'}`
    else if (view.nextStep === 'podium') next = won ? 'Third place! 🥉' : 'Runner-up! 🥈'
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-4 text-center shadow-xl">
        <div className="text-[40px]">{lost ? '😔' : view.nextStep === 'champion' ? '🏆' : '🎉'}</div>
        <div className="text-[22px] font-bold">{title}</div>
        <div className="mt-1.5 mb-3.5 text-[13px] text-muted">
          {[reason, next].filter(Boolean).join(' · ')}
        </div>
        <button onClick={onBracket} className="block w-full rounded-xl bg-accent p-[13px] text-[15px] font-semibold text-white">
          View bracket
        </button>
      </div>
    </div>
  )
}
