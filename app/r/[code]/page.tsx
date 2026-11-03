'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ApiError, apiPost } from '@/src/client/api'
import { shareInvite } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import type { BracketMatchView, Entrant, RoomView } from '@/src/tournament/views'

const AVATAR_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2']
const BTN = 'block w-full rounded-xl p-[13px] text-center text-[15px] font-semibold disabled:opacity-50'
const PRIMARY = `${BTN} bg-accent text-white`
const GHOST = `${BTN} border border-line bg-panel2 text-text`
const CARD = 'rounded-2xl border border-line bg-panel p-4'

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

export default function RoomPage() {
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
  const { data: room, error, refresh } = usePoll<RoomView>(`/api/rooms/${code}`, 3_000)
  const [override, setOverride] = useState<RoomView | null>(null)
  const [blockedBy, setBlockedBy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const joinTried = useRef(false)

  // Prefer whichever is fresher: the last poll or the last action response.
  const view = override && (!room || override.serverNow > room.serverNow) ? override : room

  // ?join=1 (ref link): join once while the room is still in the lobby. Joining is idempotent server-side,
  // so a member re-opening the link is harmless.
  useEffect(() => {
    if (!wantsJoin || joinTried.current || !room || room.status !== 'lobby') return
    joinTried.current = true
    apiPost<RoomView>(`/api/rooms/${code}/join`)
      .then((r) => {
        setOverride(r)
        router.replace(`/r/${code}`)
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'already_active') setBlockedBy(String(e.extra.activeCode ?? ''))
        else if (e instanceof ApiError && e.code === 'full') setToast('This room is full.')
        else setToast('Could not join this room.')
      })
  }, [wantsJoin, room, code, router])

  // Auto-enter your match the first time it appears.
  const yourMatchId = view?.yourMatch?.id ?? null
  useEffect(() => {
    if (!yourMatchId) return
    const k = `auto:${yourMatchId}`
    try {
      if (sessionStorage.getItem(k)) return
      sessionStorage.setItem(k, '1')
    } catch {
      return
    }
    router.push(`/r/${code}/m/${yourMatchId}`)
  }, [yourMatchId, code, router])

  const act = useCallback(
    async (action: 'start' | 'cancel' | 'leave') => {
      if (busy) return
      setBusy(true)
      try {
        const r = await apiPost<RoomView>(`/api/rooms/${code}/${action}`)
        if (action === 'start') {
          setOverride(r)
          setBusy(false)
        } else {
          router.push('/')
        }
      } catch (e) {
        const c = e instanceof ApiError ? e.code : 'unknown'
        setToast(
          c === 'too_few_players'
            ? 'Need at least 2 players to start.'
            : c === 'not_lobby'
              ? 'The tournament has already started.'
              : 'Something went wrong. Try again.',
        )
        setBusy(false)
        refresh()
      }
    },
    [busy, code, refresh, router],
  )

  if (!view) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 p-4 text-sm text-muted">
        {error?.status === 404 ? (
          <>
            <div>Room not found. It may have expired.</div>
            <button onClick={() => router.push('/')} className={`${GHOST} max-w-60`}>
              Back to rooms
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

  const enter = (id: string) => router.push(`/r/${code}/m/${id}`)

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <div className="flex items-center gap-2 text-sm text-slate-300">
        <button onClick={() => router.push('/')} aria-label="Back to rooms" className="-ml-1 px-1 text-lg leading-none">
          ←
        </button>
        <span className="truncate font-semibold">{view.name}</span>
      </div>

      {blockedBy !== null && (
        <div className="rounded-[10px] border border-[#78591a] bg-[#3a2a0b] px-2.5 py-2 text-xs text-amber-200">
          You&apos;re already playing in {blockedBy} →{' '}
          <button onClick={() => router.push(blockedBy ? `/r/${blockedBy}` : '/')} className="font-semibold underline">
            Go back
          </button>
        </div>
      )}

      {view.status === 'lobby' && <Lobby view={view} busy={busy} readOnly={blockedBy !== null} act={act} />}
      {view.status === 'running' && <Bracket view={view} onEnter={enter} />}
      {view.status === 'finished' && (
        <>
          <div className={`${CARD} text-center`}>
            <div className="text-[13px] text-muted">Tournament over</div>
            <div className="my-1.5 text-4xl">🏆</div>
            <div className="font-bold">Champion: {view.placements.first ?? '?'}</div>
            {(view.placements.second || view.placements.third) && (
              <div className="mt-1.5 text-[13px] text-muted">
                {[view.placements.second && `🥈 ${view.placements.second}`, view.placements.third && `🥉 ${view.placements.third}`]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
            <div className="mt-2.5 text-xs text-muted">This room closes in 10 minutes.</div>
            <button onClick={() => router.push('/')} className={`${GHOST} mt-3`}>
              Back to rooms
            </button>
          </div>
          <Bracket view={view} onEnter={enter} />
        </>
      )}
      {view.status === 'cancelled' && (
        <div className={`${CARD} text-center`}>
          <div className="mb-3 text-sm">This tournament was cancelled.</div>
          <button onClick={() => router.push('/')} className={GHOST}>
            Back to rooms
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

function Lobby({
  view,
  busy,
  readOnly,
  act,
}: {
  view: RoomView
  busy: boolean
  readOnly: boolean
  act: (a: 'start' | 'cancel' | 'leave') => void
}) {
  const humans = view.players.filter((p) => !p.isBot).length
  return (
    <>
      <div className={`${CARD} text-center`}>
        <div className="text-[13px] text-muted">Room</div>
        <div className="text-[30px] font-extrabold tracking-[0.25em] text-white">{view.code}</div>
        {view.inviteUrl && (
          <button
            onClick={() => shareInvite(view.inviteUrl, `Join my Caro Cup tournament "${view.name}"!`)}
            className={`${GHOST} mt-2.5`}
          >
            ↗ Share invite link
          </button>
        )}
      </div>

      <div className={`${CARD} flex-1`}>
        <div className="mb-1.5 flex justify-between">
          <b>Players</b>
          <span className="text-[13px] text-muted">{view.players.length} joined</span>
        </div>
        {view.players.map((p, i) => (
          <div key={`${p.name}-${i}`} className="flex items-center gap-2.5 border-b border-[#2a3850] py-[9px] last:border-b-0">
            <div
              className="grid size-[30px] flex-none place-items-center rounded-full text-[13px] font-bold text-white"
              style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
            >
              {initial(p.name)}
            </div>
            <div className="min-w-0 flex-1 truncate text-sm">{p.name}</div>
            {p.isHost && (
              <span className="rounded-full border border-[#78591a] bg-panel2 px-2 py-0.5 text-[11px] text-amber-400">
                Host
              </span>
            )}
          </div>
        ))}
        <div className="mt-2.5 text-[13px] text-muted">
          On start: {humans} players → {view.slotsIfStartedNow}-slot bracket,{' '}
          <b className="text-[#a78bfa]">{view.botsIfStartedNow} bots</b> added.
        </div>
      </div>

      {readOnly ? null : view.isHost ? (
        <>
          <button disabled={busy || humans < 2} onClick={() => act('start')} className={PRIMARY}>
            ▶ Start tournament
          </button>
          <button disabled={busy} onClick={() => act('cancel')} className={GHOST}>
            Cancel tournament
          </button>
        </>
      ) : (
        <>
          <div className="text-center text-[13px] text-muted">Waiting for host to start…</div>
          <button disabled={busy} onClick={() => act('leave')} className={GHOST}>
            Leave
          </button>
        </>
      )}
    </>
  )
}

function Slot({ e, score, other }: { e: Entrant | null; score: 1 | 0 | null; other: 1 | 0 | null }) {
  const decided = score !== null && other !== null
  const won = decided && score === 1
  const lost = decided && score === 0
  return (
    <div className={`flex justify-between gap-1 px-2 py-1.5 ${lost || !e ? 'text-[#7d8ba3]' : ''}`}>
      <span className={`truncate ${won ? 'font-bold text-white' : ''}`}>
        {e ? (
          <>
            {e.seed !== null && <span className="mr-1 text-slate-500">#{e.seed}</span>}
            {e.isBot ? '🤖 ' : ''}
            {e.name}
          </>
        ) : (
          'TBD'
        )}
      </span>
      <span className={won ? 'text-win' : ''}>{score ?? '-'}</span>
    </div>
  )
}

function MatchCard({ m }: { m: BracketMatchView }) {
  const live = m.status === 'playing'
  return (
    <div
      className={`w-[132px] rounded-md border bg-[#1a2537] text-xs ${
        m.isYours ? 'border-accent shadow-[0_0_0_1px_var(--accent)]' : 'border-line'
      }`}
    >
      <Slot e={m.a} score={m.scoreA} other={m.scoreB} />
      <div className="border-t border-[#2a3850]">
        <Slot e={m.b} score={m.scoreB} other={m.scoreA} />
      </div>
      {live && (
        <div className="border-t border-dashed border-[#2a3850] px-2 py-[3px] text-[10px] text-amber-400">
          ● Live{m.isYours ? ` · #${m.id}` : ''}
        </div>
      )}
    </div>
  )
}

function Bracket({ view, onEnter }: { view: RoomView; onEnter: (id: string) => void }) {
  const ym = view.yourMatch
  const oppIsBot = ym ? view.players.some((p) => p.isBot && p.name === ym.opponentName) : false
  return (
    <>
      <div className="text-[19px] font-bold">Bracket</div>
      <div className="-mx-4 overflow-x-auto px-4 pb-1.5">
        <div className="flex w-max items-center gap-[18px]">
          {view.rounds.map((r) => (
            <div key={r.name} className="flex flex-col gap-3.5">
              <h4 className="mb-1 rounded-md bg-panel2 p-[7px] text-center text-xs font-semibold">{r.name}</h4>
              {r.matches.map((m) => (
                <MatchCard key={m.id} m={m} />
              ))}
            </div>
          ))}
        </div>
      </div>
      {view.rounds.length > 2 && <div className="text-[13px] text-muted">← swipe for later rounds</div>}
      {ym && (
        <div className={`${CARD} border-accent`}>
          <div className="mb-1 font-semibold">Your match is ready</div>
          <div className="mb-2.5 text-[13px] text-muted">
            You ({ym.youAre === 'X' ? '✕' : '○'}) vs {oppIsBot ? '🤖 ' : ''}
            {ym.opponentName} · match #{ym.id}
          </div>
          <button onClick={() => onEnter(ym.id)} className={PRIMARY}>
            Enter match →
          </button>
        </div>
      )}
    </>
  )
}
