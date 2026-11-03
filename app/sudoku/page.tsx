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

const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2']
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
    <div key={r.code} className={`flex items-center gap-2.5 rounded-xl border bg-[#1a2537] p-3 ${r.youAreIn ? 'border-accent' : 'border-line'}`}>
      <div
        className="grid size-[30px] flex-none place-items-center rounded-full text-[13px] font-bold text-white"
        style={{ background: colorFor(r.code) }}
      >
        {r.code.slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{r.name}</div>
        <div className="text-[13px] text-muted">
          {LABEL[r.difficulty]} · {r.youAreIn ? "You're in" : `Host: ${r.hostName}`} · {r.playerCount} joined
          {r.status === 'playing' && (
            <span className="ml-1 rounded-full border border-[#78591a] bg-panel2 px-2 py-0.5 text-[11px] text-amber-400">In progress</span>
          )}
        </div>
      </div>
      {r.youAreIn ? (
        <button onClick={() => router.push(`/s/${r.code}`)} className="rounded-[9px] bg-accent px-3.5 py-2 text-[13px] font-semibold text-white">
          Resume
        </button>
      ) : r.status === 'lobby' ? (
        <button
          disabled={busy}
          onClick={() => act(`/api/sudoku/${r.code}/join`)}
          className="rounded-[9px] border border-line bg-panel2 px-3.5 py-2 text-[13px] font-semibold disabled:opacity-50"
        >
          Join
        </button>
      ) : (
        <button onClick={() => router.push(`/s/${r.code}`)} className="rounded-[9px] border border-line bg-panel2 px-3.5 py-2 text-[13px] font-semibold">
          View
        </button>
      )}
    </div>
  )

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <div>
        <button onClick={() => router.push('/')} className="-ml-1 px-1 text-[13px] text-muted">
          ← Games
        </button>
        <div className="text-[22px] font-bold">Sudoku</div>
        <div className="text-[13px] text-muted">30 minutes · a wrong number costs 30 s</div>
      </div>

      <div className="rounded-2xl border border-line bg-panel p-4">
        <div className="mb-2.5 text-[11px] uppercase tracking-[0.08em] text-muted">Play solo</div>
        {solo ? (
          <button onClick={() => router.push('/sudoku/solo')} className="block w-full rounded-xl bg-accent p-3 text-[15px] font-semibold text-white">
            Resume solo game ({LABEL[solo.difficulty]})
          </button>
        ) : (
          <>
            <DifficultyPicker value={difficulty} onChange={setDifficulty} />
            <button
              onClick={() => router.push(`/sudoku/solo?new=${difficulty}`)}
              className="mt-3 block w-full rounded-xl bg-accent p-3 text-[15px] font-semibold text-white"
            >
              Start solo game
            </button>
          </>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.08em] text-muted">Race with friends</div>
        <button
          disabled={busy}
          onClick={() => act('/api/sudoku', { difficulty })}
          className="rounded-[9px] bg-accent px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          ＋ Create room
        </button>
      </div>

      {rooms.error && !rooms.data && <div className="text-sm text-o">Could not load rooms. Retrying…</div>}
      {mine.map(row)}
      {rooms.data && open.length === 0 && mine.length === 0 && (
        <div className="py-6 text-center text-sm text-muted">No open rooms yet. Create one!</div>
      )}
      {open.map(row)}

      {toast && (
        <div className="fixed inset-x-4 bottom-4 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-panel p-3 text-sm shadow-lg">
          <span className="flex-1">{toast.text}</span>
          {toast.code && (
            <button
              onClick={() => router.push(roomPath(toast.code!))}
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
