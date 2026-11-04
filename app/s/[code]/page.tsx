'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ApiError, apiGet, apiPost } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { DifficultyPicker, formatClock, LABEL, SudokuGrid, useTick } from '@/src/client/sudoku-board'
import { PlayArea } from '@/src/client/sudoku-play'
import { shareInvite } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import { sudokuChannel } from '@/src/realtime/channels'
import type { Difficulty } from '@/src/sudoku/types'
import type { PlayerState, SudokuPlayerView, SudokuView } from '@/src/sudoku/views'

const BTN = 'block w-full rounded-xl p-[13px] text-center font-display text-sm tracking-wider uppercase disabled:opacity-50'
const PRIMARY = `${BTN} arcade-glow bg-accent text-white`
const GHOST = `${BTN} border border-line bg-panel2 text-text`
const CARD = 'rounded-[20px] border border-line bg-panel p-4'
const AVATAR_COLORS = ['#6c79ff', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4']
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

const STATE_LABEL: Record<PlayerState, string> = {
  lobby: '',
  racing: 'Solving',
  solved: 'Solved',
  timeout: "Time's up",
  gave_up: 'Gave up',
  stopped: 'Stopped',
}

export default function SudokuRoomPage() {
  return (
    <Suspense fallback={<main className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</main>}>
      <Room />
    </Suspense>
  )
}

function Room() {
  const { code } = useParams<{ code: string }>()
  const search = useSearchParams()
  const router = useRouter()
  const wantsJoin = search.get('join') === '1'
  const { data: polled, error, refresh } = usePoll<SudokuView>(`/api/sudoku/${code}`, 2_000, {
    channel: sudokuChannel(code),
    liveIntervalMs: 5_000,
  })
  const [override, setOverride] = useState<SudokuView | null>(null)
  const [blockedBy, setBlockedBy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const joinTried = useRef(false)
  const seqRef = useRef(0)
  const [skew, setSkew] = useState(0)

  // Prefer whichever is fresher: the last poll or the last action response.
  const view = override && (!polled || override.serverNow > polled.serverNow) ? override : polled
  const serverNow = view?.serverNow ?? 0
  useEffect(() => {
    if (serverNow) void Promise.resolve().then(() => setSkew(serverNow - Date.now()))
  }, [serverNow])

  // ?join=1 (ref link): warn up front if you're active elsewhere, then join once while in the lobby.
  useEffect(() => {
    if (!wantsJoin) return
    let live = true
    apiGet<{ active: { code: string } | null }>('/api/me')
      .then((me) => {
        const other = me.active?.code
        if (live && other && other.toUpperCase() !== code.toUpperCase()) setBlockedBy(other)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wantsJoin, code])

  useEffect(() => {
    if (!wantsJoin || joinTried.current || !polled || polled.status !== 'lobby') return
    joinTried.current = true
    apiPost<SudokuView>(`/api/sudoku/${code}/join`)
      .then((r) => {
        setOverride(r)
        router.replace(`/s/${code}`)
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'already_active') setBlockedBy(String(e.extra.activeCode ?? ''))
        else if (e instanceof ApiError && e.code === 'full') setToast('This room is full.')
        else setToast('Could not join this room.')
      })
  }, [wantsJoin, polled, code, router])

  const act = useCallback(
    async (action: 'start' | 'cancel' | 'leave' | 'give-up' | 'difficulty', body?: unknown) => {
      if (busy) return
      setBusy(true)
      try {
        const r = await apiPost<SudokuView>(`/api/sudoku/${code}/${action}`, body)
        if (action === 'cancel' || action === 'leave') {
          router.push('/sudoku')
          return
        }
        setOverride(r)
      } catch (e) {
        const c = e instanceof ApiError ? e.code : 'unknown'
        setToast(
          c === 'too_few_players'
            ? 'Need at least 2 players to start.'
            : c === 'not_lobby'
              ? 'The game has already started.'
              : 'Something went wrong. Try again.',
        )
        refresh()
      }
      setBusy(false)
    },
    [busy, code, refresh, router],
  )

  const enter = useCallback(
    async (cell: number, digit: number): Promise<boolean | null> => {
      const seq = Math.max(seqRef.current, view?.you?.lastEntry?.seq ?? 0) + 1
      seqRef.current = seq
      setBusy(true)
      try {
        const r = await apiPost<SudokuView>(`/api/sudoku/${code}/enter`, { cell, digit, seq })
        setOverride(r)
        const e = r.you?.lastEntry
        return e && e.seq === seq ? e.correct : null
      } catch (e) {
        if (e instanceof ApiError && e.code === 'not_playing') refresh()
        else if (!(e instanceof ApiError && e.code === 'occupied')) setToast('Could not send that number. Try again.')
        return null
      } finally {
        setBusy(false)
      }
    },
    [code, view?.you?.lastEntry?.seq, refresh],
  )

  const racing = view?.status === 'playing' && view.you?.state === 'racing'
  const now = useTick(racing) + skew
  const remaining = view?.you?.deadlineAt ? view.you.deadlineAt - now : 0
  // Your clock just hit zero: ask the server to settle it.
  const expired = racing && remaining <= 0
  useEffect(() => {
    if (expired) refresh()
  }, [expired, refresh])

  if (!view) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 p-4 text-sm text-muted">
        {error?.status === 404 ? (
          <>
            <div>Room not found. It may have expired.</div>
            <button onClick={() => router.push('/sudoku')} className={`${GHOST} max-w-60`}>
              Back to Sudoku
            </button>
          </>
        ) : error ? (
          'Could not load the room. Retrying…'
        ) : (
          'Loading…'
        )}
      </main>
    )
  }

  const others = view.players.filter((p) => p.userId !== view.youId)

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2.5 text-sm">
        <button
          onClick={() => router.push('/sudoku')}
          aria-label="Back to Sudoku"
          className="grid size-9 flex-none place-items-center rounded-xl border border-line bg-panel font-display text-base text-white"
        >
          ←
        </button>
        <span className="truncate font-display text-base text-white">{view.name}</span>
        <span className="lime-pill ml-auto">{LABEL[view.difficulty]}</span>
      </div>

      {blockedBy !== null && (
        <div className="rounded-[10px] border border-[#78591a] bg-[#3a2a0b] px-2.5 py-2 text-xs text-amber-200">
          You&apos;re already playing in {blockedBy} →{' '}
          <button onClick={() => router.push(blockedBy ? roomPath(blockedBy) : '/')} className="font-semibold underline">
            Go back
          </button>
        </div>
      )}

      {view.status === 'lobby' && <Lobby view={view} busy={busy} readOnly={blockedBy !== null} act={act} />}

      {view.status === 'playing' && racing && view.puzzle && view.you && (
        <PlayArea
          puzzle={view.puzzle}
          grid={view.you.grid}
          remainingMs={remaining}
          mistakes={view.you.mistakes}
          notesKey={`sudoku:notes:${view.code}`}
          onEnter={enter}
          onGiveUp={() => void act('give-up')}
          busy={busy}
        >
          <ProgressStrip players={others} toFill={view.toFill} compact />
        </PlayArea>
      )}

      {view.status === 'playing' && !racing && (
        <>
          <div className={`${CARD} text-center text-sm`}>
            {view.you ? (
              <>
                <div className="text-lg font-bold">{STATE_LABEL[view.you.state]}</div>
                <div className="mt-1 text-muted">Waiting for the others to finish…</div>
              </>
            ) : (
              <div className="text-muted">This race is in progress. You&apos;re watching.</div>
            )}
          </div>
          <ProgressStrip players={view.players} toFill={view.toFill} />
          {view.puzzle && view.you && <SudokuGrid puzzle={view.puzzle} grid={view.you.grid} selected={null} />}
        </>
      )}

      {view.status === 'finished' && <Result view={view} onBack={() => router.push('/sudoku')} />}

      {view.status === 'cancelled' && (
        <div className={`${CARD} text-center`}>
          <div className="mb-3 text-sm">This room was cancelled.</div>
          <button onClick={() => router.push('/sudoku')} className={GHOST}>
            Back to Sudoku
          </button>
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-panel p-3 text-sm shadow-lg">
          <span className="flex-1">{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="text-muted">
            ✕
          </button>
        </div>
      )}
    </main>
  )
}

function Avatar({ p, i }: { p: SudokuPlayerView; i: number }) {
  return p.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.avatarUrl} alt="" className="size-8 flex-none rounded-xl border border-lime/60 object-cover" />
  ) : (
    <div
      className="grid size-8 flex-none place-items-center rounded-xl font-display text-xs text-white"
      style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
    >
      {initial(p.name)}
    </div>
  )
}

