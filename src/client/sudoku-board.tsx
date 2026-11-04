'use client'

import { useCallback, useEffect, useState } from 'react'
import { PEERS } from '@/src/sudoku/generator'
import { DIFFICULTIES, type Difficulty } from '@/src/sudoku/types'

export const LABEL: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }

const ROW = (i: number) => Math.floor(i / 9)
const COL = (i: number) => i % 9

export interface Flash {
  cell: number
  digit: number
  key: number
}

/**
 * The 9×9 grid. `grid` holds givens + the player's correct digits ('0' = empty). `reveal`, when
 * given, shows the solution's digits in the empty cells (result screen).
 */
export function SudokuGrid({
  puzzle,
  grid,
  notes,
  selected,
  onSelect,
  flash,
  reveal,
}: {
  puzzle: string
  grid: string
  notes?: Record<number, number>
  selected: number | null
  onSelect?: (cell: number) => void
  flash?: Flash | null
  reveal?: string | null
}) {
  const selDigit = selected !== null && grid[selected] !== '0' ? grid[selected] : null
  const peers = selected !== null ? new Set(PEERS[selected]) : null
  return (
    <div className="mx-auto grid aspect-square w-full max-w-[420px] grid-cols-9 overflow-hidden rounded-lg border-2 border-slate-700 bg-paper select-none">
      {[...grid].map((c, i) => {
        const given = puzzle[i] !== '0'
        const isSel = i === selected
        const same = selDigit !== null && c === selDigit
        const flashing = flash && flash.cell === i
        const revealed = c === '0' && reveal ? reveal[i] : null
        const bg = isSel ? 'bg-blue-200' : same ? 'bg-blue-100' : peers?.has(i) ? 'bg-slate-200/70' : ''
        const border = [
          COL(i) % 3 === 2 && COL(i) !== 8 ? 'border-r-2 border-r-slate-700' : COL(i) !== 8 ? 'border-r border-r-slate-300' : '',
          ROW(i) % 3 === 2 && ROW(i) !== 8 ? 'border-b-2 border-b-slate-700' : ROW(i) !== 8 ? 'border-b border-b-slate-300' : '',
        ].join(' ')
        const n = notes?.[i] ?? 0
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelect?.(i)}
            className={`relative grid aspect-square place-items-center ${border} ${bg}`}
            aria-label={`Row ${ROW(i) + 1} column ${COL(i) + 1}${c !== '0' ? `, ${c}` : ''}`}
          >
            {flashing ? (
              <span key={flash.key} className="animate-[sudoku-flash_1s_ease-out_forwards] text-[clamp(16px,5.5vw,24px)] font-semibold text-o">
                {flash.digit}
              </span>
            ) : c !== '0' ? (
              <span className={`text-[clamp(16px,5.5vw,24px)] ${given ? 'font-bold text-slate-900' : 'font-semibold text-x'}`}>{c}</span>
            ) : revealed ? (
              <span className="text-[clamp(16px,5.5vw,24px)] font-semibold text-slate-400">{revealed}</span>
            ) : n ? (
              <span className="grid size-full grid-cols-3 p-[1px] text-[clamp(7px,2.2vw,10px)] leading-none text-slate-500">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                  <span key={d} className="grid place-items-center">
                    {n & (1 << d) ? d : ''}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** 1–9 pad plus Notes / Erase. A digit already placed nine times is greyed out. */
export function Keypad({
  grid,
  onDigit,
  notesMode,
  onToggleNotes,
  onErase,
  disabled,
}: {
  grid: string
  onDigit: (d: number) => void
  notesMode: boolean
  onToggleNotes: () => void
  onErase: () => void
  disabled?: boolean
}) {
  const counts = new Array(10).fill(0)
  for (const c of grid) counts[Number(c)]++
  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col gap-2">
      <div className="grid grid-cols-9 gap-1">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
          const done = counts[d] >= 9
          return (
            <button
              key={d}
              type="button"
              disabled={disabled || done}
              onClick={() => onDigit(d)}
              className={`rounded-lg py-3 text-xl font-semibold disabled:opacity-30 ${notesMode ? 'bg-panel2 text-muted' : 'bg-panel2 text-text'} active:bg-accent`}
            >
              {d}
            </button>
          )
        })}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onToggleNotes}
          className={`rounded-lg border py-2 text-sm font-semibold ${notesMode ? 'border-accent bg-accent/20 text-accent' : 'border-line bg-panel text-muted'}`}
        >
          ✎ Notes {notesMode ? 'on' : 'off'}
        </button>
        <button type="button" onClick={onErase} className="rounded-lg border border-line bg-panel py-2 text-sm font-semibold text-muted">
          ⌫ Erase notes
        </button>
      </div>
    </div>
  )
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Re-renders every `ms` while `on`. */
export function useTick(on: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}

/** Pencil marks, bit d set = candidate d. Kept in localStorage under `key` (client-only, never scored). */
export function useNotes(key: string) {
  const [notes, setNotes] = useState<Record<number, number>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<number, number>
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(notes))
    } catch {}
  }, [key, notes])

  const toggle = useCallback((cell: number, d: number) => {
    setNotes((n) => ({ ...n, [cell]: (n[cell] ?? 0) ^ (1 << d) }))
  }, [])
  const clear = useCallback((cell: number) => {
    setNotes((n) => {
      const { [cell]: _drop, ...rest } = n // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest
    })
  }, [])
  /** A digit was placed: drop the cell's notes and that digit from its peers' notes. */
  const placed = useCallback((cell: number, d: number) => {
    setNotes((n) => {
      const out = { ...n }
      delete out[cell]
      for (const p of PEERS[cell]) if (out[p]) out[p] &= ~(1 << d)
      return out
    })
  }, [])
  return { notes, toggle, clear, placed }
}

export function DifficultyPicker({
  value,
  onChange,
  disabled,
}: {
  value: Difficulty
  onChange: (d: Difficulty) => void
  disabled?: boolean
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-line bg-bg p-1">
      {DIFFICULTIES.map((d) => (
        <button
          key={d}
          type="button"
          disabled={disabled}
          onClick={() => onChange(d)}
          className={`rounded-lg py-2 font-display text-xs tracking-wider uppercase transition ${
            value === d ? 'arcade-glow bg-accent text-white' : 'text-muted'
          } disabled:cursor-default`}
        >
          {LABEL[d]}
        </button>
      ))}
    </div>
  )
}
