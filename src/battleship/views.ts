/**
 * What clients see. Hidden information lives here: an opponent's ships are sent only once sunk (or
 * when the match is over), and a shot's ship key only once that ship sank.
 */
import { roundName } from '@/src/tournament/bracket'
import { RoomError } from '@/src/tournament/types'
import { DISCONNECT_DETECT_MS, MIN_PLAYERS, NO_SHOW_MS, RECONNECT_GRACE_MS, TURN_MS } from './constants'
import { sunkKeys } from './fleet'
import { otherSeat, SEATS, seatOf, type Presence } from './match'
import { isActiveBattle } from './room'
import type {
  BattleEndReason,
  BattleMatch,
  BattleMatchStatus,
  BattleRoom,
  BattleRoomStatus,
  Seat,
  Ship,
  ShipKey,
  ShotResult,
} from './types'

export interface BattleSummary {
  code: string
  name: string
  hostName: string
  status: BattleRoomStatus
  playerCount: number
  youAreIn: boolean
  liveLabel: string | null
}

export interface BattleBracketMatch {
  id: string
  a: { name: string } | null
  b: { name: string } | null
  winner: Seat | null
  status: BattleMatchStatus
  endReason: BattleEndReason | null
  isYours: boolean
}

export interface BattleRoomView {
  code: string
  name: string
  status: BattleRoomStatus
  isHost: boolean
  /** In the lobby, or still in the running cup (not knocked out, not left): can Leave. */
  youAreIn: boolean
  players: { name: string; avatarUrl: string | null; isHost: boolean }[]
  minPlayers: number
  rounds: { name: string; matches: BattleBracketMatch[] }[]
  yourMatch: { id: string; opponentName: string } | null
  placements: { first: string | null; second: string | null; third: string | null }
  inviteUrl: string
  serverNow: number
}

export interface ShotView {
  cell: number
  result: ShotResult
  /** Only for `sunk`: a hit never tells which ship it struck. */
  shipKey: ShipKey | null
  auto: boolean
}

export type NextStep = 'wait' | 'next_match' | 'eliminated' | 'champion' | 'podium'

export interface BattleMatchView {
  id: string
  roundName: string
  status: BattleMatchStatus
  you: Seat | null
  players: Record<Seat, { name: string; avatarUrl: string | null } | null>
  /** Ships the viewer may see: their own, the opponent's sunk ones, everything once finished. */
  fleets: Record<Seat, Ship[]>
  /** Who has pressed Ready: the match starts (fleet placement) once both have. */
  ready: Record<Seat, boolean>
  locked: Record<Seat, boolean>
  /** Shots fired BY each seat. */
  shots: Record<Seat, ShotView[]>
  turn: Seat | null
  /** The turn clock without the post-shot animation grace (at most TURN_MS). */
  turnRemainingMs: number | null
  placingRemainingMs: number | null
  pendingRemainingMs: number | null
  missedTurns: Record<Seat, number>
  opponentDisconnected: boolean
  opponentReconnectRemainingMs: number | null
  winner: Seat | null
  endReason: BattleEndReason | null
  nextStep: NextStep
  nextMatchId: string | null
  serverNow: number
  /** The room's write counter: orders two views of the match (clocks can't, see isNewerView). */
  version: number
}

const LIVE: BattleMatchStatus[] = ['pending', 'placing', 'playing']

function nameOf(room: Pick<BattleRoom, 'players'>, userId: string | null): string {
  return room.players.find((p) => p.userId === userId)?.name ?? '?'
}

export function toBattleSummary(room: BattleRoom, viewerId: string): BattleSummary {
  let liveLabel: string | null = null
  if (room.status === 'running') {
    const open = room.matches.filter((m) => m.kind === 'normal' && m.status !== 'finished')
    if (open.length > 0) {
      const round = Math.min(...open.map((m) => m.round))
      liveLabel = `${roundName(round, room.totalRounds, 'normal')} live`
    }
  }
  return {
    code: room._id,
    name: room.name,
    hostName: nameOf(room, room.hostId),
    status: room.status,
    playerCount: room.players.length,
    youAreIn: isActiveBattle(room, viewerId),
    liveLabel,
  }
}

