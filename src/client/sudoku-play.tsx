'use client'

import { useState } from 'react'
import { formatClock, Keypad, SudokuGrid, useNotes, type Flash } from './sudoku-board'

/**
 * The playing screen shared by solo and rooms: clock, grid, keypad, Give up. `onEnter` resolves to
 * true (correct, locked in), false (wrong: flashed red, −30 s shown) or null (not applied, e.g. a
 * network error; nothing is shown).
 */
export function PlayArea({
  puzzle,
  grid,
  remainingMs,
  mistakes,
  notesKey,
  onEnter,
  onGiveUp,
  busy,
  children,
}: {
  puzzle: string
  grid: string
  remainingMs: number
  mistakes: number
  notesKey: string
  onEnter: (cell: number, digit: number) => Promise<boolean | null>
  onGiveUp: () => void
  busy?: boolean
  children?: React.ReactNode
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [notesMode, setNotesMode] = useState(false)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [penalties, setPenalties] = useState<number[]>([])
  const [confirmQuit, setConfirmQuit] = useState(false)
  const { notes, toggle, clear, placed } = useNotes(notesKey)

  const digit = async (d: number) => {
    if (selected === null || grid[selected] !== '0') return
    if (notesMode) {
      toggle(selected, d)
      return
    }
    const cell = selected
    const res = await onEnter(cell, d)
    if (res === true) placed(cell, d)
    if (res === false) {
      const key = Date.now()
      setFlash({ cell, digit: d, key })
      setPenalties((p) => [...p, key])
      setTimeout(() => setFlash((f) => (f?.key === key ? null : f)), 1000)
      setTimeout(() => setPenalties((p) => p.filter((k) => k !== key)), 1200)
    }
  }

  const low = remainingMs < 60_000
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-[16px] border border-line bg-panel px-3.5 py-2.5">
        <div className="relative">
          <div className={`font-display text-2xl tabular-nums ${low ? 'text-o' : 'text-lime'}`}>
            {formatClock(remainingMs)}
          </div>
          {penalties.map((k) => (
            <span key={k} className="absolute -right-12 top-1 animate-[sudoku-float_1.2s_ease-out_forwards] font-display text-sm text-o">
              −30 s
            </span>
          ))}
        </div>
        <div className="text-right text-xs text-muted">
          Mistakes <b className={`font-display ${mistakes ? 'text-o' : 'text-white'}`}>{mistakes}</b>
          <br />
          {[...grid].filter((c, i) => c !== '0' && puzzle[i] === '0').length} / {[...puzzle].filter((c) => c === '0').length} filled
        </div>
      </div>

      {children}

      <SudokuGrid puzzle={puzzle} grid={grid} notes={notes} selected={selected} onSelect={setSelected} flash={flash} />
      <Keypad
        grid={grid}
        onDigit={(d) => void digit(d)}
        notesMode={notesMode}
        onToggleNotes={() => setNotesMode((m) => !m)}
        onErase={() => selected !== null && clear(selected)}
        disabled={busy}
      />

      {confirmQuit ? (
        <div className="flex items-center gap-2 rounded-xl border border-[#7f1d1d] bg-[#2a1215] p-2.5 text-sm">
          <span className="flex-1">Give up? Your filled cells still count.</span>
          <button onClick={onGiveUp} className="rounded-lg bg-o px-3 py-1.5 font-semibold text-white">
            Give up
          </button>
          <button onClick={() => setConfirmQuit(false)} className="rounded-lg border border-line px-3 py-1.5 text-muted">
            Keep going
          </button>
        </div>
      ) : (
        <button onClick={() => setConfirmQuit(true)} className="mx-auto px-3 py-1 text-[13px] text-muted underline">
          Give up
        </button>
      )}
    </div>
  )
}
