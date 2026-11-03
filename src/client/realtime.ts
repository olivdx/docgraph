'use client'

import { useEffect, useRef, useState } from 'react'
import type * as AblyTypes from 'ably'
import { ApiError, apiGet } from './api'

/**
 * One shared Ably connection per tab, opened lazily (the SDK is only downloaded by screens that
 * subscribe). Messages are just "something changed" signals; screens re-fetch through the API.
 * If realtime is off (no server key) or broken, `live` stays false and screens keep polling.
 */

let clientPromise: Promise<AblyTypes.Realtime | null> | null = null

function getClient(): Promise<AblyTypes.Realtime | null> {
  clientPromise ??= (async () => {
    // Ask once up front: a 404 means the server has no Ably key, so don't load the SDK at all.
    try {
      await apiGet('/api/realtime/token')
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
    }
    const Ably = await import('ably')
    return new Ably.Realtime({
      authCallback: (_params, cb) => {
        apiGet<AblyTypes.TokenRequest>('/api/realtime/token')
          .then((t) => cb(null, t))
          .catch((e: unknown) => cb(e instanceof Error ? e.message : 'auth failed', null))
      },
      // Re-fetching is cheap; a short disconnect is covered by polling, so no history replay needed.
      closeOnUnload: true,
    })
  })().catch(() => null)
  return clientPromise
}

/**
 * Subscribes to `channel` (null = off) and calls `onChange` for every signal. Returns whether the
 * subscription is live right now, so callers can poll less while it is.
 */
export function useRealtime(channel: string | null, onChange: () => void): boolean {
  const [live, setLive] = useState(false)
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!channel) return
    let stopped = false
    let cleanup: (() => void) | null = null
    void getClient().then((client) => {
      if (stopped || !client) return
      const ch = client.channels.get(channel)
      const onMsg = () => cb.current()
      const sync = () => setLive(client.connection.state === 'connected' && ch.state === 'attached')
      const onConn = (s: AblyTypes.ConnectionStateChange) => {
        sync()
        // Back online after a gap: we may have missed signals, so re-fetch once.
        if (s.current === 'connected' && s.previous !== 'initialized') cb.current()
      }
      void ch.subscribe('changed', onMsg).then(sync, () => setLive(false))
      ch.on(sync)
      client.connection.on(onConn)
      sync()
      cleanup = () => {
        ch.unsubscribe('changed', onMsg)
        ch.off(sync)
        client.connection.off(onConn)
        void ch.detach().catch(() => {})
      }
    })
    return () => {
      stopped = true
      cleanup?.()
      setLive(false)
    }
  }, [channel])

  return live
}
