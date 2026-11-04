'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError, apiPost } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { initTelegram } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import type { RoomSummary, RoomView } from '@/src/tournament/views'

interface Me {
  user: { id: string; name: string; avatarUrl: string | null }
  active: { game: 'caro' | 'sudoku'; code: string; matchId: string | null } | null
}

const COLORS = ['#6c79ff', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4']
const colorFor = (code: string) => COLORS[[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]
type RoomFilter = 'all' | 'mine' | 'lobby' | 'live'

export default function CaroHome() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<RoomFilter>('all')
  const [toast, setToast] = useState<{ text: string; code?: string } | null>(null)
  const rooms = usePoll<RoomSummary[]>('/api/rooms', 10_000)
  const [hasActive, setHasActive] = useState(false)
  // While you're in a tournament, check often whether your next match is ready.
  const me = usePoll<Me>('/api/me', hasActive ? 10_000 : 60_000)
  const nowActive = !!me.data?.active
  if (nowActive !== hasActive) setHasActive(nowActive) // adjust state while rendering (no extra effect)

  // A pending/playing match of yours: enter it once (same sessionStorage guard as the bracket page).
  const activeCode = me.data?.active?.game === 'caro' ? me.data.active.code : null
  const activeMatchId = me.data?.active?.matchId ?? null
  useEffect(() => {
    if (!activeCode || !activeMatchId) return
    try {
      const k = `auto:${activeMatchId}`
      if (sessionStorage.getItem(k)) return
      sessionStorage.setItem(k, '1')
    } catch {
      return
    }
    router.push(`/r/${activeCode}/m/${activeMatchId}`)
  }, [activeCode, activeMatchId, router])

  useEffect(() => {
    initTelegram()
  }, [])

  const act = useCallback(
    async (path: string) => {
      if (busy) return
      setBusy(true)
      try {
        const room = await apiPost<RoomView>(path)
        router.push(`/r/${room.code}`)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'already_active') {
          const code = String(e.extra.activeCode ?? '')
          setToast({ text: `You're already in ${code}`, code })
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
  const user = me.data?.user
  const firstName = user?.name.split(' ')[0]

  const shownOpen = open.filter((r) => {
    if (filter === 'mine') return false
    if (filter === 'lobby') return r.status === 'lobby'
    if (filter === 'live') return r.status === 'running'
    return true
  })

  const row = (r: RoomSummary) => (
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
          {r.youAreIn
            ? `You're in${r.liveLabel ? ` · ${r.liveLabel}` : ''}`
            : `Host: ${r.hostName} · ${r.playerCount} joined`}
          {!r.youAreIn && r.status === 'running' && (
            <span className="ml-1.5 rounded-md bg-rose-500/15 px-1.5 py-0.5 font-display text-[10px] tracking-wider text-rose-400 uppercase">
              LIVE
            </span>
          )}
        </div>
      </div>
      <span className="font-display text-xs text-white/90">{r.playerCount}p</span>
      {r.youAreIn ? (
        <button
          onClick={() => router.push(`/r/${r.code}`)}
          className="arcade-glow rounded-[10px] bg-accent px-3 py-2 font-display text-xs tracking-wider text-white uppercase"
        >
          RESUME
        </button>
      ) : r.status === 'lobby' ? (
        <button
          disabled={busy}
          onClick={() => act(`/api/rooms/${r.code}/join`)}
          className="rounded-[10px] bg-emerald-500/15 px-3 py-2 font-display text-xs tracking-wider text-emerald-400 uppercase disabled:opacity-50"
        >
          JOIN ＋
        </button>
      ) : (
        <button
          onClick={() => router.push(`/r/${r.code}`)}
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
          <button
            onClick={() => router.push('/')}
            aria-label="Back to Games"
            className="grid size-9 flex-none place-items-center rounded-xl border border-line bg-panel font-display text-base text-white"
          >
            ←
          </button>
          <div className="min-w-0">
            <div className="font-display text-xl leading-tight text-white">Caro Tournaments</div>
            {firstName && (
              <div className="text-xs text-muted">
                Hi, <b className="text-white">{firstName}</b> · Bo1 &amp; Bo3 Knockout
              </div>
            )}
          </div>
        </div>
        <button
          disabled={busy}
          onClick={() => act('/api/rooms')}
          className="arcade-glow rounded-[11px] bg-accent px-3.5 py-2 font-display text-xs tracking-wider text-white uppercase disabled:opacity-50"
        >
          ＋ CREATE
        </button>
      </header>

      <div className="flex items-center gap-1.5 overflow-x-auto">
        {(
          [
            ['all', 'ALL'],
            ['mine', 'YOUR ROOM'],
            ['lobby', 'LOBBY'],
            ['live', 'LIVE'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-[10px] px-3 py-1.5 font-display text-xs tracking-wider uppercase transition ${
              filter === key ? 'arcade-glow bg-accent text-white' : 'text-muted hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {rooms.error && !rooms.data && <div className="text-sm text-o">Could not load rooms. Retrying…</div>}

      {mine.length > 0 && filter !== 'lobby' && filter !== 'live' && (
        <>
          <div className="flex justify-between px-1 font-display text-[11px] tracking-wider text-muted uppercase">
            <span>Your tournament</span>
            <span>Action</span>
          </div>
          {mine.map(row)}
        </>
      )}

      {filter !== 'mine' && (
        <>
          <div className="flex justify-between px-1 font-display text-[11px] tracking-wider text-muted uppercase">
            <span>Open rooms</span>
            <span>Players · Action</span>
          </div>
          {rooms.data && shownOpen.length === 0 && (
            <div className="rounded-2xl border border-line bg-panel py-7 text-center text-sm text-muted">
              No open rooms yet. Create one!
            </div>
          )}
          <div className="flex flex-col gap-2">{shownOpen.map(row)}</div>
        </>
      )}
      {filter === 'mine' && mine.length === 0 && (
        <div className="rounded-2xl border border-line bg-panel py-7 text-center text-sm text-muted">
          You&apos;re not in a tournament right now.
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-panel p-3 text-sm shadow-xl">
          <span className="flex-1">{toast.text}</span>
          {toast.code && (
            <button
              onClick={() => router.push(roomPath(toast.code!))}
              className="arcade-glow rounded-[10px] bg-accent px-3 py-1.5 font-display text-xs text-white uppercase"
            >
              GO
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
