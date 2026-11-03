'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from './api'

export function usePoll<T>(path: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!path) return
    const my = ++seq.current
    try {
      const d = await apiGet<T>(path)
      if (my !== seq.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (my !== seq.current) return
      setError(e instanceof ApiError ? e : new ApiError(0, 'unknown'))
    }
  }, [path])

  // Completion-chained: the next request is scheduled only after the previous one settled, so a slow
  // server never sees overlapping polls from one tab. Paused while hidden; refreshes on return.
  useEffect(() => {
    if (!path) return
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      timer = null
      if (stopped || running || document.hidden) return
      running = true
      await load()
      running = false
      if (!stopped) timer = setTimeout(() => void run(), intervalMs)
    }
    const onVis = () => {
      if (document.hidden || running) return
      if (timer) clearTimeout(timer)
      void run()
    }
    timer = setTimeout(() => void run(), 0)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [path, intervalMs, load])

  return { data, error, refresh: () => void load() }
}
