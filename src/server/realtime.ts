import * as Ably from 'ably'

/**
 * Ably is only a doorbell: after a successful write the server publishes `{ v: version }` on the
 * room/match channel, and subscribers re-fetch through the normal API. No game data goes through
 * Ably, and clients may only subscribe (never publish), so nothing can be spoofed or leaked.
 * Without ABLY_API_KEY everything here is a no-op and the app runs on polling alone.
 */

let rest: Ably.Rest | null = null

function client(): Ably.Rest | null {
  const key = process.env.ABLY_API_KEY
  if (!key) return null
  rest ??= new Ably.Rest({ key })
  return rest
}

export const realtimeEnabled = () => !!process.env.ABLY_API_KEY

import { CHANGED_EVENT, MOVE_EVENT, type MoveSignal } from '@/src/realtime/channels'

export {
  battleshipMatchChannel,
  battleshipRoomChannel,
  caroMatchChannel,
  caroRoomChannel,
  sudokuChannel,
} from '@/src/realtime/channels'

/** Publishes a "changed" signal on each channel. Never throws: realtime is best-effort, polling covers misses. */
export async function publishChanged(channels: string[], version: number): Promise<void> {
  const c = client()
  if (!c || channels.length === 0) return
  await Promise.all(
    channels.map((name) =>
      c.channels
        .get(name)
        .publish(CHANGED_EVENT, { v: version })
        .catch((e: unknown) => console.error('ably publish failed', name, e)),
    ),
  )
}

/** Publishes a move signal (see MoveSignal). Never throws: polling and the doorbell cover misses. */
export async function publishMove(channel: string, signal: MoveSignal): Promise<void> {
  const c = client()
  if (!c) return
  await c.channels
    .get(channel)
    .publish(MOVE_EVENT, signal)
    .catch((e: unknown) => console.error('ably publish failed', channel, e))
}

/** A signed token request the browser exchanges with Ably: subscribe-only on game channels, 1 hour. */
export async function createTokenRequest(userId: string): Promise<Ably.TokenRequest | null> {
  const c = client()
  if (!c) return null
  return c.auth.createTokenRequest({
    clientId: userId,
    ttl: 60 * 60 * 1000,
    capability: { 'caro:*': ['subscribe'], 'sudoku:*': ['subscribe'], 'battleship:*': ['subscribe'] },
  })
}
