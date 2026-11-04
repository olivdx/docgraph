'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError, apiPost } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { loadSolo, soloOver, type SoloGame } from '@/src/client/solo'
import { initTelegram } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'
import { DifficultyPicker, LABEL } from '@/src/client/sudoku-board'
import type { Difficulty } from '@/src/sudoku/types'
import type { SudokuSummary, SudokuView } from '@/src/sudoku/views'

const COLORS = ['#6c79ff', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4']
const colorFor = (code: string) => COLORS[[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]

export default function SudokuHome() {
  const router = useRouter()
  const rooms = usePoll<SudokuSummary[]>('/api/sudoku', 10_000)
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [solo, setSolo] = useState<SoloGame | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; code?: string } | null>(null)

  useEffect(() => {
    initTelegram()
    const s = loadSolo()
    if (s && !soloOver(s)) void Promise.resolve().then(() => setSolo(s))
  }, [])

  const act = useCallback(
    async (path: string, body?: unknown) => {
      if (busy) return
      setBusy(true)
      try {
        const v = await apiPost<SudokuView>(path, body)
        router.push(`/s/${v.code}`)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'already_active') {
          const code = String(e.extra.activeCode ?? '')
          setToast({ text: `You're already in ${code}`, code })
        } else if (e instanceof ApiError && e.code === 'not_lobby') {
          setToast({ text: 'That game has already started.' })
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

  const row = (r: SudokuSummary) => (
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
          {LABEL[r.difficulty]} · {r.youAreIn ? "You're in" : `Host: ${r.hostName}`} · {r.playerCount} joined
          {r.status === 'playing' && (
            <span className="ml-1.5 rounded-md bg-rose-500/15 px-1.5 py-0.5 font-display text-[10px] tracking-wider text-rose-400 uppercase">
              LIVE
            </span>
          )}
        </div>
      </div>
      {r.youAreIn ? (
        <button
          onClick={() => router.push(`/s/${r.code}`)}
          className="arcade-glow rounded-[10px] bg-accent px-3 py-2 font-display text-xs tracking-wider text-white uppercase"
        >
          RESUME
        </button>
      ) : r.status === 'lobby' ? (
        <button
          disabled={busy}
          onClick={() => act(`/api/sudoku/${r.code}/join`)}
          className="rounded-[10px] bg-emerald-500/15 px-3 py-2 font-display text-xs tracking-wider text-emerald-400 uppercase disabled:opacity-50"
        >
          JOIN ＋
        </button>
      ) : (
        <button
          onClick={() => router.push(`/s/${r.code}`)}
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
          <div>
            <div className="font-display text-xl leading-tight text-white">Sudoku Race</div>
            <div className="text-xs text-muted">30 minutes · −30 s per mistake</div>
          </div>
        </div>
        <span className="lime-pill">9×9 PUZZLE</span>
      </header>

      <div className="rounded-[20px] border border-line bg-panel p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-display text-base text-white">Play Solo</span>
          <span className="lime-pill">INSTANT</span>
        </div>
        {solo ? (
          <button
            onClick={() => router.push('/sudoku/solo')}
            className="arcade-glow block w-full rounded-xl bg-accent p-3 font-display text-sm tracking-wider text-white uppercase"
          >
            RESUME SOLO ({LABEL[solo.difficulty]})
          </button>
        ) : (
          <>
            <DifficultyPicker value={difficulty} onChange={setDifficulty} />
            <button
              onClick={() => router.push(`/sudoku/solo?new=${difficulty}`)}
              className="arcade-glow mt-3 block w-full rounded-xl bg-accent p-3 font-display text-sm tracking-wider text-white uppercase"
            >
              START SOLO GAME ▶
            </button>
          </>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="font-display text-lg text-white">Race With Friends</div>
        <button
          disabled={busy}
          onClick={() => act('/api/sudoku', { difficulty })}
          className="arcade-glow rounded-[11px] bg-accent px-3.5 py-2 font-display text-xs tracking-wider text-white uppercase disabled:opacity-50"
        >
          ＋ CREATE ROOM
        </button>
      </div>

      {rooms.error && !rooms.data && <div className="text-sm text-o">Could not load rooms. Retrying…</div>}
      {mine.map(row)}
      {rooms.data && open.length === 0 && mine.length === 0 && (
        <div className="rounded-2xl border border-line bg-panel py-7 text-center text-sm text-muted">
          No open rooms yet. Create one!
        </div>
      )}
      {open.map(row)}

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
