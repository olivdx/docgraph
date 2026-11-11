'use client'

import { useEffect, useRef, useState } from 'react'
import { MODEL_BASE } from './asset-paths'

/**
 * A crisp, slowly turning 3D ship for cards and heroes (the kit's preview PNGs are only 64×64 and
 * blur when scaled up). Shows the PNG until three.js and the model have loaded; keeps it on failure.
 */
export function ShipThumb({
  model = 'ship-pirate-large',
  size,
  className = '',
}: {
  model?: string
  /** CSS pixels (square). */
  size: number
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let stopped = false
    let raf = 0
    let dispose: (() => void) | null = null
    void (async () => {
      try {
        const THREE = await import('three')
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
        const gltf = await new GLTFLoader().loadAsync(`${MODEL_BASE}${model}.glb`)
        if (stopped) return
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3))
        renderer.setSize(size, size, false)
        const scene = new THREE.Scene()
        scene.add(new THREE.HemisphereLight(0xe6f6ff, 0x2a6f8f, 1.8))
        const sun = new THREE.DirectionalLight(0xfff4e0, 2.6)
        sun.position.set(4, 8, 6)
        scene.add(sun)

        // Centre the model and frame it from slightly above.
        const ship = gltf.scene
        const box = new THREE.Box3().setFromObject(ship)
        const dim = box.getSize(new THREE.Vector3())
        const ctr = box.getCenter(new THREE.Vector3())
        ship.position.sub(ctr)
        const pivot = new THREE.Group()
        pivot.add(ship)
        scene.add(pivot)
        const radius = Math.max(dim.x, dim.y, dim.z) * 0.62
        const camera = new THREE.PerspectiveCamera(30, 1, 0.01, radius * 20)
        const dist = radius / Math.tan(THREE.MathUtils.degToRad(15))
        camera.position.set(dist * 0.75, dist * 0.42, dist * 0.55)
        camera.lookAt(0, 0, 0)

        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        const clock = new THREE.Clock()
        pivot.rotation.y = -0.6
        const tick = () => {
          if (stopped) return
          if (!reduce) {
            const t = clock.getElapsedTime()
            pivot.rotation.y = -0.6 + t * 0.35
            pivot.position.y = Math.sin(t * 1.6) * dim.y * 0.02
          }
          renderer.render(scene, camera)
          raf = requestAnimationFrame(tick)
        }
        tick()
        setReady(true)
        dispose = () => renderer.dispose()
      } catch (e) {
        console.error(e) // keep the PNG fallback
      }
    })()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      dispose?.()
    }
  }, [model, size])

  return (
    // `relative` only when the caller doesn't position the thumb itself: Tailwind emits `relative` after
    // `absolute`, so having both would silently keep the thumb in the normal flow.
    <div className={`${/(^| )(absolute|fixed|sticky)( |$)/.test(className) ? '' : 'relative'} ${className}`} style={{ width: size, height: size }}>
      {!ready && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/assets/Previews/${model}.png`} alt="" className="absolute inset-0 size-full object-contain" />
      )}
      <canvas ref={canvasRef} aria-hidden className={`absolute inset-0 size-full ${ready ? '' : 'invisible'}`} />
    </div>
  )
}
