'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError, apiGet, apiPost } from '@/src/client/api'
import { getStartParam, initTelegram } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import type { RoomSummary, RoomView } from '@/src/tournament/views'

interface Me {
  user: { id: string; name: string; avatarUrl: string | null }
  active: { code: string; matchId: string | null } | null
}

const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2']
const colorFor = (code: string) => COLORS[[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]

/** True only the first time this session (sessionStorage flag). */
function firstBoot(): boolean {
  try {
    if (sessionStorage.getItem('booted')) return false
    sessionStorage.setItem('booted', '1')
    return true
  } catch {
    return false
  }
}

export default function Home() {
  const router = useRouter()
  const [booting, setBooting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; code?: string } | null>(null)
  const rooms = usePoll<RoomSummary[]>(booting ? null : '/api/rooms', 10_000)
  const me = usePoll<Me>(booting ? null : '/api/me', 60_000)

  useEffect(() => {
    initTelegram()
    if (!firstBoot()) {
      void Promise.resolve().then(() => setBooting(false))
      return
    }
    const start = getStartParam()
    if (start) {
      router.replace(`/r/${encodeURIComponent(start)}?join=1`)
      return
    }
    apiGet<Me>('/api/me')
      .then((m) => {
        if (m.active) {
          router.replace(m.active.matchId ? `/r/${m.active.code}/m/${m.active.matchId}` : `/r/${m.active.code}`)
        } else setBooting(false)
      })
      .catch(() => setBooting(false))
  }, [router])

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

  if (booting) {
    return <main className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</main>
  }

  const list = rooms.data ?? []
  const mine = list.filter((r) => r.youAreIn)
  const open = list.filter((r) => !r.youAreIn)
  const firstName = me.data?.user.name.split(' ')[0]

  const row = (r: RoomSummary) => (
    <div
      key={r.code}
      className={`flex items-center gap-2.5 rounded-xl border bg-[#1a2537] p-3 ${r.youAreIn ? 'border-accent' : 'border-line'}`}
    >
      <div
        className="grid size-[30px] flex-none place-items-center rounded-full text-[13px] font-bold text-white"
        style={{ background: colorFor(r.code) }}
      >
        {r.code.slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{r.name}</div>
        <div className="text-[13px] text-muted">
          {r.youAreIn
            ? `You're in${r.liveLabel ? ` · ${r.liveLabel}` : ''}`
            : `Host: ${r.hostName} · ${r.playerCount} joined`}
          {!r.youAreIn && r.status === 'running' && (
            <span className="ml-1 rounded-full border border-[#78591a] bg-panel2 px-2 py-0.5 text-[11px] text-amber-400">
              In progress
            </span>
          )}
        </div>
      </div>
      {r.youAreIn ? (
        <button
          onClick={() => router.push(`/r/${r.code}`)}
          className="rounded-[9px] bg-accent px-3.5 py-2 text-[13px] font-semibold text-white"
        >
          Resume
        </button>
      ) : r.status === 'lobby' ? (
        <button
          disabled={busy}
          onClick={() => act(`/api/rooms/${r.code}/join`)}
          className="rounded-[9px] border border-line bg-panel2 px-3.5 py-2 text-[13px] font-semibold disabled:opacity-50"
        >
          Join
        </button>
      ) : (
        <button
          onClick={() => router.push(`/r/${r.code}`)}
          className="rounded-[9px] border border-line bg-panel2 px-3.5 py-2 text-[13px] font-semibold"
        >
          View
        </button>
      )}
    </div>
  )

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[22px] font-bold">Tournaments</div>
          {firstName && (
            <div className="text-[13px] text-muted">
              Hi, <b className="text-text">{firstName}</b>
            </div>
          )}
        </div>
        <button
          disabled={busy}
          onClick={() => act('/api/rooms')}
          className="rounded-[9px] bg-accent px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          ＋ Create
        </button>
      </div>

      {rooms.error && !rooms.data && <div className="text-sm text-o">Could not load rooms. Retrying…</div>}

      {mine.length > 0 && (
        <>
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted">Your tournament</div>
          {mine.map(row)}
        </>
      )}

      <div className="text-[11px] uppercase tracking-[0.08em] text-muted">Open rooms</div>
      {rooms.data && open.length === 0 && (
        <div className="py-6 text-center text-sm text-muted">No open rooms yet. Create one!</div>
      )}
      {open.map(row)}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-panel p-3 text-sm shadow-lg">
          <span className="flex-1">{toast.text}</span>
          {toast.code && (
            <button
              onClick={() => router.push(`/r/${toast.code}`)}
              className="rounded-[9px] bg-accent px-3 py-1.5 text-[13px] font-semibold text-white"
            >
              Go
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
