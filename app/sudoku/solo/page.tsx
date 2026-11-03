'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatClock, LABEL, SudokuGrid, useTick } from '@/src/client/sudoku-board'
import { PlayArea } from '@/src/client/sudoku-play'
import { loadSolo, newSolo, saveSolo, settleSolo, soloEnter, soloOver, SOLO_NOTES_KEY, type SoloGame } from '@/src/client/solo'
import { isDifficulty } from '@/src/sudoku/types'

export default function SoloPage() {
  return (
    <Suspense fallback={<main className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</main>}>
      <Solo />
    </Suspense>
  )
}

function Solo() {
  const router = useRouter()
  const search = useSearchParams()
  const [game, setGame] = useState<SoloGame | null>(null)

  // ?new=<difficulty> starts a fresh puzzle (then drops the param so a reload resumes it).
  useEffect(() => {
    const d = search.get('new')
    let g: SoloGame | null
    if (isDifficulty(d)) {
      g = newSolo(d)
      saveSolo(g)
      router.replace('/sudoku/solo')
    } else {
      g = loadSolo()
      if (!g) {
        router.replace('/sudoku')
        return
      }
    }
    const loaded = g
    void Promise.resolve().then(() => setGame(loaded))
  }, [search, router])

  const over = !!game && soloOver(game)
  const now = useTick(!!game && !over)

  // Time-out happens on the clock, not only on input.
  useEffect(() => {
    if (!game || over || now < game.deadlineAt) return
    const g = settleSolo(game, now)
    saveSolo(g)
    void Promise.resolve().then(() => setGame(g))
  }, [game, over, now])

  if (!game) return <main className="flex flex-1 items-center justify-center text-sm text-muted">Generating puzzle…</main>

  const update = (g: SoloGame) => {
    saveSolo(g)
    setGame(g)
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2 text-sm text-slate-300">
        <button onClick={() => router.push('/sudoku')} aria-label="Back" className="-ml-1 px-1 text-lg leading-none">
          ←
        </button>
        <span className="font-semibold">Solo · {LABEL[game.difficulty]}</span>
      </div>

      {over ? (
        <SoloResult game={game} onNew={() => router.push(`/sudoku/solo?new=${game.difficulty}`)} onHome={() => router.push('/sudoku')} />
      ) : (
        <PlayArea
          puzzle={game.puzzle}
          grid={game.grid}
          remainingMs={game.deadlineAt - now}
          mistakes={game.mistakes}
          notesKey={SOLO_NOTES_KEY}
          onEnter={async (cell, digit) => {
            const { game: g, correct } = soloEnter(game, cell, digit)
            update(g)
            return correct
          }}
          onGiveUp={() => update({ ...game, outAt: Date.now(), outReason: 'gave_up' })}
        />
      )}
    </main>
  )
}

function SoloResult({ game, onNew, onHome }: { game: SoloGame; onNew: () => void; onHome: () => void }) {
  const toFill = [...game.puzzle].filter((c) => c === '0').length
  const filled = [...game.grid].filter((c, i) => c !== '0' && game.puzzle[i] === '0').length
  const solved = game.finishedAt !== null
  return (
    <>
      <div className="rounded-2xl border border-line bg-panel p-4 text-center">
        <div className="text-4xl">{solved ? '🎉' : game.outReason === 'gave_up' ? '🏳️' : '⏰'}</div>
        <div className="mt-1 text-lg font-bold">{solved ? 'Solved!' : game.outReason === 'gave_up' ? 'You gave up' : "Time's up"}</div>
        <div className="mt-1 text-[13px] text-muted">
          {solved ? `Time ${formatClock(game.finishedAt! - game.startedAt)}` : `${filled} / ${toFill} cells`} · {game.mistakes} mistake
          {game.mistakes === 1 ? '' : 's'}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={onNew} className="rounded-xl bg-accent p-3 text-[15px] font-semibold text-white">
            New game
          </button>
          <button onClick={onHome} className="rounded-xl border border-line bg-panel2 p-3 text-[15px] font-semibold">
            Home
          </button>
        </div>
      </div>
      <SudokuGrid puzzle={game.puzzle} grid={game.grid} selected={null} reveal={game.solution} />
    </>
  )
}