export function toBattleRoomView(room: BattleRoom, viewerId: string, now: number, inviteUrl: string): BattleRoomView {
  const entrant = (id: string | null) => (id ? { name: nameOf(room, id) } : null)
  const toBracket = (m: BattleMatch): BattleBracketMatch => ({
    id: m.id,
    a: entrant(m.a),
    b: entrant(m.b),
    winner: m.status === 'finished' ? m.winner : null,
    status: m.status,
    endReason: m.endReason,
    isYours: m.a === viewerId || m.b === viewerId,
  })
  const rounds: BattleRoomView['rounds'] = []
  for (let r = 0; r < room.totalRounds; r++) {
    const ms = room.matches.filter((m) => m.kind === 'normal' && m.round === r).sort((x, y) => x.slot - y.slot)
    rounds.push({ name: roundName(r, room.totalRounds, 'normal'), matches: ms.map(toBracket) })
  }
  const third = room.matches.find((m) => m.kind === 'third_place')
  if (third) rounds.push({ name: '3rd Place', matches: [toBracket(third)] })

  const mine = room.matches.find((m) => (m.a === viewerId || m.b === viewerId) && LIVE.includes(m.status))
  const pl = (id: string | null) => (id ? nameOf(room, id) : null)
  return {
    code: room._id,
    name: room.name,
    status: room.status,
    isHost: room.hostId === viewerId,
    youAreIn: isActiveBattle(room, viewerId),
    players: room.players.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, isHost: p.userId === room.hostId })),
    minPlayers: MIN_PLAYERS,
    rounds,
    yourMatch: mine ? { id: mine.id, opponentName: nameOf(room, mine.a === viewerId ? mine.b : mine.a) } : null,
    placements: { first: pl(room.placements.first), second: pl(room.placements.second), third: pl(room.placements.third) },
    inviteUrl,
    serverNow: now,
  }
}

function nextStepFor(room: BattleRoom, m: BattleMatch, you: Seat | null): NextStep {
  if (m.status !== 'finished') return 'wait'
  if (!you || !m.winner) return 'eliminated'
  const won = m.winner === you
  if (m.kind === 'third_place') return won ? 'podium' : 'eliminated'
  if (m.round === room.totalRounds - 1) return won ? 'champion' : 'podium'
  if (won) return 'next_match'
  const hasThird = room.matches.some((x) => x.kind === 'third_place')
  return m.round === room.totalRounds - 2 && hasThird ? 'next_match' : 'eliminated'
}

export function toBattleMatchView(
  room: BattleRoom,
  matchId: string,
  viewerId: string,
  now: number,
  presence: Presence,
): BattleMatchView {
  const m = room.matches.find((x) => x.id === matchId)
  if (!m) throw new RoomError('not_found')
  const you = seatOf(m, viewerId)
  const done = m.status === 'finished'

  const visibleFleet = (seat: Seat): Ship[] => {
    if (done || you === seat) return m.fleets[seat].map((s) => ({ key: s.key, cells: [...s.cells] }))
    const sunk = sunkKeys(m.shots[otherSeat(seat)])
    return m.fleets[seat].filter((s) => sunk.has(s.key)).map((s) => ({ key: s.key, cells: [...s.cells] }))
  }
  const shotViews = (seat: Seat): ShotView[] =>
    m.shots[seat].map((s) => ({ cell: s.cell, result: s.result, shipKey: s.result === 'sunk' ? s.shipKey : null, auto: s.auto }))
  const playerOf = (id: string | null) => {
    const p = room.players.find((x) => x.userId === id)
    return p ? { name: p.name, avatarUrl: p.avatarUrl } : null
  }

  let opponentDisconnected = false
  let opponentReconnectRemainingMs: number | null = null
  if (you && (m.status === 'placing' || m.status === 'playing')) {
    const oppId = m[otherSeat(you)]
    if (oppId) {
      const lastSeen = presence?.[oppId] ?? m.placingStartedAt ?? now
      if (now - lastSeen > DISCONNECT_DETECT_MS) {
        opponentDisconnected = true
        opponentReconnectRemainingMs = Math.max(0, lastSeen + DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS - now)
      }
    }
  }

  const playing = m.status === 'playing'
  return {
    id: m.id,
    roundName: roundName(m.round, room.totalRounds, m.kind),
    status: m.status,
    you,
    players: { a: playerOf(m.a), b: playerOf(m.b) },
    fleets: { a: visibleFleet('a'), b: visibleFleet('b') },
      ready: { a: m.readyAt.a !== null, b: m.readyAt.b !== null },
    locked: { a: m.lockedAt.a !== null, b: m.lockedAt.b !== null },
    shots: { a: shotViews('a'), b: shotViews('b') },
    turn: playing ? m.turn : null,
    turnRemainingMs:
      playing && m.turnDeadlineAt !== null ? Math.min(TURN_MS, Math.max(0, m.turnDeadlineAt - now)) : null,
    placingRemainingMs:
      m.status === 'placing' && m.placingDeadlineAt !== null ? Math.max(0, m.placingDeadlineAt - now) : null,
    pendingRemainingMs:
      m.status === 'pending' && m.pendingSince !== null ? Math.max(0, m.pendingSince + NO_SHOW_MS - now) : null,
    missedTurns: { ...m.missedTurns },
    opponentDisconnected,
    opponentReconnectRemainingMs,
    winner: m.winner,
    endReason: m.endReason,
    nextStep: nextStepFor(room, m, you),
    nextMatchId:
      room.matches.find((x) => x.id !== m.id && (x.a === viewerId || x.b === viewerId) && LIVE.includes(x.status))?.id ??
      null,
    serverNow: now,
    version: room.version,
  }
}

export { SEATS }
