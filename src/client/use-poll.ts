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

  useEffect(() => {
    if (!path) return
    const first = setTimeout(() => void load(), 0)
    const tick = () => {
      if (!document.hidden) void load()
    }
    const id = setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearTimeout(first)
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [path, intervalMs, load])

  return { data, error, refresh: () => void load() }
}
