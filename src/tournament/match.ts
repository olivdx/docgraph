import { chooseBotMove } from '@/src/game/bot'
import type { GauntletHints } from '@/src/game/gauntlet-learn'
import { buildBoard, findWin, sideToMove } from '@/src/game/rules'
import type { Cell, Side } from '@/src/game/types'
import {
  BOT_DELAY_MAX_MS,
  BOT_DEFER_MAX_MS,
  BOT_DELAY_MIN_MS,
  DISCONNECT_DETECT_MS,
  GAME_BREAK_MS,
  MAX_BOT_GAME_MOVES,
  NO_SHOW_MS,
  RECONNECT_GRACE_MS,
  REMATCH_WAIT_MS,
  TURN_MS,
} from './constants'
import type { EndReason, Match, Room } from './types'
import { resolveBotLevel } from './types'

/**
 * Match-level state transitions. Every function here mutates the (already cloned) room it is
 * given; the public, non-mutating API lives in room.ts.
 *
 * Time model: an event driven by a deadline (turn timeout, disconnect, no-show, bot move) happens
 * AT that deadline's timestamp, not at the settle's `now`.
 *
 * `presence === null` means "presence unknown": disconnect deadlines are not evaluated.
 */
export type Presence = Record<string, number> | null

/**
 * Settle options. `fullBotMatchId` scopes full-strength bot searches (human-vs-bot moves):
 * - omitted / undefined: every match's due bot move is played (no scope);
 * - a match id: only that match's due bot move is played;
 * - null: no match's (room-level request).
 * An out-of-scope due bot move is left pending, and since it is that match's earliest due event the
 * match is not stepped further either (chronological order holds). Once it has been due for more
 * than BOT_DEFER_MAX_MS it is played regardless. Turn / disconnect / no-show deadlines, promotion
 * and bot-vs-bot games are never scoped.
 */
export interface SettleOpts {
  fullBotMatchId?: string | null
  /** Learned Gauntlet book for the bot's upcoming full-strength move (see gauntlet-learn). */
  hints?: GauntletHints
}

type Rng = () => number

export const opposite = (s: Side): Side => (s === 'X' ? 'O' : 'X')

export function isBotId(room: Room, userId: string | null): boolean {
  if (!userId) return false
  return room.players.find((p) => p.userId === userId)?.isBot ?? false
}

export function sideOf(m: Match, userId: string): Side | null {
  if (m.X === userId) return 'X'
  if (m.O === userId) return 'O'
  return null
}

export function botDelay(rng: Rng): number {
  return BOT_DELAY_MIN_MS + rng() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS)
}

function seedOf(room: Room, userId: string | null): number {
  return room.players.find((p) => p.userId === userId)?.seed ?? Number.MAX_SAFE_INTEGER
}

/** waiting → pending once both entrants are known. */
export function promoteIfReady(room: Room, m: Match, at: number, rng: Rng): boolean {
  if (m.status !== 'waiting' || !m.a || !m.b) return false
  const aBot = isBotId(room, m.a)
  const bBot = isBotId(room, m.b)
  let x: string
  if (aBot !== bBot) x = aBot ? m.b : m.a
  else if (!aBot) x = rng() < 0.5 ? m.a : m.b
  else x = m.a
  m.X = x
  m.O = x === m.a ? m.b : m.a
  m.status = 'pending'
  m.pendingSince = at
  m.readyAt = { X: isBotId(room, m.X) ? at : null, O: isBotId(room, m.O) ? at : null }
  return true
}

