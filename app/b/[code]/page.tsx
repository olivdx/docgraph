'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { BackButton } from '@/src/client/back-button'
import { ApiError, apiGet, apiPost } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { shareInvite } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import { battleshipRoomChannel } from '@/src/realtime/channels'
import { BATTLE_CODE_LEN } from '@/src/battleship/constants'
import { RANKED_MIN_PLAYERS } from '@/src/battleship/rating'
import type { BattleBracketMatch, BattleRoomView } from '@/src/battleship/views'

const AVATAR_COLORS = ['#0ea5e9', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#6c79ff']
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

export default function BattleRoomPage() {
  return (
    <Suspense fallback={<main className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</main>}>
      <BattleRoom />
    </Suspense>
  )
}

function BattleRoom() {
  const { code } = useParams<{ code: string }>()
  const search = useSearchParams()
  const router = useRouter()
  const wantsJoin = search.get('join') === '1'
  const { data: room, error, refresh } = usePoll<BattleRoomView>(`/api/battleship/${code}`, 3_000, {
    channel: battleshipRoomChannel(code),
    liveIntervalMs: 15_000,
  })
  const [override, setOverride] = useState<BattleRoomView | null>(null)
  const [blockedBy, setBlockedBy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const joinTried = useRef(false)

  const view = override && (!room || override.serverNow > room.serverNow) ? override : room

  // ?join=1 (invite link): warn up front if you're active in a different room.
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

  // ?join=1: join once while the cup is still in the lobby (idempotent server-side).
  useEffect(() => {
    if (!wantsJoin || joinTried.current || !room || room.status !== 'lobby') return
    joinTried.current = true
    apiPost<BattleRoomView>(`/api/battleship/${code}/join`)
      .then((r) => {
        setOverride(r)
        router.replace(`/b/${code}`)
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'already_active') setBlockedBy(String(e.extra.activeCode ?? ''))
        else if (e instanceof ApiError && e.code === 'full') setToast('This cup is full.')
        else setToast('Could not join this cup.')
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
    router.push(`/b/${code}/m/${yourMatchId}`)
  }, [yourMatchId, code, router])

  /** Leaves the Battleship cup you're in elsewhere, then joins this one. */
  const leaveAndJoin = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await apiPost<BattleRoomView>(`/api/battleship/${code}/join`, { leaveCurrent: true })
      setBlockedBy(null)
      setOverride(r)
      router.replace(`/b/${code}`)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_lobby') setToast('This cup has already started.')
      else if (e instanceof ApiError && e.code === 'full') setToast('This cup is full.')
      else setToast('Could not join this cup.')
    }
    setBusy(false)
  }, [busy, code, router])

  const act = useCallback(
    async (action: 'start' | 'cancel' | 'leave') => {
      if (busy) return
      setBusy(true)
      try {
        const r = await apiPost<BattleRoomView>(`/api/battleship/${code}/${action}`)
        if (action === 'start') {
          setOverride(r)
          setBusy(false)
        } else {
          router.push('/battleship')
        }
      } catch (e) {
        const c = e instanceof ApiError ? e.code : 'unknown'
        setToast(
          c === 'too_few_players'
            ? 'Need at least 2 players to start.'
            : c === 'not_lobby'
              ? 'The cup has already started.'
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
            <div>Cup not found. It may have expired.</div>
            <button onClick={() => router.push('/battleship')} className={`${GHOST} max-w-60`}>
              Back to cups
            </button>
          </>
        ) : error ? (
          'Could not load the cup. Retrying…'
        ) : (
          'Loading…'
        )}
      </main>
    )
  }

  const enter = (id: string) => router.push(`/b/${code}/m/${id}`)
  const lobbyActions = view.status === 'lobby' && blockedBy === null
  const canStart = view.players.length >= view.minPlayers

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <div className="sticky top-0 z-20 -mx-4 flex items-center gap-2.5 border-b border-line/40 bg-bg/95 px-4 py-2.5 text-sm backdrop-blur-md">
        <BackButton onClick={() => router.push('/battleship')} label="Back to cups" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-base text-white">{view.name}</div>
          <div className="text-[11px] text-muted">Cup #{view.code}</div>
        </div>
        {lobbyActions && view.isHost ? (
          <div className="flex flex-none items-center gap-1.5">
            <button
              type="button"
              disabled={busy || !canStart}
              onClick={() => act('start')}
              className="rounded-[10px] bg-accent px-2.5 py-2 font-display text-[11px] tracking-wider text-white uppercase disabled:opacity-50"
              title={canStart ? undefined : 'Need at least 2 players'}
            >
              START
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => act('leave')}
              className="rounded-[10px] border border-line bg-panel2 px-2.5 py-2 font-display text-[11px] tracking-wider text-white uppercase disabled:opacity-50"
              title="Leave: another player becomes host"
            >
              LEAVE
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
        ) : view.status === 'running' && view.youAreIn ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmLeave(true)}
            className="flex-none rounded-[10px] border border-line bg-panel2 px-2.5 py-2 font-display text-[11px] tracking-wider text-white uppercase disabled:opacity-50"
          >
            LEAVE CUP
          </button>
        ) : view.status !== 'lobby' ? (
          <span className="lime-pill">{view.status.toUpperCase()}</span>
        ) : null}
      </div>

      {confirmLeave && (
        <div className="flex items-center gap-2 rounded-[14px] border border-o/50 bg-panel p-3 text-sm">
          <span className="flex-1">Leave this cup? You lose any match you&apos;re in and can&apos;t come back.</span>
          <button type="button" onClick={() => setConfirmLeave(false)} className="rounded-[10px] border border-line bg-panel2 px-3 py-2 text-xs font-bold">
            Stay
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmLeave(false)
              void act('leave')
            }}
            className="rounded-[10px] bg-rose-500/90 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            Leave
          </button>
        </div>
      )}

      {blockedBy !== null && (
        <div className="rounded-[10px] border border-[#78591a] bg-[#3a2a0b] px-2.5 py-2 text-xs text-amber-200">
          You&apos;re already playing in {blockedBy} →{' '}
          <button onClick={() => router.push(blockedBy ? roomPath(blockedBy) : '/')} className="font-semibold underline">
            Go back
          </button>
          {blockedBy.length === BATTLE_CODE_LEN && view.status === 'lobby' && (
            <>
              {' '}or{' '}
              <button type="button" disabled={busy} onClick={() => void leaveAndJoin()} className="font-semibold underline">
                leave it and join this cup
              </button>
            </>
          )}
        </div>
      )}

      {view.status === 'lobby' && <Lobby view={view} readOnly={blockedBy !== null} />}
      {view.status === 'running' && <Bracket view={view} onEnter={enter} />}
      {view.status === 'finished' && (
        <>
          <div className={`${CARD} text-center`}>
            <div className="text-[13px] text-muted">Cup over</div>
            <div className="my-1.5 text-4xl">🏴‍☠️</div>
            <div className="font-bold">Champion: {view.placements.first ?? '?'}</div>
            {(view.placements.second || view.placements.third) && (
              <div className="mt-1.5 text-[13px] text-muted">
                {[view.placements.second && `🥈 ${view.placements.second}`, view.placements.third && `🥉 ${view.placements.third}`]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
            <div className="mt-2.5 text-xs text-muted">This cup closes in 10 minutes.</div>
            <button onClick={() => router.push('/battleship')} className={`${GHOST} mt-3`}>
              Back to cups
            </button>
          </div>
          <Bracket view={view} onEnter={enter} />
        </>
      )}
      {view.status === 'cancelled' && (
        <div className={`${CARD} text-center`}>
          <div className="mb-3 text-sm">This cup was cancelled.</div>
          <button onClick={() => router.push('/battleship')} className={GHOST}>
            Back to cups
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

function Lobby({ view, readOnly }: { view: BattleRoomView; readOnly: boolean }) {
  const n = view.players.length
  let slots = 2
  while (slots < n) slots *= 2
  return (
    <>
      <div className="relative overflow-hidden rounded-[22px] border border-sky-400/25 bg-[radial-gradient(circle_at_30%_20%,#1d8fc0,#0b2a44_85%)] p-4 text-center shadow-lg">
        <div className="font-display text-xs tracking-wider text-sky-100/80 uppercase">Cup Code</div>
        <div className="my-1 font-display text-[32px] tracking-[0.22em] text-white">{view.code}</div>
        {view.inviteUrl && (
          <button
            onClick={() => shareInvite(view.inviteUrl, `Join my Battleship cup "${view.name}"!`)}
            className="arcade-glow mt-2 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 font-display text-xs tracking-wider text-white uppercase"
          >
            ↗ SHARE INVITE LINK
          </button>
        )}
      </div>

      <div className={`${CARD} flex-1`}>
        <div className="mb-2 flex items-center justify-between">
          <b className="font-display text-base text-white">Captains</b>
          <span className="lime-pill">{n} JOINED</span>
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
          {n < view.minPlayers
            ? 'Need at least 2 captains. Share the invite link!'
            : `On start: ${n} captains → ${slots}-slot bracket, best of 1${slots > n ? `, ${slots - n} bye${slots - n > 1 ? 's' : ''}` : ''}.`}
        </div>
        <div className={`mt-1.5 text-xs ${n >= RANKED_MIN_PLAYERS ? 'text-lime' : 'text-muted'}`}>
          {n >= RANKED_MIN_PLAYERS
            ? '🏆 Ranked cup: matches count for the ranking.'
            : `Unranked: ${RANKED_MIN_PLAYERS - n} more ${RANKED_MIN_PLAYERS - n === 1 ? 'captain' : 'captains'} to make it count for the ranking.`}
        </div>
      </div>

      {readOnly ? null : !view.isHost ? (
        <div className="text-center text-[13px] text-muted">Waiting for host to start…</div>
      ) : null}
    </>
  )
}

function Slot({ name, won, lost, bye }: { name: string | null; won: boolean; lost: boolean; bye: boolean }) {
  return (
    <div className={`flex justify-between gap-1 px-2 py-1.5 ${lost || !name ? 'text-[#7d8ba3]' : ''}`}>
      <span className={`truncate ${won ? 'font-bold text-white' : ''}`}>{name ?? (bye ? 'bye' : 'TBD')}</span>
      <span className={won ? 'text-win' : ''}>{won ? '✓' : ''}</span>
    </div>
  )
}

const LIVE_STATUSES = ['pending', 'placing', 'playing']

function MatchCard({ m, onOpen }: { m: BattleBracketMatch; onOpen: (id: string) => void }) {
  const live = LIVE_STATUSES.includes(m.status)
  const bye = m.endReason === 'bye'
  const openable = !bye && (live || m.status === 'finished')
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
      <Slot name={m.a?.name ?? null} won={m.winner === 'a'} lost={m.winner === 'b'} bye={false} />
      <div className="border-t border-line">
        <Slot name={m.b?.name ?? null} won={m.winner === 'b'} lost={m.winner === 'a'} bye={bye} />
      </div>
      {live && (
        <div className="flex border-t border-dashed border-line px-2 py-1 font-display text-[10px] text-lime">
          <span className="flex-1">● {m.status === 'placing' ? 'PLACING' : m.status === 'pending' ? 'READY' : 'LIVE'}</span>
          {!m.isYours && m.status !== 'pending' && <span className="text-accent">WATCH</span>}
        </div>
      )}
    </button>
  )
}

function Bracket({ view, onEnter }: { view: BattleRoomView; onEnter: (id: string) => void }) {
  const ym = view.yourMatch
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="font-display text-lg text-white">Cup Bracket</div>
        <span className="lime-pill">BEST OF 1</span>
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
          <div className="mb-1 font-display text-base text-white">Your battle is ready</div>
          <div className="mb-2.5 text-[13px] text-muted">
            You vs {ym.opponentName} · match #{ym.id}
          </div>
          <button onClick={() => onEnter(ym.id)} className={PRIMARY}>
            ENTER BATTLE →
          </button>
        </div>
      )}
    </>
  )
}
