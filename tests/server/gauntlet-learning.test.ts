import { describe, expect, it } from 'vitest'
import { createGauntletLearning, learnableBotSide } from '@/src/server/gauntlet-learning'
import { MemoryGauntletBookStore } from '@/src/server/gauntlet-book-store'
import { createRoom, markReady, setBotLevel, setFormat, startRoom } from '@/src/tournament/room'
import type { Match, Player, Room } from '@/src/tournament/types'
import type { Move } from '@/src/game/types'
import { mulberry, user } from '../tournament/helpers'

const T0 = 1_000_000
const START = T0 + 100
const rng = mulberry(42)

const BOT_ID = 'bot:gauntlet'

const isBot = (room: Room, id: string | null) => room.players.find((player) => player.userId === id)?.isBot ?? false
const match = (room: Room): Match => room.matches[0]

function botRoom(level: 'duel' | 'gauntlet'): Room {
  let room = createRoom({ code: 'ABCDEF', host: user(0), now: T0 })
  room = setBotLevel(setFormat(room, 'u0', 'free'), 'u0', level)
  room = startRoom(room, 'u0', START, mulberry(1))
  const current = room.matches[0]
  for (const id of [current.X, current.O]) {
    if (id && !isBot(room, id)) room = markReady(room, current.id, id, START, rng)
  }
  return room
}

function players(): Player[] {
  return [
    { ...user(0), isBot: false, seed: null, joinedAt: T0 },
    { userId: BOT_ID, name: 'Gauntlet Bot', avatarUrl: null, isBot: true, seed: null, joinedAt: T0 },
  ]
}

function moves(): Move[] {
  return [
    { x: 0, y: 0, side: 'X', at: START + 1_000 },
    { x: 1, y: 1, side: 'O', at: START + 2_000 },
    { x: 2, y: 0, side: 'X', at: START + 3_000 },
    { x: 1, y: -1, side: 'O', at: START + 4_000 },
    { x: 3, y: 2, side: 'X', at: START + 5_000 },
    { x: 4, y: 4, side: 'O', at: START + 6_000 },
  ]
}

function syntheticRoom(level: 'duel' | 'gauntlet', games: Match['games'], currentMoves: Move[] = moves()): Room {
  return {
    _id: 'ABCDEF',
    name: 'Synthetic Room',
    hostId: 'u0',
    status: 'running',
    mode: 'free',
    bestOf: 1,
    botLevel: level,
    players: players(),
    totalRounds: 1,
    matches: [
      {
        id: 'MATCH1',
        round: 0,
        slot: 0,
        kind: 'normal',
        a: 'u0',
        b: BOT_ID,
        X: 'u0',
        O: BOT_ID,
        status: 'playing',
        pendingSince: null,
        startedAt: START,
        readyAt: { X: START, O: START },
        moves: currentMoves,
        games,
        nextGameAt: null,
        rematch: games.length > 0 ? { since: START + 7_000, ready: [BOT_ID] } : null,
        turnDeadlineAt: null,
        botMoveDueAt: currentMoves.length % 2 === 1 ? START + 8_000 : null,
        winner: null,
        endReason: null,
        winLine: null,
        finishedAt: null,
      },
    ],
    placements: { first: null, second: null, third: null },
    version: 0,
    createdAt: T0,
    startedAt: START,
    finishedAt: null,
    expiresAt: new Date(START + 60_000),
  }
}

describe('learnableBotSide', () => {
  it('finds the gauntlet bot side but ignores duel rooms', () => {
    const gauntlet = botRoom('gauntlet')
    expect(learnableBotSide(gauntlet, match(gauntlet))).toBe(isBot(gauntlet, match(gauntlet).X) ? 'X' : 'O')

    const duel = botRoom('duel')
    expect(learnableBotSide(duel, match(duel))).toBeNull()
  })
})

describe('learnFromWrite', () => {
  it('records a finished gauntlet game only once', async () => {
    const store = new MemoryGauntletBookStore()
    const learning = createGauntletLearning(store, () => {})
    const before = syntheticRoom('gauntlet', [])
    const after = syntheticRoom('gauntlet', [{ winner: 'u0', endReason: 'five_in_row', finishedAt: START + 6_000 }])

    await learning.learnFromWrite(before, after, START + 9_000)

    expect(store.games.size).toBe(1)
    expect([...store.games.keys()]).toEqual(['ABCDEF:MATCH1:1'])
    expect(store.books.size).toBeGreaterThan(0)

    const firstSnapshot = JSON.stringify([...store.books.values()])
    await learning.learnFromWrite(before, after, START + 9_000)

    expect(store.games.size).toBe(1)
    expect(JSON.stringify([...store.books.values()])).toBe(firstSnapshot)
  })

  it('ignores duel games', async () => {
    const store = new MemoryGauntletBookStore()
    const learning = createGauntletLearning(store, () => {})
    const before = syntheticRoom('duel', [])
    const after = syntheticRoom('duel', [{ winner: 'u0', endReason: 'five_in_row', finishedAt: START + 6_000 }])

    await learning.learnFromWrite(before, after, START + 9_000)

    expect(store.games.size).toBe(0)
    expect(store.books.size).toBe(0)
  })
})

describe('hintsFor', () => {
  it('returns undefined when the book store does not answer in time', async () => {
    const slowStore = {
      getBook: () => new Promise<null>(() => {}),
      insertGame: async () => true,
      applyDeltas: async () => {},
    }
    const learning = createGauntletLearning(slowStore, () => {})
    const room = syntheticRoom('gauntlet', [], moves().slice(0, 3))
    const current = match(room)
    const startedAt = Date.now()

    await expect(learning.hintsFor(room, current)).resolves.toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
