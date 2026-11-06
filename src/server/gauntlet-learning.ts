import { bookMove, isForcedPosition } from '@/src/game/bot-gauntlet'
import { canonicalPosition, deltasFromGame, gameId, hintsFromDoc, type GauntletHints, type GameRecord } from '@/src/game/gauntlet-learn'
import { sideToMove } from '@/src/game/rules'
import type { Side } from '@/src/game/types'
import { isBotId } from '@/src/tournament/match'
import { resolveBotLevel, type Match, type Room } from '@/src/tournament/types'
import type { GauntletBookStore } from './gauntlet-book-store'

export const HINT_TIMEOUT_MS = 150
const LEARN_REASONS = new Set<GameRecord['endReason']>(['five_in_row', 'resign'])
const BOOK_PLIES = 3

export interface GauntletLearning {
  hintsFor(room: Room, m: Match): Promise<GauntletHints | undefined>
  learnFromWrite(before: Room, after: Room, now: number): Promise<void>
}

export function learnableBotSide(room: Room, m: Match): Side | null {
  if (resolveBotLevel(room) !== 'gauntlet') return null
  const xBot = isBotId(room, m.X)
  const oBot = isBotId(room, m.O)
  if (xBot === oBot) return null
  return xBot ? 'X' : 'O'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), ms)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      () => {
        clearTimeout(timeout)
        resolve(undefined)
      },
    )
  })
}

const defaultLog = (message: string, error?: unknown) => console.warn(`[gauntlet-learn] ${message}`, error ?? '')

export function createGauntletLearning(store: GauntletBookStore, log = defaultLog): GauntletLearning {
  return {
    async hintsFor(room, m) {
      const botSide = learnableBotSide(room, m)
      if (!botSide || m.status !== 'playing' || m.botMoveDueAt === null) return undefined
      if (m.moves.length < BOOK_PLIES || sideToMove(m.moves) !== botSide) return undefined
      const pos = canonicalPosition(m.moves)
      try {
        const doc = await withTimeout(store.getBook(pos.key, botSide), HINT_TIMEOUT_MS)
        if (doc === undefined) return undefined
        return hintsFromDoc(doc, pos)
      } catch (error) {
        log('hintsFor failed', error)
        return undefined
      }
    },

    async learnFromWrite(before, after, now) {
      try {
        for (const current of after.matches) {
          const botSide = learnableBotSide(after, current)
          if (!botSide) continue

          const previous = before.matches.find((match) => match.id === current.id)
          const previousGames = previous?.games.length ?? 0
          if (current.games.length !== previousGames + 1) continue
          if (previous && current.moves.length < previous.moves.length) continue

          const game = current.games.at(-1)
          if (!game || !LEARN_REASONS.has(game.endReason as GameRecord['endReason'])) continue

          const winnerSide: Side = game.winner === current.X ? 'X' : 'O'
          if (game.endReason === 'resign' && winnerSide !== botSide) continue

          const record: GameRecord = {
            _id: gameId(after._id, current.id, current.games.length),
            roomCode: after._id,
            matchId: current.id,
            gameIndex: current.games.length,
            moves: current.moves,
            botSide,
            winnerSide,
            endReason: game.endReason as GameRecord['endReason'],
            createdAt: now,
          }
          if (!(await store.insertGame(record))) continue

          const deltas = deltasFromGame(record, isForcedPosition, (moves, side) => bookMove(moves, side) !== null)
          await store.applyDeltas(deltas, now)
        }
      } catch (error) {
        log('learnFromWrite failed', error)
      }
    },
  }
}