function advance(room: Room, m: Match, rng: Rng): void {
  const last = room.totalRounds - 1
  if (m.kind !== 'normal' || m.round >= last || !m.winner) return
  const winnerId = m[m.winner]
  const loserId = m[opposite(m.winner)]
  // Both the next match and (for semifinals) the 3rd-place match are fed by this match and its
  // sibling. Settle steps matches in array order, not time order, so the next match becomes
  // pending when the LATER of the two feeders finished — not when this one did.
  const sibling = room.matches.find(
    (x) => x.kind === 'normal' && x.round === m.round && x.slot === (m.slot ^ 1),
  )
  const at = Math.max(m.finishedAt ?? 0, sibling?.finishedAt ?? 0)
  const next = room.matches.find((x) => x.kind === 'normal' && x.round === m.round + 1 && x.slot === Math.floor(m.slot / 2))
  if (next) {
    if (m.slot % 2 === 0) next.a = winnerId
    else next.b = winnerId
    promoteIfReady(room, next, at, rng)
  }
  if (m.round === last - 1) {
    const third = room.matches.find((x) => x.kind === 'third_place')
    if (third) {
      if (m.slot === 0) third.a = loserId
      else third.b = loserId
      promoteIfReady(room, third, at, rng)
    }
  }
}

/** Game wins a player needs to take the match. */
export const winsNeeded = (room: Pick<Room, 'bestOf'>): number => ((room.bestOf ?? 1) === 3 ? 2 : 1)

/** Completed games won by `userId` in this match. */
export const gameWins = (m: Pick<Match, 'games'>, userId: string | null): number =>
  userId ? (m.games ?? []).filter((g) => g.winner === userId).length : 0

export const isFreePlay = (room: Pick<Room, 'mode'>): boolean => room.mode === 'free'

/** Between games: a Bo3 break or a free-play rematch wait. No one is to move. */
export const betweenGames = (m: Pick<Match, 'nextGameAt' | 'rematch'>): boolean => m.nextGameAt != null || m.rematch != null

/** 1-based number of the current game (between games or once finished: the last one played). */
export function gameNumber(m: Pick<Match, 'games' | 'nextGameAt' | 'rematch' | 'status'>): number {
  const played = (m.games ?? []).length
  return m.status === 'finished' || betweenGames(m) ? Math.max(1, played) : played + 1
}

/**
 * Ends the current game: records it, then either finishes the match (the winner has enough game
 * wins) or opens the break before the next game. A bot-vs-bot series skips the break and plays on
 * at once. Returns true if the match finished.
 */
function finishGame(
  room: Room,
  m: Match,
  winner: Side,
  reason: EndReason,
  at: number,
  rng: Rng,
  winLine: Cell[] | null = null,
): boolean {
  const winnerId = m[winner]!
  m.games.push({ winner: winnerId, endReason: reason, finishedAt: at })
  if (isFreePlay(room)) {
    // Free play never ends on a game: wait for a rematch (bots accept straight away).
    m.winLine = winLine
    m.turnDeadlineAt = null
    m.botMoveDueAt = null
    m.rematch = { since: at, ready: [m.X, m.O].filter((id): id is string => !!id && isBotId(room, id)) }
    return false
  }
  if (gameWins(m, winnerId) >= winsNeeded(room)) {
    finishMatch(room, m, winner, reason, at, rng, winLine)
    return true
  }
  m.winLine = winLine
  m.turnDeadlineAt = null
  m.botMoveDueAt = null
  m.nextGameAt = at + GAME_BREAK_MS
  if (isBotId(room, m.X) && isBotId(room, m.O)) return startNextGame(room, m, at, rng)
  return false
}

/** Clears the board, swaps sides and starts the next game at `at`. Returns true if the match finished (bot-vs-bot). */
function startNextGame(room: Room, m: Match, at: number, rng: Rng): boolean {
  ;[m.X, m.O] = [m.O, m.X]
  m.moves = []
  m.winLine = null
  m.nextGameAt = null
  m.rematch = null
  return beginGame(room, m, at, rng)
}

/** Free play: `userId` gives up the current game (the room goes on to the rematch wait). */
export function resignGame(room: Room, m: Match, userId: string, at: number, rng: Rng): void {
  const side = m.X === userId ? 'X' : 'O'
  finishGame(room, m, opposite(side), 'resign', at, rng)
}