function Lobby({
  view,
  busy,
  readOnly,
  act,
}: {
  view: SudokuView
  busy: boolean
  readOnly: boolean
  act: (a: 'start' | 'cancel' | 'leave' | 'difficulty', body?: unknown) => Promise<void>
}) {
  const canStart = view.players.length >= 2
  return (
    <>
      <div className="relative overflow-hidden rounded-[22px] border border-[#8b95ff]/25 bg-gradient-to-br from-[#272d52] via-[#1b2038] to-[#171b2d] p-4 shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-display text-xs tracking-wider text-muted uppercase">Room Code</div>
            <div className="font-display text-2xl tracking-[0.18em] text-white">{view.code}</div>
          </div>
          {view.inviteUrl && (
            <button
              onClick={() => shareInvite(view.inviteUrl, `Race me at Sudoku: ${view.name}`)}
              className="arcade-glow rounded-xl bg-accent px-3.5 py-2 font-display text-xs tracking-wider text-white uppercase"
            >
              ↗ SHARE LINK
            </button>
          )}
        </div>
      </div>

      <div className={CARD}>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-display text-base text-white">Difficulty</span>
          <span className="lime-pill">{LABEL[view.difficulty]}</span>
        </div>
        {view.youAreHost && !readOnly ? (
          <DifficultyPicker value={view.difficulty} disabled={busy} onChange={(d: Difficulty) => void act('difficulty', { difficulty: d })} />
        ) : (
          <div className="font-display text-sm text-white">{LABEL[view.difficulty]}</div>
        )}
        <div className="mt-2 text-xs text-muted">Everyone gets the same random puzzle · 30 minutes · −30 s per mistake</div>
      </div>

      <div className={CARD}>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-display text-base text-white">Players</span>
          <span className="lime-pill">{view.players.length} JOINED</span>
        </div>
        <div className="flex flex-col gap-2">
          {view.players.map((p, i) => (
            <div key={p.userId} className="flex items-center gap-2.5 text-sm">
              <Avatar p={p} i={i} />
              <span className="flex-1 truncate font-display text-white">{p.name}</span>
              {p.isHost && (
                <span className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-display text-[11px] tracking-wider text-amber-300 uppercase">
                  Host
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {!readOnly && view.youAreHost && (
        <>
          <button disabled={busy || !canStart} onClick={() => void act('start')} className={PRIMARY}>
            {canStart ? 'Start race' : 'Waiting for at least 2 players…'}
          </button>
          <button disabled={busy} onClick={() => void act('cancel')} className={GHOST}>
            Cancel room
          </button>
        </>
      )}
      {!readOnly && view.youAreIn && !view.youAreHost && (
        <>
          <div className="py-1 text-center text-sm text-muted">Waiting for host to start…</div>
          <button disabled={busy} onClick={() => void act('leave')} className={GHOST}>
            Leave
          </button>
        </>
      )}
    </>
  )
}

function ProgressStrip({ players, toFill, compact }: { players: SudokuPlayerView[]; toFill: number; compact?: boolean }) {
  if (players.length === 0) return null
  return (
    <div className={`flex flex-col ${compact ? 'gap-1' : 'gap-2 rounded-2xl border border-line bg-panel p-3'}`}>
      {players.map((p, i) => (
        <div key={p.userId} className="flex items-center gap-2 text-[13px]">
          {!compact && <Avatar p={p} i={i} />}
          <span className={`${compact ? 'w-20' : 'w-24'} truncate`}>{p.name}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2">
            <div
              className={`h-full rounded-full ${p.state === 'racing' ? 'bg-accent' : p.state === 'solved' ? 'bg-win' : 'bg-slate-500'}`}
              style={{ width: `${toFill ? Math.round((p.cells / toFill) * 100) : 0}%` }}
            />
          </div>
          <span className="w-14 text-right tabular-nums text-muted">
            {p.cells}/{toFill}
          </span>
          {p.mistakes > 0 && <span className="text-o">✕{p.mistakes}</span>}
          {p.state !== 'racing' && <span className="text-[11px] text-muted">{STATE_LABEL[p.state]}</span>}
        </div>
      ))}
    </div>
  )
}

function Result({ view, onBack }: { view: SudokuView; onBack: () => void }) {
  const winner = view.players.find((p) => p.userId === view.winnerId)
  const youWon = view.youAreIn && view.winnerId === view.youId
  return (
    <>
      <div className={`${CARD} text-center`}>
        <div className="text-4xl">{youWon ? '🏆' : '🏁'}</div>
        <div className="mt-1 text-lg font-bold">{youWon ? 'You win!' : `Winner: ${winner?.name ?? '?'}`}</div>
        <div className="mt-1 text-[13px] text-muted">
          {winner?.state === 'solved' ? 'Solved the puzzle first' : 'Most correct cells when time ran out'}
        </div>
        <div className="mt-2 text-xs text-muted">This room closes in 10 minutes.</div>
        <button onClick={onBack} className={`${GHOST} mt-3`}>
          Back to Sudoku
        </button>
      </div>

      <div className={CARD}>
        <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-muted">Ranking</div>
        <div className="flex flex-col gap-1.5">
          {view.ranking?.map((r) => (
            <div
              key={r.userId}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${r.userId === view.youId ? 'bg-accent/15 ring-1 ring-accent' : ''}`}
            >
              <span className="w-6 font-bold">{r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : `${r.place}.`}</span>
              <span className="flex-1 truncate">{r.name}</span>
              <span className="tabular-nums text-muted">
                {r.finishedAt !== null && view.startedAt !== null
                  ? formatClock(r.finishedAt - view.startedAt)
                  : `${r.cells}/${view.toFill}`}
              </span>
              <span className={`w-8 text-right ${r.mistakes ? 'text-o' : 'text-muted'}`}>✕{r.mistakes}</span>
            </div>
          ))}
        </div>
      </div>

      {view.puzzle && (
        <>
          <div className="text-center text-[11px] uppercase tracking-[0.08em] text-muted">
            {view.you ? 'Your grid (grey = cells you missed)' : 'Solution'}
          </div>
          <SudokuGrid puzzle={view.puzzle} grid={view.you?.grid ?? view.puzzle} selected={null} reveal={view.solution} />
        </>
      )}
    </>
  )
}
