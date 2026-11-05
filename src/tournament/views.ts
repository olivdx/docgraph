import { sideToMove } from '@/src/game/rules'
import type { Cell, Move, Side } from '@/src/game/types'
import { roundName } from './bracket'
import { DISCONNECT_DETECT_MS, NO_SHOW_MS, RECONNECT_GRACE_MS, REMATCH_WAIT_MS } from './constants'
import { gameNumber, gameWins, isBotId, isFreePlay, opposite, sideOf, winsNeeded, type Presence } from './match'
import { isActive } from './room'
import {
  RoomError,
  type BestOf,
  type EndReason,
  type ListedRoom,
  type Match,
  type MatchStatus,
  type Room,
  type RoomMode,
  type RoomStatus,
  type BotLevel,
  resolveBotLevel,
} from './types'

export interface Entrant {
  name: string
  seed: number | null
  isBot: boolean
}

export interface RoomSummary {
  code: string
  name: string
  hostName: string
  status: RoomStatus
  playerCount: number
  youAreIn: boolean
  liveLabel: string | null
}

export interface BracketMatchView {
  id: string
  a: Entrant | null
  b: Entrant | null
  /** Games won (a forfeit credits the winner with the games needed); null before any game ended. */
  scoreA: number | null
  scoreB: number | null
  winner: 'a' | 'b' | null
  status: MatchStatus
  isYours: boolean
}

export interface RoomView {
  code: string
  name: string
  status: RoomStatus
  mode: RoomMode
  bestOf: BestOf
  botLevel: BotLevel
  isHost: boolean
  players: { name: string; avatarUrl: string | null; isBot: boolean; seed: number | null; isHost: boolean }[]
  slotsIfStartedNow: number
  botsIfStartedNow: number
  rounds: { name: string; matches: BracketMatchView[] }[]
  yourMatch: { id: string; opponentName: string; youAre: Side } | null
  placements: { first: string | null; second: string | null; third: string | null }
  inviteUrl: string
  serverNow: number
}

export type NextStep = 'wait' | 'next_match' | 'eliminated' | 'champion' | 'podium'

export interface MatchView {
  id: string
  roundName: string
  status: MatchStatus
  you: Side | null
  players: { X: { name: string; isBot: boolean } | null; O: { name: string; isBot: boolean } | null }
  moves: Move[]
  mode: RoomMode
  bestOf: BestOf
  /** 1-based game number (during a break: the game just finished). */
  gameNo: number
  /** Games won, by side in the current game (a cup forfeit credits the winner with the games needed). */
  score: { X: number; O: number }
  /** Between games (Bo3 break or free-play rematch wait): who won the game just finished, and how. */
  lastGame: { winner: Side; endReason: EndReason } | null
  nextGameRemainingMs: number | null
  /** Free play, waiting for a rematch: who has accepted (a spectator is never `you`) and the time left. */
  rematch: { you: boolean; opponent: boolean; remainingMs: number } | null
  /** null when no one is to move (not playing, or a break between games). */
  turn: Side | null
  turnRemainingMs: number | null
  pendingRemainingMs: number | null
  opponentDisconnected: boolean
  opponentReconnectRemainingMs: number | null
  winner: Side | null
  endReason: EndReason | null
  winLine: Cell[] | null
  nextStep: NextStep
  /** The viewer's pending|playing match in this room other than this one (where to go next), else null. */
  nextMatchId: string | null
  serverNow: number
}

/**
 * Games won by `userId` as shown: once a cup match is decided, the winner shows at least the games
 * needed. Free play always shows the real count.
 */
function shownWins(room: Pick<Room, 'bestOf' | 'mode'>, m: Match, userId: string | null): number {
  const wins = gameWins(m, userId)
  if (isFreePlay(room)) return wins
  const won = m.status === 'finished' && m.winner !== null && m[m.winner] === userId
  return won ? Math.max(wins, winsNeeded(room)) : wins
}

function nameOf(room: Pick<Room, 'players'>, userId: string | null): string {
  return room.players.find((p) => p.userId === userId)?.name ?? '?'
}

function entrant(room: Room, userId: string | null): Entrant | null {
  const p = room.players.find((x) => x.userId === userId)
  return p ? { name: p.name, seed: p.seed, isBot: p.isBot } : null
}

/** Works on a full Room or a listed one (no moves). */
export function toRoomSummary(room: ListedRoom, viewerId: string): RoomSummary {
  let liveLabel: string | null = null
  if (room.status === 'running' && isFreePlay(room)) {
    liveLabel = 'Free play live'
  } else if (room.status === 'running') {
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
    youAreIn: isActive(room, viewerId),
    liveLabel,
  }
}