/** Free play: `userId` accepts the rematch; once both players have, the next game starts at `at`. */
export function acceptRematchInPlace(room: Room, m: Match, userId: string, at: number, rng: Rng): void {
  if (!m.rematch) return
  if (!m.rematch.ready.includes(userId)) m.rematch.ready.push(userId)
  if ([m.X, m.O].every((id) => !!id && m.rematch!.ready.includes(id))) startNextGame(room, m, at, rng)
}

/**
 * Free play ends: the match (and so the room) finishes. The higher game score wins; on a tie the
 * player who stayed (`stayerId`) does, or, with nobody to prefer, the last game's winner.
 */
export function endFreePlay(room: Room, m: Match, stayerId: string | null, reason: EndReason, at: number, rng: Rng): void {
  const [x, o] = [gameWins(m, m.X), gameWins(m, m.O)]
  let winnerId: string | null
  if (x !== o) winnerId = x > o ? m.X : m.O
  else winnerId = stayerId ?? m.games.at(-1)?.winner ?? m.X
  const winLine = m.rematch ? m.winLine : null
  m.rematch = null
  finishMatch(room, m, winnerId === m.O ? 'O' : 'X', reason, at, rng, winLine)
}

/** Finish a match and advance its entrants exactly once. */
export function finishMatch(
  room: Room,
  m: Match,
  winner: Side,
  reason: EndReason,
  at: number,
  rng: Rng,
  winLine: Cell[] | null = null,
): void {
  if (m.status === 'finished') return
  m.status = 'finished'
  m.winner = winner
  m.endReason = reason
  m.winLine = winLine
  m.finishedAt = at
  m.turnDeadlineAt = null
  m.botMoveDueAt = null
  m.nextGameAt = null
  m.rematch = null
  advance(room, m, rng)
}

function scheduleNext(room: Room, m: Match, at: number, rng: Rng): void {
  const toMove = m[sideToMove(m.moves)]
  if (isBotId(room, toMove)) {
    m.turnDeadlineAt = null
    m.botMoveDueAt = at + botDelay(rng)
  } else {
    m.botMoveDueAt = null
    m.turnDeadlineAt = at + TURN_MS
  }
}

/** Places a stone and resolves a win. Returns true if the game ended. */
function placeStone(room: Room, m: Match, cell: Cell, side: Side, at: number, rng: Rng): boolean {
  const move = { x: cell.x, y: cell.y, side, at }
  m.moves.push(move)
  const win = findWin(buildBoard(m.moves), move)
  if (win) {
    finishGame(room, m, side, 'five_in_row', at, rng, win)
    return true
  }
  return false
}

/** Applies a move to a playing game, then sets the next deadline if the game goes on. */
export function applyMove(room: Room, m: Match, cell: Cell, side: Side, at: number, rng: Rng): void {
  if (!placeStone(room, m, cell, side, at, rng)) scheduleNext(room, m, at, rng)
}

function startPlaying(room: Room, m: Match, at: number, rng: Rng): void {
  m.status = 'playing'
  m.startedAt = at
  beginGame(room, m, at, rng)
}

/** Starts the current (empty) game at `at`. Returns true if the match finished (bot-vs-bot). */
function beginGame(room: Room, m: Match, at: number, rng: Rng): boolean {
  if (isBotId(room, m.X) && isBotId(room, m.O)) {
    // Bot vs bot: play the whole game right now, fast mode, no delays (a series recurses through
    // finishGame → startNextGame, at most three games deep).
    m.turnDeadlineAt = null
    m.botMoveDueAt = null
    for (;;) {
      if (m.moves.length >= MAX_BOT_GAME_MOVES) {
        finishGame(room, m, 'X', 'board_full', at, rng)
        return m.status === 'finished'
      }
      const side = sideToMove(m.moves)
      const cell = chooseBotMove(m.moves, side, { mode: 'fast', rng })
      if (placeStone(room, m, cell, side, at, rng)) return m.status === 'finished'
    }
  }
  scheduleNext(room, m, at, rng)
  return false
}

function disconnectDeadline(m: Match, presence: Record<string, number>, userId: string): number {
  const started = m.startedAt ?? 0
  return Math.max(presence[userId] ?? started, started) + DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS
}

