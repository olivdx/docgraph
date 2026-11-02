'use client'

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { BOARD_SIZE, type Cell, type Move, type Side } from '@/src/game/types'
import { boundsCenter, cellAt, scrollToCenter } from './board-geometry'
import { Mark } from './marks'

export const ZOOM_STEPS = [24, 32, 44] as const
const DEFAULT_ZOOM = 1
const LAST_MOVE_BG = 'rgba(59,130,246,.18)'
const WIN_BG = 'rgba(34,197,94,.30)'

type ZoomKind = 'in' | 'out' | 'fit'
const ZOOM_BUTTONS: { kind: ZoomKind; label: string; title: string }[] = [
  { kind: 'in', label: '＋', title: 'Zoom in' },
  { kind: 'out', label: '－', title: 'Zoom out' },
  { kind: 'fit', label: '⤡', title: 'Fit' },
]

interface Props {
  moves: Move[]
  winLine: Cell[] | null
  you: Side | null
  turn: Side | null
  disabled?: boolean
  onPlay: (cell: Cell) => void
}

const key = (c: Cell) => `${c.x},${c.y}`

function scrollEl(el: HTMLDivElement | null, cell: Cell, size: number) {
  if (!el) return
  const { left, top } = scrollToCenter(cell, size, { width: el.clientWidth, height: el.clientHeight })
  el.scrollTo({ left, top })
}

export function Board({ moves, winLine, you, turn, disabled = false, onPlay }: Props) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const cs = ZOOM_STEPS[zoom]
  const scroller = useRef<HTMLDivElement>(null)
  const last = moves.length > 0 ? moves[moves.length - 1] : null
  // Where to scroll after the next layout: on mount, the last move (or the center).
  const target = useRef<Cell | null>(last ? { x: last.x, y: last.y } : boundsCenter([]))

  const occupied = useMemo(() => new Set(moves.map(key)), [moves])
  const winSet = useMemo(() => new Set((winLine ?? []).map(key)), [winLine])
  const canPlay = !disabled && you !== null && you === turn

  useLayoutEffect(() => {
    if (target.current) scrollEl(scroller.current, target.current, cs)
    target.current = null
  }, [cs])

  const viewCenter = (): Cell => {
    const el = scroller.current
    if (!el) return boundsCenter([])
    const c = Math.floor((el.scrollLeft + el.clientWidth / 2) / cs)
    const r = Math.floor((el.scrollTop + el.clientHeight / 2) / cs)
    const clamp = (v: number) => Math.min(BOARD_SIZE - 1, Math.max(0, v))
    return { x: clamp(c), y: clamp(r) }
  }

  const setZoomTo = (next: number, center: Cell, recenter = false) => {
    if (next === zoom) {
      if (recenter) scrollEl(scroller.current, center, cs)
      return
    }
    target.current = center
    setZoom(next)
  }

  const onZoom = (kind: ZoomKind) => {
    if (kind === 'in') setZoomTo(Math.min(ZOOM_STEPS.length - 1, zoom + 1), viewCenter())
    else if (kind === 'out') setZoomTo(Math.max(0, zoom - 1), viewCenter())
    else setZoomTo(0, boundsCenter(moves), true)
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!canPlay) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cell = cellAt(e.clientX - rect.left, e.clientY - rect.top, cs)
    if (!cell || occupied.has(key(cell))) return
    onPlay(cell)
  }

  const total = BOARD_SIZE * cs
  const cellBox = (c: Cell) => ({ left: c.x * cs + 1, top: c.y * cs + 1, width: cs - 1, height: cs - 1 })

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-paper">
      <div ref={scroller} className="absolute inset-0 overflow-auto overscroll-contain">
        <div
          onClick={onClick}
          className={`relative ${canPlay ? 'cursor-pointer' : ''}`}
          style={{
            width: total + 1,
            height: total + 1,
            touchAction: 'manipulation',
            backgroundColor: 'var(--paper)',
            backgroundImage:
              'linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px)',
            backgroundSize: `${cs}px ${cs}px`,
          }}
        >
          {[...winSet].map((k) => {
            const [x, y] = k.split(',').map(Number)
            return <div key={`w${k}`} className="absolute" style={{ ...cellBox({ x, y }), background: WIN_BG }} />
          })}
          {last && !winSet.has(key(last)) && (
            <div className="absolute" style={{ ...cellBox(last), background: LAST_MOVE_BG }} />
          )}
          {moves.map((m) => (
            <div key={key(m)} className="pointer-events-none absolute grid place-items-center" style={cellBox(m)}>
              <Mark side={m.side} size={cs - 1} />
            </div>
          ))}
        </div>
      </div>
      <div className="absolute right-2.5 bottom-2.5 flex flex-col gap-1.5">
        {ZOOM_BUTTONS.map((b) => (
          <button
            key={b.kind}
            type="button"
            title={b.title}
            aria-label={b.title}
            onClick={() => onZoom(b.kind)}
            className="grid size-8 place-items-center rounded-[9px] bg-white font-bold text-slate-700 shadow-[0_1px_4px_rgba(0,0,0,.15)]"
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}
