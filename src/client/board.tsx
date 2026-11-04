'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent } from 'react'
import { BOARD_MAX, BOARD_MIN, type Cell, type Move, type Side } from '@/src/game/types'
import {
  CELL_PX,
  boundsCenter,
  cellAtPoint,
  clampOffset,
  isCellVisible,
  isTap,
  offsetToCenterOn,
  translateOf,
  type Offset,
} from './board-geometry'
import { Mark } from './marks'

const LAST_MOVE_BG = 'rgba(108, 121, 255, 0.14)'
const WIN_BG = 'rgba(34, 197, 94, 0.22)'
const CELL_RADIUS = 9
const GLIDE = 'transform 320ms ease'

interface Props {
  moves: Move[]
  winLine: Cell[] | null
  you: Side | null
  turn: Side | null
  disabled?: boolean
  onPlay: (cell: Cell) => void
}

const key = (c: Cell) => `${c.x},${c.y}`

type Drag = { id: number; sx: number; sy: number; from: Offset; panning: boolean }

/**
 * The 100×100 board (-50..49) in a fixed-size viewport you drag to pan (no zoom). Only the paper
 * rectangle and the stones are in the DOM; the grid is a CSS background on the paper. Pan updates
 * write the plane's transform directly (no re-render per pointer move).
 */
export function Board({ moves, winLine, you, turn, disabled = false, onPlay }: Props) {
  const cs = CELL_PX
  const viewport = useRef<HTMLDivElement>(null)
  const plane = useRef<HTMLDivElement>(null)
  const offset = useRef<Offset>({ x: 0, y: 0 })
  const drag = useRef<Drag | null>(null)
  const last = moves.length > 0 ? moves[moves.length - 1] : null

  const occupied = useMemo(() => new Set(moves.map(key)), [moves])
  const winSet = useMemo(() => new Set((winLine ?? []).map(key)), [winLine])
  const canPlay = !disabled && you !== null && you === turn

  const size = () => {
    const el = viewport.current
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 }
  }

  const setOffset = (o: Offset, smooth = false) => {
    const { w, h } = size()
    const next = clampOffset(o, w, h, cs)
    offset.current = next
    const el = plane.current
    if (!el) return
    el.style.transition = smooth ? GLIDE : 'none'
    el.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
  }

  const centerOn = (cell: Cell, smooth = false) => {
    const { w, h } = size()
    setOffset(offsetToCenterOn(cell, w, h, cs), smooth)
  }

  // Initial view: the last move, else (0,0). Resizes keep the same board point in the center.
  const initialCell = useRef<Cell>(last ? { x: last.x, y: last.y } : { x: 0, y: 0 })
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    centerOn(initialCell.current)
    let prev = { w: el.clientWidth, h: el.clientHeight }
    const ro = new ResizeObserver(() => {
      const now = { w: el.clientWidth, h: el.clientHeight }
      if (now.w === prev.w && now.h === prev.h) return
      const o = offset.current
      setOffset({ x: o.x + (now.w - prev.w) / 2, y: o.y + (now.h - prev.h) / 2 })
      prev = now
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; helpers read refs
  }, [])

  // A new last move (typically the opponent's) outside the viewport: glide to it. A visible one
  // leaves the view alone, so your own taps never move the board.
  const lastX = last?.x ?? null
  const lastY = last?.y ?? null
  const seenLast = useRef(last ? key(last) : '')
  useEffect(() => {
    if (lastX === null || lastY === null) return
    const k = `${lastX},${lastY}`
    if (k === seenLast.current) return
    seenLast.current = k
    const cell = { x: lastX, y: lastY }
    const { w, h } = size()
    if (!isCellVisible(cell, offset.current, w, h, cs)) centerOn(cell, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read refs only
  }, [lastX, lastY, cs])

  const onRecenter = () => centerOn(last ? { x: last.x, y: last.y } : boundsCenter(moves), true)

  /**
   * Stops a running glide where it is on screen: `offset.current` holds the glide's target while the
   * CSS transition is still animating, so taps and drags must start from the live position.
   */
  const freeze = () => {
    const el = plane.current
    if (!el || !el.style.transition || el.style.transition === 'none') return
    const live = translateOf(getComputedStyle(el).transform)
    if (live) setOffset(live)
    else el.style.transition = 'none'
  }

  const setGrabbing = (on: boolean) => {
    if (viewport.current) viewport.current.style.cursor = on ? 'grabbing' : ''
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    freeze()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, from: offset.current, panning: false }
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.panning && isTap(dx, dy)) return
    if (!d.panning) setGrabbing(true)
    d.panning = true // once past the slop it stays a pan, even if the pointer comes back
    setOffset({ x: d.from.x + dx, y: d.from.y + dy })
  }

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setGrabbing(false)
    if (d.panning || !isTap(e.clientX - d.sx, e.clientY - d.sy) || !canPlay) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cell = cellAtPoint(e.clientX - rect.left, e.clientY - rect.top, offset.current, cs)
    if (!cell || occupied.has(key(cell))) return
    onPlay(cell)
  }

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    setGrabbing(false)
  }

  const span = (BOARD_MAX - BOARD_MIN + 1) * cs
  const cellBox = (c: Cell) => ({
    left: c.x * cs,
    top: c.y * cs,
    width: cs,
    height: cs,
  })

  const highlightBox = (c: Cell, bg: string) => (
    <div
      className="absolute box-border"
      style={{
        ...cellBox(c),
        background: bg,
        borderRadius: CELL_RADIUS,
        border: '1px solid rgba(255,255,255,0.04)',
      }}
    />
  )

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-[22px] border border-line bg-[var(--caro-board)] p-3">
      <div
        ref={viewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className={`absolute inset-3 overflow-hidden rounded-[14px] select-none ${canPlay ? 'cursor-pointer' : 'cursor-grab'}`}
        style={{ touchAction: 'none' }}
      >
        <div ref={plane} className="absolute top-0 left-0" style={{ willChange: 'transform' }}>
          <div
            className="absolute"
            style={{
              left: BOARD_MIN * cs,
              top: BOARD_MIN * cs,
              width: span,
              height: span,
              backgroundColor: 'var(--caro-board)',
              backgroundImage:
                'linear-gradient(var(--caro-grid) 1px, transparent 1px), linear-gradient(90deg, var(--caro-grid) 1px, transparent 1px)',
              backgroundSize: `${cs}px ${cs}px`,
            }}
          />
          {[...winSet].map((k) => {
            const [x, y] = k.split(',').map(Number)
            return <div key={`w${k}`}>{highlightBox({ x, y }, WIN_BG)}</div>
          })}
          {last && !winSet.has(key(last)) && (
            <div key="last-move">{highlightBox(last, LAST_MOVE_BG)}</div>
          )}
          {moves.map((m) => (
            <div
              key={key(m)}
              className="pointer-events-none absolute relative grid place-items-center"
              style={cellBox(m)}
            >
              <div
                className="absolute rounded-[9px] border border-white/5 bg-panel"
                style={{ width: cs - 6, height: cs - 6 }}
              />
              <Mark side={m.side} size={Math.round(cs * 0.72)} />
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        title="Recenter"
        aria-label="Recenter"
        onClick={onRecenter}
        className="absolute right-5 bottom-5 grid size-8 place-items-center rounded-[9px] border border-line bg-panel2 text-sm text-white"
      >
        ⌖
      </button>
    </div>
  )
}
