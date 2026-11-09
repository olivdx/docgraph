/** Pure fleet rules, shared by the server (validation, shots) and the client (placement). */
import { RoomError } from '@/src/tournament/types'
import { CELLS, FLEET, N } from './constants'
import type { Ship, ShipKey, Shot, ShotResult } from './types'

const rowOf = (c: number) => Math.floor(c / N)
const colOf = (c: number) => c % N

/** A ship of `len` cells starting at `origin`, going right (horiz) or down; null if it leaves the board. */
export function shipCells(len: number, origin: number, horiz: boolean): number[] | null {
  const r = rowOf(origin)
  const c = colOf(origin)
  if (horiz ? c + len > N : r + len > N) return null
  return Array.from({ length: len }, (_, k) => (horiz ? origin + k : origin + k * N))
}

/** A ship centred on `cell` (offset floor((len-1)/2)), shifted to stay inside the board. */
export function centeredCells(len: number, cell: number, horiz: boolean): number[] {
  const off = Math.floor((len - 1) / 2)
  const clamp = (v: number) => Math.min(Math.max(v, 0), N - len)
  const r = horiz ? rowOf(cell) : clamp(rowOf(cell) - off)
  const c = horiz ? clamp(colOf(cell) - off) : colOf(cell)
  return shipCells(len, r * N + c, horiz)!
}

const bad = () => new RoomError('bad_fleet')

function isStraight(cells: number[], len: number): boolean {
  if (cells.length !== len) return false
  if (!cells.every((c) => Number.isInteger(c) && c >= 0 && c < CELLS)) return false
  const sorted = [...cells].sort((x, y) => x - y)
  const horiz = shipCells(len, sorted[0], true)
  const vert = shipCells(len, sorted[0], false)
  const same = (a: number[] | null) => !!a && a.every((v, i) => v === sorted[i])
  return same(horiz) || same(vert)
}

/** Throws bad_fleet unless `ships` is a valid (partial, or with `complete` the full) fleet. */
export function validateFleet(ships: Ship[], complete: boolean): void {
  const seen = new Set<ShipKey>()
  const used = new Set<number>()
  for (const s of ships) {
    const def = FLEET.find((d) => d.key === s.key)
    if (!def || seen.has(s.key)) throw bad()
    seen.add(s.key)
    if (!Array.isArray(s.cells) || !isStraight(s.cells, def.len)) throw bad()
    for (const c of s.cells) {
      if (used.has(c)) throw bad()
      used.add(c)
    }
  }
  if (complete && seen.size !== FLEET.length) throw bad()
}

/** Cells taken by `ships` plus (with `halo`) every neighbour of them. */
function blocked(ships: Ship[], halo: boolean): Set<number> {
  const out = new Set<number>()
  for (const s of ships) {
    for (const c of s.cells) {
      if (!halo) {
        out.add(c)
        continue
      }
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = rowOf(c) + dr
          const col = colOf(c) + dc
          if (r >= 0 && r < N && col >= 0 && col < N) out.add(r * N + col)
        }
      }
    }
  }
  return out
}

/**
 * A full fleet that keeps `keep` exactly. Missing ships are placed in FLEET order, preferring spots
 * that neither overlap nor touch other ships (looks cleaner), else any spot that doesn't overlap.
 */
export function randomFleet(rng: () => number, keep: Ship[] = []): Ship[] {
  const fleet: Ship[] = keep.map((s) => ({ key: s.key, cells: [...s.cells] }))
  for (const def of FLEET) {
    if (fleet.some((s) => s.key === def.key)) continue
    let placed: number[] | null = null
    for (let attempt = 0; attempt < 400 && !placed; attempt++) {
      const strict = attempt < 200
      const horiz = rng() < 0.5
      const cells = shipCells(def.len, Math.floor(rng() * CELLS), horiz)
      if (!cells) continue
      const taken = blocked(fleet, strict)
      if (cells.every((c) => !taken.has(c))) placed = cells
    }
    if (!placed) {
      // Exhaustive fallback (practically unreachable on a 6×6 board with 7 cells).
      const taken = blocked(fleet, false)
      outer: for (let o = 0; o < CELLS; o++) {
        for (const horiz of [true, false]) {
          const cells = shipCells(def.len, o, horiz)
          if (cells && cells.every((c) => !taken.has(c))) {
            placed = cells
            break outer
          }
        }
      }
    }
    fleet.push({ key: def.key, cells: placed! })
  }
  return FLEET.map((d) => fleet.find((s) => s.key === d.key)!)
}

/** Result of a shot at `cell` against `fleet`, given the shots already fired at it. */
export function resolveShot(fleet: Ship[], prior: Shot[], cell: number): { result: ShotResult; shipKey: ShipKey | null } {
  const ship = fleet.find((s) => s.cells.includes(cell))
  if (!ship) return { result: 'miss', shipKey: null }
  const hit = new Set(prior.filter((p) => p.result !== 'miss').map((p) => p.cell))
  hit.add(cell)
  return { result: ship.cells.every((c) => hit.has(c)) ? 'sunk' : 'hit', shipKey: ship.key }
}

/** True when every cell of `fleet` has been hit by `shots`. */
export function fleetSunk(fleet: Ship[], shots: Shot[]): boolean {
  const hit = new Set(shots.filter((s) => s.result !== 'miss').map((s) => s.cell))
  return fleet.length > 0 && fleet.every((s) => s.cells.every((c) => hit.has(c)))
}

export function sunkKeys(shots: Shot[]): Set<ShipKey> {
  return new Set(shots.filter((s) => s.result === 'sunk' && s.shipKey).map((s) => s.shipKey!))
}
