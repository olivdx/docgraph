import { describe, expect, it } from 'vitest'
import type { GauntletLearning } from '@/src/server/gauntlet-learning'
import { AUTOPILOT_USER_IDS, RoomService } from '@/src/server/room-service'
import { MemoryPresenceStore, MemoryRoomStore } from '@/src/server/stores'
import type { TelegramUser } from '@/src/server/telegram-auth'
import type { Move, Side } from '@/src/game/types'
import { RoomError } from '@/src/tournament/types'
import { mulberry } from '../tournament/helpers'

const T0 = 1_800_000_000_000
const OWNER: TelegramUser = { id: [...AUTOPILOT_USER_IDS][0], name: 'Owner', avatarUrl: null }
const OTHER: TelegramUser = { id: 'u2', name: 'Other', avatarUrl: null }

async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof RoomError) return e.code
    throw e
  }
  throw new Error('expected RoomError')
}

/** Owner vs another human in a started free-play match that both have opened. */
async function playingMatch() {
  const clock = { t: T0 }
  const rooms = new MemoryRoomStore()
  const hintCalls: { moves: Move[]; side: Side }[] = []
  const learning: GauntletLearning = {
    hintsFor: async () => undefined,
    hintsForPosition: async (moves, side) => {
      hintCalls.push({ moves, side })
      return undefined
    },
    learnFromWrite: async () => {},
  }
  const svc = new RoomService({
    rooms,
    presence: new MemoryPresenceStore(),
    now: () => clock.t,
    rng: mulberry(3),
    inviteUrl: () => '',
    learning,
  })
  const { code } = await svc.create(OWNER, 'Autopilot')
  await svc.setFormat(code, OWNER, 'free')
  await svc.join(code, OTHER)
  await svc.start(code, OWNER)
  const room = (await rooms.get(code))!
  const matchId = room.matches[0].id
  await svc.getMatch(code, matchId, OWNER)
  const v = await svc.getMatch(code, matchId, OTHER)
  expect(v.status).toBe('playing')
  const ownerSide: Side = room.matches[0].X === OWNER.id ? 'X' : 'O'
  const byside = { [ownerSide]: OWNER, [ownerSide === 'X' ? 'O' : 'X']: OTHER } as Record<Side, TelegramUser>
  return { svc, clock, code, matchId, ownerSide, byside, hintCalls }
}

describe('RoomService.autopilotMove', () => {
  it('refuses users outside the allow list with not_found, even on their own turn', async () => {
    const { svc, clock, code, matchId, ownerSide } = await playingMatch()
    if (ownerSide === 'X') {
      clock.t += 1000
      await svc.move(code, matchId, OWNER, { x: 0, y: 0 }, 0)
    }
    // Now it is OTHER's turn.
    expect(await errCode(svc.autopilotMove(code, matchId, OTHER))).toBe('not_found')
  })

  it("gives the owner a move on their turn and not_your_turn on the opponent's", async () => {
    const { svc, clock, code, matchId, ownerSide, byside } = await playingMatch()
    if (ownerSide === 'O') {
      expect(await errCode(svc.autopilotMove(code, matchId, OWNER))).toBe('not_your_turn')
      clock.t += 1000
      await svc.move(code, matchId, byside.X, { x: 0, y: 0 }, 0)
    }
    const moveNo = ownerSide === 'X' ? 0 : 1
    const res = await svc.autopilotMove(code, matchId, OWNER)
    expect(res.moveNo).toBe(moveNo)
    clock.t += 1000
    const v = await svc.move(code, matchId, OWNER, { x: res.x, y: res.y }, moveNo)
    expect(v.moves.length).toBe(moveNo + 1)
    expect(await errCode(svc.autopilotMove(code, matchId, OWNER))).toBe('not_your_turn')
  })

  it('finds the winning five and asks for learned hints for the owner side', async () => {
    const { svc, clock, code, matchId, ownerSide, byside, hintCalls } = await playingMatch()
    const opp: Side = ownerSide === 'X' ? 'O' : 'X'
    const row = { [ownerSide]: 10, [opp]: 20 } as Record<Side, number>
    // X then O, four times each: the owner builds 10..13 on their row, the opponent plays far away.
    for (let i = 0; i < 8; i++) {
      const side: Side = i % 2 === 0 ? 'X' : 'O'
      const x = side === ownerSide ? 10 + Math.floor(i / 2) : 30 + Math.floor(i / 2) * 3
      clock.t += 1000
      await svc.move(code, matchId, byside[side], { x, y: row[side] }, i)
    }
    if (ownerSide === 'O') {
      clock.t += 1000
      await svc.move(code, matchId, byside.X, { x: 40, y: 40 }, 8)
    }
    const res = await svc.autopilotMove(code, matchId, OWNER)
    expect(res.y).toBe(10)
    expect([9, 14]).toContain(res.x)
    expect(hintCalls.at(-1)?.side).toBe(ownerSide)
    clock.t += 1000
    const v = await svc.move(code, matchId, OWNER, { x: res.x, y: res.y }, res.moveNo)
    expect(v.lastGame?.endReason ?? v.endReason).toBe('five_in_row')
  })
})