type Due =
  | { at: number; kind: 'next_game' }
  | { at: number; kind: 'rematch_timeout' }
  | { at: number; kind: 'turn' }
  | { at: number; kind: 'disconnect'; side: Side }
  | { at: number; kind: 'bot' }

/** Applies at most one transition / event to the match. Returns true if something changed. */
export function stepMatch(
  room: Room,
  m: Match,
  presence: Presence,
  now: number,
  rng: Rng,
  opts?: SettleOpts,
): boolean {
  switch (m.status) {
    case 'waiting':
      return promoteIfReady(room, m, now, rng)

    case 'pending': {
      const { X, O } = m.readyAt
      if (X !== null && O !== null) {
        startPlaying(room, m, Math.max(X, O), rng)
        return true
      }
      const since = m.pendingSince ?? now
      if (now - since > NO_SHOW_MS) {
        let winner: Side
        if (X !== null) winner = 'X'
        else if (O !== null) winner = 'O'
        else winner = seedOf(room, m.X) < seedOf(room, m.O) ? 'X' : 'O'
        finishMatch(room, m, winner, 'no_show', since + NO_SHOW_MS, rng)
        return true
      }
      return false
    }

    case 'playing': {
      const due: Due[] = []
      if (m.nextGameAt != null && m.nextGameAt <= now) due.push({ at: m.nextGameAt, kind: 'next_game' })
      if (m.rematch && m.rematch.since + REMATCH_WAIT_MS <= now) {
        due.push({ at: m.rematch.since + REMATCH_WAIT_MS, kind: 'rematch_timeout' })
      }
      if (m.turnDeadlineAt !== null && m.turnDeadlineAt <= now) due.push({ at: m.turnDeadlineAt, kind: 'turn' })
      if (presence) {
        for (const side of ['X', 'O'] as const) {
          const id = m[side]
          if (!id || isBotId(room, id)) continue
          const at = disconnectDeadline(m, presence, id)
          // forfeit only when now − lastSeen > DISCONNECT_DETECT_MS + RECONNECT_GRACE_MS
          if (at < now) due.push({ at, kind: 'disconnect', side })
        }
      }
      if (m.botMoveDueAt !== null && m.botMoveDueAt <= now) due.push({ at: m.botMoveDueAt, kind: 'bot' })
      if (due.length === 0) return false
      // earliest wins; ties keep push order (next game, rematch timeout, turn, disconnect X, disconnect O, bot)
      const ev = due.reduce((best, d) => (d.at < best.at ? d : best))
      if (ev.kind === 'next_game') {
        startNextGame(room, m, ev.at, rng)
      } else if (ev.kind === 'rematch_timeout') {
        endFreePlay(room, m, m.rematch!.ready.find((id) => !isBotId(room, id)) ?? null, 'left', ev.at, rng)
      } else if (ev.kind === 'turn') {
        finishGame(room, m, opposite(sideToMove(m.moves)), 'turn_timeout', ev.at, rng)
      } else if (ev.kind === 'disconnect') {
        if (isFreePlay(room)) endFreePlay(room, m, m[opposite(ev.side)], 'disconnect_timeout', ev.at, rng)
        else finishMatch(room, m, opposite(ev.side), 'disconnect_timeout', ev.at, rng)
      } else {
        const scope = opts?.fullBotMatchId
        if (scope !== undefined && scope !== m.id && now - ev.at <= BOT_DEFER_MAX_MS) return false
        if (m.moves.length >= MAX_BOT_GAME_MOVES) {
          finishGame(room, m, 'X', 'board_full', ev.at, rng)
        } else {
          const side = sideToMove(m.moves)
          const cell = chooseBotMove(m.moves, side, {
            mode: 'full',
            level: resolveBotLevel(room),
            rng,
            hints: opts?.hints,
          })
          applyMove(room, m, cell, side, ev.at, rng)
        }
      }
      return true
    }

    default:
      return false
  }
}
