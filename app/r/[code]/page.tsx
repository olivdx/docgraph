'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { BackButton } from '@/src/client/back-button'
import { ApiError, apiGet, apiPost } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { shareInvite } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import { caroRoomChannel } from '@/src/realtime/channels'
import type { BestOf } from '@/src/tournament/types'
import type { BracketMatchView, Entrant, RoomView } from '@/src/tournament/views'

const AVATAR_COLORS = ['#6c79ff', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4']
const BTN = 'block w-full rounded-xl p-[13px] text-center font-display text-sm tracking-wider uppercase disabled:opacity-50'
const PRIMARY = `${BTN} arcade-glow bg-accent text-white`
const GHOST = `${BTN} border border-line bg-panel2 text-text`
const CARD = 'rounded-[20px] border border-line bg-panel p-4'

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

function PlayerAvatar({ name, avatarUrl, i }: { name: string; avatarUrl: string | null; i: number }) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={avatarUrl} alt="" className="size-8 flex-none rounded-xl border border-lime/60 object-cover" />
    )
  }
  return (
    <div
      className="grid size-8 flex-none place-items-center rounded-xl font-display text-[13px] text-white"
      style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
    >
      {initial(name)}
    </div>
  )
}

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
  const { data: room, error, refresh } = usePoll<RoomView>(`/api/rooms/${code}`, 3_000, {
    channel: caroRoomChannel(code),
    liveIntervalMs: 15_000,
  })
  const [override, setOverride] = useState<RoomView | null>(null)
  const [blockedBy, setBlockedBy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const joinTried = useRef(false)
  const formatSeq = useRef(0)

  // Prefer whichever is fresher: the last poll or the last action response.
  const view = override && (!room || override.serverNow > room.serverNow) ? override : room

  // ?join=1 (ref link): if you're already active in a different room (lobby or running), say so up
  // front, whatever this room's status is; the join below would be refused anyway.
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
          router.push('/caro')
        }
      } catch (e) {
        const c = e instanceof ApiError ? e.code : 'unknown'
        setToast(
          c === 'too_few_players'
            ? 'Need at least 1 player to start.'
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

  const setFormat = useCallback(
    async (bestOf: BestOf) => {
      if (view?.bestOf === bestOf) return
      const base = view
      if (!base) return
      const my = ++formatSeq.current
      const revert = base
      setOverride({ ...base, bestOf, serverNow: Math.max(base.serverNow, Date.now()) + 1 })
      try {
        const r = await apiPost<RoomView>(`/api/rooms/${code}/format`, { bestOf })
        if (my !== formatSeq.current) return
        setOverride(r)
      } catch {
        if (my !== formatSeq.current) return
        setToast('Could not change the format. Try again.')
        setOverride({ ...revert, serverNow: Math.max(revert.serverNow, Date.now()) + 1 })
        refresh()
      }
    },
    [view, code, refresh],
  )

  if (!view) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 p-4 text-sm text-muted">
        {error?.status === 404 ? (
          <>
            <div>Room not found. It may have expired.</div>
            <button onClick={() => router.push('/caro')} className={`${GHOST} max-w-60`}>
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
  const lobbyHumans = view.status === 'lobby' ? view.players.filter((p) => !p.isBot).length : 0
  const lobbyActions = view.status === 'lobby' && blockedBy === null

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <div className="sticky top-0 z-20 -mx-4 flex items-center gap-2.5 border-b border-line/40 bg-bg/95 px-4 py-2.5 text-sm backdrop-blur-md">
        <BackButton onClick={() => router.push('/caro')} label="Back to rooms" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-base text-white">{view.name}</div>
          <div className="text-[11px] text-muted">Room #{view.code}</div>
        </div>
        {lobbyActions && view.isHost ? (
          <div className="flex flex-none items-center gap-1.5">
            <button
              type="button"
              disabled={busy || lobbyHumans < 1}
              onClick={() => act('start')}
              className="rounded-[10px] bg-accent px-2.5 py-2 font-display text-[11px] tracking-wider text-white uppercase disabled:opacity-50"
              title={lobbyHumans < 1 ? 'Need at least 1 player' : lobbyHumans === 1 ? 'Start vs bot' : undefined}
            >
              START
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => act('cancel')}
              className="rounded-[10px] border border-line bg-panel2 px-2.5 py-2 font-display text-[11px] tracking-wider text-muted uppercase disabled:opacity-50"
            >
              CLOSE
            </button>
          </div>
        ) : lobbyActions && !view.isHost ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => act('leave')}
            className="flex-none rounded-[10px] border border-line bg-panel2 px-2.5 py-2 font-display text-[11px] tracking-wider text-white uppercase disabled:opacity-50"
          >
            LEAVE
          </button>
        ) : view.status !== 'lobby' ? (
          <span className="lime-pill">{view.status.toUpperCase()}</span>
        ) : null}
      </div>

      {blockedBy !== null && (
        <div className="rounded-[10px] border border-[#78591a] bg-[#3a2a0b] px-2.5 py-2 text-xs text-amber-200">
          You&apos;re already playing in {blockedBy} →{' '}
          <button onClick={() => router.push(blockedBy ? roomPath(blockedBy) : '/')} className="font-semibold underline">
            Go back
          </button>
        </div>
      )}

      {view.status === 'lobby' && <Lobby view={view} readOnly={blockedBy !== null} onFormat={setFormat} />}
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
            <button onClick={() => router.push('/caro')} className={`${GHOST} mt-3`}>
              Back to rooms
            </button>
          </div>
          <Bracket view={view} onEnter={enter} />
        </>
      )}
      {view.status === 'cancelled' && (
        <div className={`${CARD} text-center`}>
          <div className="mb-3 text-sm">This tournament was cancelled.</div>
          <button onClick={() => router.push('/caro')} className={GHOST}>
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
  readOnly,
  onFormat,
}: {
  view: RoomView
  readOnly: boolean
  onFormat: (bestOf: BestOf) => void
}) {
  const humans = view.players.filter((p) => !p.isBot).length
  return (
    <>
      <div className="relative overflow-hidden rounded-[22px] border border-[#8b95ff]/25 bg-gradient-to-br from-[#272d52] via-[#1b2038] to-[#171b2d] p-4 text-center shadow-lg">
        <div className="font-display text-xs tracking-wider text-muted uppercase">Room Code</div>
        <div className="my-1 font-display text-[32px] tracking-[0.22em] text-white">{view.code}</div>
        {view.inviteUrl && (
          <button
            onClick={() => shareInvite(view.inviteUrl, `Join my Caro Cup tournament "${view.name}"!`)}
            className="arcade-glow mt-2 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 font-display text-xs tracking-wider text-white uppercase"
          >
            ↗ SHARE INVITE LINK
          </button>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-display text-base text-white">Match Format</span>
          <span className="lime-pill">{view.isHost && !readOnly ? 'HOST CONTROLS' : `BO${view.bestOf}`}</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Match format">
          {(
            [
              [1, 'BEST OF 1', 'One game blitz', '⚡'],
              [3, 'BEST OF 3', 'First to 2 wins', '👑'],
            ] as const
          ).map(([n, title, desc, icon]) => {
            const active = view.bestOf === n
            const canPick = view.isHost && !readOnly
            return (
              <div
                key={n}
                onClick={() => canPick && onFormat(n)}
                className={`flex flex-col items-center gap-1.5 rounded-[18px] border bg-gradient-to-b from-panel2 to-panel p-3.5 text-center transition ${
                  active ? 'border-accent shadow-[inset_0_0_24px_rgba(108,121,255,0.16)]' : 'border-line'
                } ${canPick ? 'cursor-pointer' : ''}`}
              >
                <div className="font-display text-sm leading-tight text-white uppercase">{title}</div>
                <div className="text-[11px] text-muted">{desc}</div>
                <div className="my-0.5 text-3xl drop-shadow">{icon}</div>
                <button
                  type="button"
                  disabled={!canPick}
                  aria-pressed={active}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (canPick) onFormat(n)
                  }}
                  className={`w-full rounded-[10px] py-2 font-display text-xs tracking-wider uppercase transition ${
                    active ? 'arcade-glow bg-accent text-white' : 'border border-line bg-bg text-muted'
                  }`}
                >
                  {active ? `ACTIVE · BO${n}` : `SELECT BO${n}`}
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div className={`${CARD} flex-1`}>
        <div className="mb-2 flex items-center justify-between">
          <b className="font-display text-base text-white">Players</b>
          <span className="lime-pill">{view.players.length} JOINED</span>
        </div>
        {view.players.map((p, i) => (
          <div key={`${p.name}-${i}`} className="flex items-center gap-2.5 border-b border-line/60 py-2.5 last:border-b-0">
            <PlayerAvatar name={p.name} avatarUrl={p.avatarUrl} i={i} />
            <div className="min-w-0 flex-1 truncate font-display text-sm text-white">{p.name}</div>
            {p.isHost && (
              <span className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-display text-[11px] tracking-wider text-amber-300 uppercase">
                Host
              </span>
            )}
          </div>
        ))}
        <div className="mt-2.5 text-xs text-muted">
          {humans === 1 ? (
            <>
              Solo start: you vs <b className="font-display text-[#a78bfa]">1 bot</b> — jumps straight into the Final.
            </>
          ) : (
            <>
              On start: {humans} players → {view.slotsIfStartedNow}-slot bracket,{' '}
              <b className="font-display text-[#a78bfa]">{view.botsIfStartedNow} bots</b> added.
            </>
          )}
        </div>
      </div>

      {readOnly ? null : !view.isHost ? (
        <div className="text-center text-[13px] text-muted">Waiting for host to start…</div>
      ) : null}
    </>
  )
}

function Slot({ e, score, won, lost }: { e: Entrant | null; score: number | null; won: boolean; lost: boolean }) {
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

function MatchCard({ m, onOpen }: { m: BracketMatchView; onOpen: (id: string) => void }) {
  const live = m.status === 'playing'
  // Live and finished matches open the board: your own to play, anyone else's to watch.
  const openable = live || m.status === 'finished'
  return (
    <button
      type="button"
      disabled={!openable}
      onClick={() => onOpen(m.id)}
      aria-label={openable ? `${m.isYours ? 'Open' : 'Watch'} match #${m.id}` : undefined}
      className={`block w-[138px] rounded-xl border bg-panel text-left font-sans text-xs enabled:active:scale-[0.98] ${
        m.isYours ? 'border-accent shadow-[0_0_0_1px_var(--accent)]' : 'border-line'
      }`}
    >
      <Slot e={m.a} score={m.scoreA} won={m.winner === 'a'} lost={m.winner === 'b'} />
      <div className="border-t border-line">
        <Slot e={m.b} score={m.scoreB} won={m.winner === 'b'} lost={m.winner === 'a'} />
      </div>
      {live && (
        <div className="flex border-t border-dashed border-line px-2 py-1 font-display text-[10px] text-lime">
          <span className="flex-1">● LIVE{m.isYours ? ` · #${m.id}` : ''}</span>
          {!m.isYours && <span className="text-accent">WATCH</span>}
        </div>
      )}
    </button>
  )
}

function Bracket({ view, onEnter }: { view: RoomView; onEnter: (id: string) => void }) {
  const ym = view.yourMatch
  const oppIsBot = ym ? view.players.some((p) => p.isBot && p.name === ym.opponentName) : false
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="font-display text-lg text-white">Tournament Bracket</div>
        <span className="lime-pill">{view.bestOf === 3 ? 'BEST OF 3' : 'BEST OF 1'}</span>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 pb-1.5">
        <div className="flex w-max items-center gap-[18px]">
          {view.rounds.map((r) => (
            <div key={r.name} className="flex flex-col gap-3.5">
              <h4 className="mb-1 rounded-lg bg-panel2 p-2 text-center font-display text-xs tracking-wider text-white uppercase">
                {r.name}
              </h4>
              {r.matches.map((m) => (
                <MatchCard key={m.id} m={m} onOpen={onEnter} />
              ))}
            </div>
          ))}
        </div>
      </div>
      {view.rounds.length > 2 && <div className="text-xs text-muted">← swipe for later rounds</div>}
      {ym && (
        <div className={`${CARD} border-accent bg-[linear-gradient(90deg,rgba(108,121,255,0.14),var(--panel))]`}>
          <div className="mb-1 font-display text-base text-white">Your match is ready</div>
          <div className="mb-2.5 text-[13px] text-muted">
            You ({ym.youAre === 'X' ? '✕' : '○'}) vs {oppIsBot ? '🤖 ' : ''}
            {ym.opponentName} · match #{ym.id}
          </div>
          <button onClick={() => onEnter(ym.id)} className={PRIMARY}>
            ENTER MATCH →
          </button>
        </div>
      )}
    </>
  )
}