export function toRoomView(room: Room, viewerId: string, now: number, inviteUrl: string): RoomView {
  const humans = room.players.filter((p) => !p.isBot).length
  let slots = 2
  while (slots < humans) slots *= 2

  const rounds: RoomView['rounds'] = []
  const toBracket = (m: Match): BracketMatchView => {
    const decided = m.status === 'finished' && m.winner !== null
    const scored = decided || (m.games ?? []).length > 0
    return {
      id: m.id,
      a: entrant(room, m.a),
      b: entrant(room, m.b),
      scoreA: scored ? shownWins(room, m, m.a) : null,
      scoreB: scored ? shownWins(room, m, m.b) : null,
      winner: decided ? (m[m.winner!] === m.a ? 'a' : 'b') : null,
      status: m.status,
      isYours: m.a === viewerId || m.b === viewerId,
    }
  }
  for (let r = 0; r < room.totalRounds; r++) {
    const ms = room.matches.filter((m) => m.kind === 'normal' && m.round === r).sort((x, y) => x.slot - y.slot)
    rounds.push({ name: roundName(r, room.totalRounds, 'normal'), matches: ms.map(toBracket) })
  }
  const third = room.matches.find((m) => m.kind === 'third_place')
  if (third) rounds.push({ name: '3rd Place', matches: [toBracket(third)] })

  const mine = room.matches.find((m) => (m.a === viewerId || m.b === viewerId) && (m.status === 'pending' || m.status === 'playing'))
  const yourMatch = mine
    ? { id: mine.id, opponentName: nameOf(room, mine.a === viewerId ? mine.b : mine.a), youAre: (sideOf(mine, viewerId) ?? 'X') as Side }
    : null

  const pl = (id: string | null) => (id ? nameOf(room, id) : null)
  return {
    code: room._id,
    name: room.name,
    status: room.status,
    mode: room.mode ?? 'cup',
    bestOf: room.bestOf ?? 1,
    botLevel: resolveBotLevel(room),
    isHost: room.hostId === viewerId,
    players: room.players.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, isBot: p.isBot, seed: p.seed, isHost: p.userId === room.hostId })),
    slotsIfStartedNow: slots,
    botsIfStartedNow: slots - humans,
    rounds,
    yourMatch,
    placements: { first: pl(room.placements.first), second: pl(room.placements.second), third: pl(room.placements.third) },
    inviteUrl,
    serverNow: now,
  }
}

function nextStepFor(room: Room, m: Match, you: Side | null): NextStep {
  if (m.status !== 'finished') return 'wait'
  if (!you || !m.winner) return 'eliminated'
  const won = m.winner === you
  if (m.kind === 'third_place') return won ? 'podium' : 'eliminated'
  if (m.round === room.totalRounds - 1) return won ? 'champion' : 'podium'
  if (won) return 'next_match'
  const hasThird = room.matches.some((x) => x.kind === 'third_place')
  return m.round === room.totalRounds - 2 && hasThird ? 'next_match' : 'eliminated'
}

export function toMatchView(room: Room, matchId: string, viewerId: string, now: number, presence: Presence): MatchView {
  const m = room.matches.find((x) => x.id === matchId)
  if (!m) throw new RoomError('not_found')
  const you = sideOf(m, viewerId)
  const side = (id: string | null) => {
    const p = room.players.find((x) => x.userId === id)
    return p ? { name: p.name, isBot: p.isBot } : null
  }

  const playing = m.status === 'playing'
  const onBreak = playing && m.nextGameAt != null
  const awaitingRematch = playing && m.rematch != null
  const turn = playing && !onBreak && !awaitingRematch ? sideToMove(m.moves) : null
  const humanToMove = turn !== null && !isBotId(room, m[turn])
  const turnRemainingMs = turn !== null && humanToMove && m.turnDeadlineAt !== null ? Math.max(0, m.turnDeadlineAt - now) : null
  const pendingRemainingMs = m.status === 'pending' && m.pendingSince !== null ? Math.max(0, m.pendingSince + NO_SHOW_MS - now) : null

  let opponentDisconnected = false
  let opponentReconnectRemainingMs: number | null = null
  if (you && playing) {
    const oppId = m[opposite(you)]
    if (oppId && !isBotId(room, oppId)) {
      const lastSeen = presence?.[oppId] ?? m.startedAt ?? now
      if (now - lastSeen > DISCONNECT_DETECT_MS) {
        opponentDisconnected = true
        opponentReconnectRemainingMs = Math.max(0, lastSeen + DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS - now)
      }
    }
  }

  return {
    id: m.id,
    roundName: roundName(m.round, room.totalRounds, m.kind),
    status: m.status,
    you,
    players: { X: side(m.X), O: side(m.O) },
    moves: m.moves,
    mode: room.mode ?? 'cup',
    bestOf: room.bestOf ?? 1,
    gameNo: gameNumber(m),
    score: { X: shownWins(room, m, m.X), O: shownWins(room, m, m.O) },
    lastGame: onBreak || awaitingRematch ? lastGameOf(m) : null,
    nextGameRemainingMs: onBreak ? Math.max(0, m.nextGameAt! - now) : null,
    rematch: awaitingRematch
      ? {
          you: you !== null && m.rematch!.ready.includes(viewerId),
          opponent: you !== null && m.rematch!.ready.includes(m[opposite(you)] ?? ''),
          remainingMs: Math.max(0, m.rematch!.since + REMATCH_WAIT_MS - now),
        }
      : null,
    turn,
    turnRemainingMs,
    pendingRemainingMs,
    opponentDisconnected,
    opponentReconnectRemainingMs,
    winner: m.winner,
    endReason: m.endReason,
    winLine: m.winLine,
    nextStep: nextStepFor(room, m, you),
    nextMatchId:
      room.matches.find(
        (x) =>
          x.id !== m.id &&
          (x.a === viewerId || x.b === viewerId) &&
          (x.status === 'pending' || x.status === 'playing'),
      )?.id ?? null,
    serverNow: now,
  }
}

function lastGameOf(m: Match): MatchView['lastGame'] {
  const g = (m.games ?? []).at(-1)
  const side = g ? sideOf(m, g.winner) : null
  return g && side ? { winner: side, endReason: g.endReason } : null
}
