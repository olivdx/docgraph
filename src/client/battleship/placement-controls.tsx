'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { FLEET, N } from '@/src/battleship/constants'
import { centeredCells, randomFleet } from '@/src/battleship/fleet'
import type { Ship, ShipKey } from '@/src/battleship/types'
import type { BattleMatchView } from '@/src/battleship/views'
import type { BattleScene } from './scene'

const lenOf = (key: ShipKey) => FLEET.find((f) => f.key === key)!.len
const nameOf = (key: ShipKey) => FLEET.find((f) => f.key === key)!.name
const isHoriz = (cells: number[]) => cells.length < 2 || cells[1] - cells[0] === 1
const overlaps = (ships: Ship[], cells: number[], except: ShipKey) =>
  ships.some((s) => s.key !== except && s.cells.some((c) => cells.includes(c)))
const nextUnplaced = (ships: Ship[]): ShipKey | null => FLEET.find((f) => !ships.some((s) => s.key === f.key))?.key ?? null

export interface Placement {
  ships: Ship[]
  active: ShipKey | null
  last: ShipKey | null
  locked: boolean
  hint: string
  onPointerDown: (e: ReactPointerEvent<HTMLCanvasElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLCanvasElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLCanvasElement>) => void
  onPointerLeave: () => void
  select: (key: ShipKey) => void
  rotate: () => void
  rotateLast: () => void
  random: () => void
  ready: () => void
}

/**
 * Local fleet placement (tap or drag on your sea, rotate, random) mirrored to the server: every
 * change is saved unlocked (debounced), READY saves locked. Seeded once from the server view, so a
 * reload brings the placed ships back.
 */
export function usePlacement(opts: {
  scene: BattleScene | null
  view: BattleMatchView
  /** Resolves true when the server accepted the fleet. */
  save: (ships: Ship[], lock: boolean) => Promise<boolean>
  toast: (msg: string) => void
}): Placement {
  const { scene, view, save, toast } = opts
  const you = view.you!
  // READY locks the fleet locally at once: edits made before the server answers would never be saved.
  const [lockPending, setLockPending] = useState(false)
  const locked = view.locked[you] || lockPending
  const [ships, setShips] = useState<Ship[]>(() => view.fleets[you])
  const [active, setActive] = useState<ShipKey | null>(() => nextUnplaced(view.fleets[you]))
  const [last, setLast] = useState<ShipKey | null>(null)
  const horiz = useRef(true)
  const dragging = useRef(false)
  const ghost = useRef<{ cell: number; cells: number[]; ok: boolean } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Draw the seeded fleet once the scene exists.
  const seeded = useRef(false)
  useEffect(() => {
    if (!scene || seeded.current) return
    seeded.current = true
    scene.setFleet('me', ships)
  }, [scene, ships])

  const commit = useCallback(
    (next: Ship[]) => {
      setShips(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void save(next, false), 400)
    },
    [save],
  )
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  const showGhost = useCallback(
    (cell: number, key: ShipKey | null = active) => {
      if (!scene || !key || cell < 0) return
      const cells = centeredCells(lenOf(key), cell, horiz.current)
      const ok = !overlaps(ships, cells, key)
      ghost.current = { cell, cells, ok }
      scene.showGhost(key, cells, ok)
    },
    [scene, active, ships],
  )
  const hideGhost = useCallback(() => {
    ghost.current = null
    scene?.hideGhost()
  }, [scene])

  const place = useCallback(
    (key: ShipKey, cells: number[]) => {
      const next = [...ships.filter((s) => s.key !== key), { key, cells }]
      scene?.dropShip({ key, cells })
      setLast(key)
      setActive(nextUnplaced(next))
      commit(next)
    },
    [ships, scene, commit],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!scene || locked) return
      const cell = scene.pickCell(e.clientX, e.clientY, 'me')
      if (cell < 0) return
      const under = ships.find((s) => s.cells.includes(cell))
      let key = active
      if (under) {
        // Pick up a placed ship.
        horiz.current = isHoriz(under.cells)
        const rest = ships.filter((s) => s.key !== under.key)
        setShips(rest)
        scene.setFleet('me', rest)
        setActive(under.key)
        key = under.key
      }
      if (!key) return
      dragging.current = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
      showGhost(cell, key)
    },
    [scene, locked, ships, active, showGhost],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!scene || locked || !active) return
      if (e.pointerType !== 'mouse' && !dragging.current) return
      const cell = scene.pickCell(e.clientX, e.clientY, 'me')
      if (cell < 0) {
        if (!dragging.current) hideGhost()
        return
      }
      if (cell !== ghost.current?.cell) showGhost(cell)
    },
    [scene, locked, active, showGhost, hideGhost],
  )

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    const g = ghost.current
    if (g && active) {
      if (g.ok) {
        place(active, g.cells)
        hideGhost()
      } else {
        toast("Ships can't overlap")
      }
    }
  }, [active, place, hideGhost, toast])

  const onPointerLeave = useCallback(() => {
    if (!dragging.current) hideGhost()
  }, [hideGhost])

  const rotateLast = useCallback(() => {
    if (locked || !last) return
    const s = ships.find((x) => x.key === last)
    if (!s) return
    const len = lenOf(s.key)
    const mid = Math.floor((len - 1) / 2)
    const pivots = [s.cells[mid], ...s.cells.filter((_, k) => k !== mid)]
    for (const p of pivots) {
      const cells = centeredCells(len, p, !isHoriz(s.cells))
      if (!overlaps(ships, cells, s.key)) {
        horiz.current = !isHoriz(s.cells)
        place(s.key, cells)
        return
      }
    }
    toast(`No room to rotate the ${nameOf(s.key)}`)
  }, [locked, last, ships, place, toast])

  const rotate = useCallback(() => {
    if (locked) return
    if (ghost.current && active) {
      horiz.current = !horiz.current
      showGhost(ghost.current.cell)
      return
    }
    if (last && ships.some((s) => s.key === last)) {
      rotateLast()
      return
    }
    if (active) {
      horiz.current = !horiz.current
      showGhost(Math.floor(N / 2) * N + Math.floor(N / 2) - 1) // middle of your sea
    }
  }, [locked, active, last, ships, showGhost, rotateLast])

  const random = useCallback(() => {
    if (!scene || locked) return
    const next = randomFleet(Math.random)
    hideGhost()
    next.forEach((s) => scene.dropShip(s))
    setActive(null)
    setLast(next[next.length - 1].key)
    commit(next)
  }, [scene, locked, hideGhost, commit])

  const ready = useCallback(() => {
    if (locked || ships.length !== FLEET.length) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    hideGhost()
    setLockPending(true)
    void save(ships, true).then((accepted) => {
      if (!accepted) setLockPending(false)
    })
  }, [locked, ships, save, hideGhost])

  const select = useCallback(
    (key: ShipKey) => {
      if (locked) return
      const placed = ships.find((s) => s.key === key)
      if (placed) {
        horiz.current = isHoriz(placed.cells)
        const rest = ships.filter((s) => s.key !== key)
        setShips(rest)
        scene?.setFleet('me', rest)
        commit(rest)
      }
      setActive(key)
      hideGhost()
    },
    [locked, ships, scene, commit, hideGhost],
  )

  const hint = locked
    ? `Waiting for ${view.players[you === 'a' ? 'b' : 'a']?.name ?? 'your opponent'} to place their fleet`
    : active
      ? `Tap your sea to place the ${nameOf(active)}`
      : 'Fleet ready! Tap a ship to move it, ↻ to turn it, or press READY'

  return {
    ships,
    active,
    last,
    locked,
    hint,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    select,
    rotate,
    rotateLast,
    random,
    ready,
  }
}

