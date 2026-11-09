'use client'

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { ShipKey } from '@/src/battleship/types'

/** Every Kenney pirate-kit model the battle scene uses (public/assets/Models/GLB format/). */
export const MODEL_NAMES = [
  'ship-pirate-large', 'ship-pirate-medium', 'ship-pirate-small',
  'cannon-ball', 'cannon-mobile', 'flag-pirate', 'rocks-a',
  'patch-sand-foliage', 'tower-complete-small', 'flag-pirate-high', 'ship-wreck', 'rocks-sand-a', 'rocks-sand-b', 'rocks-sand-c',
  'rocks-c', 'crate', 'bottle', 'palm-detailed-bend', 'palm-detailed-straight', 'crate-bottles', 'chest', 'grass-plant',
  'tower-watch', 'structure-platform-dock-small', 'boat-row-small', 'ship-ghost', 'rocks-b', 'palm-bend', 'palm-straight',
  'patch-sand', 'barrel',
] as const

export type ModelName = (typeof MODEL_NAMES)[number]
export type Models = Record<ModelName, THREE.Group>

export const SHIP_MODEL: Record<ShipKey, ModelName> = {
  galleon: 'ship-pirate-large',
  brig: 'ship-pirate-medium',
  sloop: 'ship-pirate-small',
}

export const MODEL_BASE = '/assets/Models/GLB%20format/'

let cache: Promise<Models> | null = null

/** Loads every model once per page session. */
export function loadModels(base = MODEL_BASE): Promise<Models> {
  cache ??= (async () => {
    const loader = new GLTFLoader()
    const list = await Promise.all(
      MODEL_NAMES.map(async (n) => [n, (await loader.loadAsync(`${base}${n}.glb`)).scene] as const),
    )
    return Object.fromEntries(list) as Models
  })().catch((e) => {
    cache = null
    throw e
  })
  return cache
}

export interface FitOpts {
  /** Ship length in cells: the long axis is turned onto Z and scaled to this. */
  len?: number
  /** Largest horizontal size. */
  maxXZ?: number
  height?: number
}

/** A clone of `src` wrapped in a group: centred on X/Z, bottom at y = 0, scaled per `opts`. `userData.h` is its height. */
export function fit(src: THREE.Object3D, opts: FitOpts): THREE.Group {
  const o = src.clone(true)
  const wrap = new THREE.Group()
  wrap.add(o)
  const box = new THREE.Box3()
  const size = new THREE.Vector3()
  const ctr = new THREE.Vector3()
  const measure = () => {
    o.updateMatrixWorld(true)
    box.setFromObject(o)
    box.getSize(size)
    box.getCenter(ctr)
  }
  measure()
  if (opts.len && size.x > size.z) {
    o.rotation.y = Math.PI / 2
    measure()
  }
  const s = opts.len ? opts.len / size.z : opts.maxXZ ? opts.maxXZ / Math.max(size.x, size.z) : opts.height! / size.y
  o.scale.multiplyScalar(s)
  measure()
  o.position.x -= ctr.x
  o.position.z -= ctr.z
  o.position.y -= box.min.y
  wrap.userData.h = size.y
  return wrap
}
