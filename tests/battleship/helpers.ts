import type { Ship } from '@/src/battleship/types'

/** A valid 10×10 fleet: ghost 5, galleon 4 (vertical), frigate 3, brig 3 (vertical), sloop 2. */
export const FLEET_A: Ship[] = [
  { key: 'ghost', cells: [0, 1, 2, 3, 4] },
  { key: 'galleon', cells: [20, 30, 40, 50] },
  { key: 'frigate', cells: [22, 23, 24] },
  { key: 'brig', cells: [62, 72, 82] },
  { key: 'sloop', cells: [98, 99] },
]
export const SHIP_CELLS = FLEET_A.flatMap((s) => s.cells)
export const WATER = Array.from({ length: 100 }, (_, i) => i).filter((c) => !SHIP_CELLS.includes(c))
