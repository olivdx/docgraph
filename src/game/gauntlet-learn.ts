import { BOARD_MAX, BOARD_MIN, type Cell, type Move, type Side } from './types'

/**
 * Learning support for the Gauntlet bot: positions are keyed by their canonical form, the
 * lexicographically smallest valid symmetry of the current stones.
 */

export type HintEntry = { w: number; n: number; wins: number; losses: number }
export type GauntletHints = Map<string, HintEntry>
export type BookDoc = { _id: string; side: Side; moves: Record<string, HintEntry>; updatedAt: number }
export type CanonicalPosition = { key: string; toCanon(c: Cell): Cell; fromCanon(c: Cell): Cell }
export type GameRecord = {
  _id: string
  roomCode: string
  matchId: string
  gameIndex: number
  moves: Move[]
  botSide: Side
  winnerSide: Side
  endReason: 'five_in_row' | 'resign'
  createdAt: number
}
export type BookDelta = { key: string; side: Side; cell: string; delta: number; won: boolean }

export const HINT_MIN_N = 3
export const HINT_BAN_W = -3
export const HINT_BONUS = 2000
export const HINT_BONUS_CAP = 20000

export const cellKey = (c: Cell): string => `${c.x},${c.y}`
export const bookId = (key: string, side: Side): string => `${key}:${side}`
export const gameId = (roomCode: string, matchId: string, gameIndex: number): string =>
  `${roomCode}:${matchId}:${gameIndex}`

type Stone = Pick<Move, 'x' | 'y' | 'side'>
type Symmetry = { toCanon: (c: Cell) => Cell; fromCanon: (c: Cell) => Cell }

const SYMMETRIES: Symmetry[] = [
  { toCanon: (c) => ({ x: c.x, y: c.y }), fromCanon: (c) => ({ x: c.x, y: c.y }) },
  { toCanon: (c) => ({ x: -c.y, y: c.x }), fromCanon: (c) => ({ x: c.y, y: -c.x }) },
  { toCanon: (c) => ({ x: -c.x, y: -c.y }), fromCanon: (c) => ({ x: -c.x, y: -c.y }) },
  { toCanon: (c) => ({ x: c.y, y: -c.x }), fromCanon: (c) => ({ x: -c.y, y: c.x }) },
  { toCanon: (c) => ({ x: -c.x, y: c.y }), fromCanon: (c) => ({ x: -c.x, y: c.y }) },
  { toCanon: (c) => ({ x: c.y, y: c.x }), fromCanon: (c) => ({ x: c.y, y: c.x }) },
  { toCanon: (c) => ({ x: c.x, y: -c.y }), fromCanon: (c) => ({ x: c.x, y: -c.y }) },
  { toCanon: (c) => ({ x: -c.y, y: -c.x }), fromCanon: (c) => ({ x: -c.y, y: -c.x }) },
]

const insideBoard = (c: Cell): boolean =>
  c.x >= BOARD_MIN && c.x <= BOARD_MAX && c.y >= BOARD_MIN && c.y <= BOARD_MAX

function fnv64(text: string): string {
  let lo = 0x811c9dc5
  let hi = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    lo = Math.imul(lo ^ ch, 0x01000193)
    hi = Math.imul(hi ^ ch, 0x5bd1e995) ^ (hi >>> 13)
  }
  return (lo >>> 0).toString(16).padStart(8, '0') + (hi >>> 0).toString(16).padStart(8, '0')
}

function serialize(stones: Stone[]): string {
  const part = (side: Side): string =>
    stones
      .filter((stone) => stone.side === side)
      .map((stone) => [stone.x, stone.y] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([x, y]) => `${x},${y}`)
      .join(';')
  return `X:${part('X')}|O:${part('O')}`
}

export function canonicalPosition(moves: Pick<Move, 'x' | 'y' | 'side'>[]): CanonicalPosition {
  let best: { serialized: string; symmetry: Symmetry } | null = null

  for (const symmetry of SYMMETRIES) {
    const mapped = moves.map((move) => ({ ...symmetry.toCanon(move), side: move.side }))
    if (!mapped.every(insideBoard)) continue
    const serialized = serialize(mapped)
    if (best === null || serialized < best.serialized) best = { serialized, symmetry }
  }

  const chosen = best ?? { serialized: serialize(moves), symmetry: SYMMETRIES[0] }
  return {
    key: fnv64(chosen.serialized),
    toCanon: chosen.symmetry.toCanon,
    fromCanon: chosen.symmetry.fromCanon,
  }
}

export function hintsFromDoc(doc: BookDoc | null, pos: CanonicalPosition): GauntletHints {
  const hints: GauntletHints = new Map()
  if (!doc) return hints
  for (const [key, entry] of Object.entries(doc.moves)) {
    const [x, y] = key.split(',').map(Number)
    hints.set(cellKey(pos.fromCanon({ x, y })), entry)
  }
  return hints
}

/**
 * One delta per bot move that was neither a book reply nor tactically forced. A won game credits
 * each such move +1; a lost game debits -(1 + 2*(i+1)/k), so the last free move carries -3.
 */
export function deltasFromGame(
  rec: GameRecord,
  isForced: (moves: Move[], side: Side) => boolean,
  inBook: (moves: Move[], side: Side) => boolean,
): BookDelta[] {
  const won = rec.winnerSide === rec.botSide
  const picked: { key: string; cell: string }[] = []
  for (let i = 0; i < rec.moves.length; i++) {
    const move = rec.moves[i]
    if (move.side !== rec.botSide) continue
    const before = rec.moves.slice(0, i)
    if (inBook(before, move.side) || isForced(before, move.side)) continue
    const pos = canonicalPosition(before)
    picked.push({ key: pos.key, cell: cellKey(pos.toCanon(move)) })
  }
  const k = picked.length
  return picked.map((pickedMove, i) => ({
    key: pickedMove.key,
    side: rec.botSide,
    cell: pickedMove.cell,
    delta: won ? 1 : -(1 + (2 * (i + 1)) / k),
    won,
  }))
}

/**
 * Drops cells the book has condemned (n >= HINT_MIN_N and w <= HINT_BAN_W); keeps all if none
 * would remain.
 */
export function filterByHints(cells: Cell[], hints: GauntletHints | undefined): Cell[] {
  if (!hints || hints.size === 0) return cells
  const kept = cells.filter((cell) => {
    const hint = hints.get(cellKey(cell))
    return !(hint && hint.n >= HINT_MIN_N && hint.w <= HINT_BAN_W)
  })
  return kept.length > 0 ? kept : cells
}

/** Root-score nudge for a cell: w * HINT_BONUS clamped to +/- HINT_BONUS_CAP; 0 when unknown. */
export function hintBonus(cell: Cell, hints: GauntletHints | undefined): number {
  const hint = hints?.get(cellKey(cell))
  if (!hint) return 0
  return Math.max(-HINT_BONUS_CAP, Math.min(HINT_BONUS_CAP, hint.w * HINT_BONUS))
}
