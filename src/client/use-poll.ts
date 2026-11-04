'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from './api'
import { useRealtime } from './realtime'

export interface PollOptions {
  /** Realtime channel: each signal triggers an immediate fetch. */
  channel?: string | null
  /** Poll interval while the realtime channel is live (a slow safety net). */
  liveIntervalMs?: number
}

/** Survives client navigations so remounted pages can paint before the next fetch. */
const pollCache = new Map<string, unknown>()

export function peekPollCache<T>(path: string): T | null {
  return (pollCache.get(path) as T | undefined) ?? null
}

export function putPollCache<T>(path: string, data: T): void {
  pollCache.set(path, data)
}

export function usePoll<T>(path: string | null, intervalMs: number, opts: PollOptions = {}) {
  const [data, setData] = useState<T | null>(() => (path ? peekPollCache<T>(path) : null))
  const [error, setError] = useState<ApiError | null>(null)
  const seq = useRef(0)
  const kickRef = useRef<() => void>(() => {})

  // Path can flip from null → URL after boot; pick up anything already cached (e.g. first /api/me).
  useEffect(() => {
    if (!path) return
    const cached = peekPollCache<T>(path)
    if (cached !== null) setData(cached)
  }, [path])

  const load = useCallback(async () => {
    if (!path) return
    const my = ++seq.current
    try {
      const d = await apiGet<T>(path)
      if (my !== seq.current) return
      putPollCache(path, d)
      setData(d)
      setError(null)
    } catch (e) {
      if (my !== seq.current) return
      setError(e instanceof ApiError ? e : new ApiError(0, 'unknown'))
    }
  }, [path])

  const live = useRealtime(path ? (opts.channel ?? null) : null, () => kickRef.current())
  const delay = live && opts.liveIntervalMs ? opts.liveIntervalMs : intervalMs

  // Completion-chained: the next request is scheduled only after the previous one settled, so a slow
  // server never sees overlapping polls from one tab. Paused while hidden; refreshes on return.
  // A realtime signal (kick) fetches right away, or right after the in-flight request.
  useEffect(() => {
    if (!path) return
    let stopped = false
    let running = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      timer = null
      if (stopped || running || document.hidden) return
      running = true
      await load()
      running = false
      if (stopped) return
      if (again) {
        again = false
        void run()
        return
      }
      timer = setTimeout(() => void run(), delay)
    }
    const kick = () => {
      if (stopped || document.hidden) return
      if (running) {
        again = true
        return
      }
      if (timer) clearTimeout(timer)
      void run()
    }
    kickRef.current = kick
    const onVis = () => {
      if (!document.hidden) kick()
    }
    timer = setTimeout(() => void run(), 0)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      kickRef.current = () => {}
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [path, delay, load])

  return { data, error, refresh: () => void load() }
}