/** Tray of ships over the bottom of the 3D stage. */
export function ShipTray({ p }: { p: Placement }) {
  return (
    <div className="absolute inset-x-2.5 bottom-2.5 flex gap-2">
      {FLEET.map((f) => {
        const placed = p.ships.some((s) => s.key === f.key)
        return (
          <button
            key={f.key}
            type="button"
            disabled={p.locked}
            onClick={() => p.select(f.key)}
            className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl border bg-[#0b1f33]/80 px-0.5 py-2 text-[11px] leading-tight font-bold text-white disabled:opacity-60 ${
              p.active === f.key ? 'border-amber-400 shadow-[0_0_0_2px_rgba(255,182,39,.45)]' : 'border-white/25'
            } ${placed ? 'opacity-60' : ''}`}
          >
            <span className="flex gap-0.5">
              {Array.from({ length: f.len }, (_, k) => (
                <i key={k} className={`block size-2 rounded-[2px] ${placed ? 'bg-emerald-400' : 'bg-white'}`} />
              ))}
            </span>
            {f.name}
          </button>
        )
      })}
    </div>
  )
}

/** Floating ↻ button kept above the last placed ship (positioned every frame, without re-rendering). */
export function FloatingRotate({ p, scene }: { p: Placement; scene: BattleScene | null }) {
  const btn = useRef<HTMLButtonElement>(null)
  const ship = p.last ? p.ships.find((s) => s.key === p.last) ?? null : null
  useEffect(() => {
    if (!scene || !ship || p.locked) return
    let raf = 0
    const tick = () => {
      const pt = scene.screenPointAbove('me', ship)
      const el = btn.current
      if (el && pt) {
        el.style.left = `${pt.x}px`
        el.style.top = `${pt.y}px`
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [scene, ship, p.locked])
  if (!ship || p.locked) return null
  return (
    <button
      ref={btn}
      type="button"
      onClick={p.rotateLast}
      aria-label={`Rotate the ${nameOf(ship.key)}`}
      className="absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[3px] border-white bg-amber-400 text-amber-950 shadow-[0_4px_0_#8a5600,0_8px_16px_rgba(0,0,0,.35)] active:scale-90"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M20.5 3.5v5h-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
