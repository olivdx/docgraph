'use client'

import { useEffect, useState } from 'react'
import type { BattleScene } from './scene'

/**
 * Loads the models and creates the 3D scene on `canvas`, sized to `stage` (kept in sync with a
 * ResizeObserver). Takes the elements themselves (from callback-ref state), not refs, so the scene is
 * created as soon as both exist, even when they mount after the models finished loading.
 * three.js is imported lazily so it only ever loads in the browser.
 */
export function useBattleScene(
  canvas: HTMLCanvasElement | null,
  stage: HTMLElement | null,
): { scene: BattleScene | null; error: string | null } {
  const [scene, setScene] = useState<BattleScene | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!canvas || !stage) return
    let stopped = false
    let made: BattleScene | null = null
    let ro: ResizeObserver | null = null
    Promise.all([import('./scene'), import('./models')])
      .then(async ([{ BattleScene }, { loadModels }]) => {
        const models = await loadModels()
        if (stopped) return
        made = new BattleScene(canvas, models)
        const fitSize = () => made?.resize(stage.clientWidth, stage.clientHeight)
        fitSize()
        ro = new ResizeObserver(fitSize)
        ro.observe(stage)
        setScene(made)
      })
      .catch((e: unknown) => {
        console.error(e)
        if (!stopped) setError('Could not load the 3D models. Try reloading the page.')
      })
    return () => {
      stopped = true
      ro?.disconnect()
      made?.dispose()
      setScene(null)
    }
  }, [canvas, stage])

  return { scene, error }
}
