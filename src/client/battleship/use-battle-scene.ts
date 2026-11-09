'use client'

import { useEffect, useState, type RefObject } from 'react'
import type { BattleScene } from './scene'

/**
 * Loads the models and creates the 3D scene on `canvasRef`, sized to `stageRef` (kept in sync with a
 * ResizeObserver). three.js is imported lazily so it only ever loads in the browser.
 */
export function useBattleScene(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  stageRef: RefObject<HTMLElement | null>,
): { scene: BattleScene | null; error: string | null } {
  const [scene, setScene] = useState<BattleScene | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    let made: BattleScene | null = null
    let ro: ResizeObserver | null = null
    Promise.all([import('./scene'), import('./models')])
      .then(async ([{ BattleScene }, { loadModels }]) => {
        const models = await loadModels()
        const canvas = canvasRef.current
        const stage = stageRef.current
        if (stopped || !canvas || !stage) return
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
    }
  }, [canvasRef, stageRef])

  return { scene, error }
}
