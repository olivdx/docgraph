'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BackButton } from '@/src/client/back-button'
import { ApiError, apiPost } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { initTelegram } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import { ShipThumb } from '@/src/client/battleship/ship-thumb'
import { BATTLE_CODE_LEN } from '@/src/battleship/constants'
import type { BattleRoomView, BattleSummary } from '@/src/battleship/views'
import type { RankingView } from '@/src/server/battleship-rating'

const COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#6c79ff', '#06b6d4']
const colorFor = (code: string) => COLORS[[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]

export default function BattleshipHome() {
  const router = useRouter()
  const rooms = usePoll<BattleSummary[]>('/api/battleship', 10_000)
  const ranking = usePoll<RankingView>('/api/battleship/ranking', 60_000)
  const myRating = ranking.data?.me?.rating
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; code?: string; retryPath?: string } | null>(null)

  useEffect(() => {
    initTelegram()
  }, [])

  const act = useCallback(
    async (path: string, leaveCurrent = false) => {
      if (busy) return
      setBusy(true)
      setToast(null)
      try {
        const v = await apiPost<BattleRoomView>(path, leaveCurrent ? { leaveCurrent: true } : undefined)
        router.push(`/b/${v.code}`)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'already_active') {
          const code = String(e.extra.activeCode ?? '')
          // Another Battleship cup can be left on the spot; a Caro or Sudoku room can't.
          const battle = code.length === BATTLE_CODE_LEN
          setToast({
            text: battle ? `You're in cup ${code}. Leave it and continue? You'll lose any match you're in.` : `You're already in ${code}`,
            code,
            retryPath: battle ? path : undefined,
          })
        } else if (e instanceof ApiError && e.code === 'not_lobby') {
          setToast({ text: 'That cup has already started.' })
        } else if (e instanceof ApiError && e.code === 'full') {
          setToast({ text: 'That cup is full.' })
        } else {
          setToast({ text: 'Something went wrong. Try again.' })
        }
        setBusy(false)
      }
    },
    [busy, router],
  )

  const list = rooms.data ?? []
  const mine = list.filter((r) => r.youAreIn)
  const open = list.filter((r) => !r.youAreIn)

  const row = (r: BattleSummary) => (
    <div
      key={r.code}
      className={`flex items-center gap-3 rounded-[16px] border p-3 ${
        r.youAreIn
          ? 'border-accent bg-[linear-gradient(90deg,rgba(108,121,255,0.14),var(--panel))]'
          : 'border-line bg-panel'
      }`}
    >
      <div
        className="grid size-[38px] flex-none place-items-center rounded-[11px] font-display text-sm text-white"
        style={{ background: colorFor(r.code) }}
      >
        {r.code.slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm text-white">{r.name}</div>
        <div className="text-[11px] text-muted">
          {r.youAreIn ? "You're in" : `Host: ${r.hostName}`} · {r.playerCount} joined
          {r.liveLabel && (
            <span className="ml-1.5 rounded-md bg-rose-500/15 px-1.5 py-0.5 font-display text-[10px] tracking-wider text-rose-400 uppercase">
              {r.liveLabel}
            </span>
          )}
        </div>
      </div>
      {r.youAreIn ? (
        <button
          onClick={() => router.push(`/b/${r.code}`)}
          className="arcade-glow rounded-[10px] bg-accent px-3 py-2 font-display text-xs tracking-wider text-white uppercase"
        >
          RESUME
        </button>
      ) : r.status === 'lobby' ? (
        <button
          disabled={busy}
          onClick={() => act(`/api/battleship/${r.code}/join`)}
          className="rounded-[10px] bg-emerald-500/15 px-3 py-2 font-display text-xs tracking-wider text-emerald-400 uppercase disabled:opacity-50"
        >
          JOIN ＋
        </button>
      ) : (
        <button
          onClick={() => router.push(`/b/${r.code}`)}
          className="rounded-[10px] border border-line bg-panel2 px-3 py-2 font-display text-xs tracking-wider text-white uppercase"
        >
          VIEW
        </button>
      )}
    </div>
  )

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <BackButton onClick={() => router.push('/')} label="Back to Games" />
          <div>
            <div className="font-display text-xl leading-tight text-white">Battleship Cup</div>
            <div className="text-xs text-muted">10×10 sea · 6 ships · hit to fire again</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => router.push('/battleship/ranking')}
          aria-label="Open the ranking"
          className="lime-pill flex-none"
        >
          🏆 {myRating === undefined ? 'RANKING' : myRating.toLocaleString('en-US')}
        </button>
      </header>

      <div className="relative overflow-hidden rounded-[20px] border border-line bg-[radial-gradient(circle_at_30%_20%,#1d8fc0,#0b2a44_85%)] p-4">
        <ShipThumb size={140} className="pointer-events-none absolute -right-3 -bottom-4" />
        <div className="max-w-[210px] font-display text-lg leading-tight text-white">Hide your fleet. Sink theirs.</div>
        <p className="mt-1.5 max-w-[210px] text-xs leading-snug text-sky-100/80">
          Create a cup, share the link in your chat, and fight a knockout bracket. Last captain afloat wins.
        </p>
        <button
          disabled={busy}
          onClick={() => act('/api/battleship')}
          className="arcade-glow mt-3 rounded-[11px] bg-accent px-3.5 py-2 font-display text-xs tracking-wider text-white uppercase disabled:opacity-50"
        >
          ＋ CREATE CUP
        </button>
      </div>

      <div className="font-display text-lg text-white">Open Cups</div>
      {rooms.error && !rooms.data && <div className="text-sm text-o">Could not load cups. Retrying…</div>}
      {mine.map(row)}
      {rooms.data && open.length === 0 && mine.length === 0 && (
        <div className="rounded-2xl border border-line bg-panel py-7 text-center text-sm text-muted">
          No open cups yet. Create one!
        </div>
      )}
      {open.map(row)}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-panel p-3 text-sm shadow-xl">
          <span className="flex-1">{toast.text}</span>
          {toast.retryPath && (
            <button
              onClick={() => void act(toast.retryPath!, true)}
              className="rounded-[10px] bg-rose-500/90 px-3 py-1.5 font-display text-xs text-white uppercase"
            >
              LEAVE &amp; CONTINUE
            </button>
          )}
          {toast.code && (
            <button
              onClick={() => router.push(roomPath(toast.code!))}
              className="arcade-glow rounded-[10px] bg-accent px-3 py-1.5 font-display text-xs text-white uppercase"
            >
              {toast.retryPath ? 'BACK TO IT' : 'GO'}
            </button>
          )}
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="text-muted">
            ✕
          </button>
        </div>
      )}
    </main>
  )
}
