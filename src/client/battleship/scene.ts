'use client'

/**
 * The 3D battle scene, ported from the throwaway prototype (calm flat water, two 6×6 seas with
 * decor islands, a cannon per side, cannonball arcs, splashes, fires and sinking ships).
 *
 * It knows nothing about the server: the match page feeds it fleets and shots (`setFleet`,
 * `setShots`), plays new shots with animation (`playShot`) and asks it which cell was tapped.
 * Board 'me' is the viewer's own sea (x = -7), 'enemy' the opponent's (x = +7).
 */
import * as THREE from 'three'
import { FLEET, N } from '@/src/battleship/constants'
import type { Ship, ShipKey } from '@/src/battleship/types'
import type { ShotView } from '@/src/battleship/views'
import { fit, SHIP_MODEL, type FitOpts, type ModelName, type Models } from './models'
import type { Board } from './sync'

const COLS = 'ABCDEF'
const BOARD_X: Record<Board, number> = { me: -7, enemy: 7 }
const BOARDS: Board[] = ['me', 'enemy']

const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const rc = (i: number) => [Math.floor(i / N), i % N] as const

interface Tween {
  t: number
  dur: number
  fn: (k: number) => void
  res: () => void
}
interface Particle {
  m: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  vel: THREE.Vector3
  g: number
  life: number
  max: number
  s0: number
  s1: number
  o0: number
  soft: boolean
}
interface BurstOpts {
  count: number
  color: string
  speed: number
  up: number
  g?: number
  life?: number
  s0?: number
  s1?: number
  opacity?: number
  soft?: boolean
  drift?: number
  push?: THREE.Vector3 | null
}
interface Fire {
  g: THREE.Group
  cones: THREE.Mesh[]
  emit: number
}
interface Cannon {
  base: THREE.Group
  yaw: THREE.Group
  gun: THREE.Group
  muzzle: THREE.Object3D
  rest: number
  aim: number
}
interface ShipObj {
  obj: THREE.Group
  cells: string
  sunk: boolean
}

export class BattleScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
  private waterMat: THREE.ShaderMaterial
  private clock = new THREE.Clock()
  private raf = 0
  private disposed = false

  private tweens: Tween[] = []
  private parts: Particle[] = []
  private fires: Fire[] = []
  private bobbers: THREE.Object3D[] = []
  private foamRings: { m: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; ph: number }[] = []
  private sphereGeo = new THREE.SphereGeometry(1, 8, 6)
  private flameMat = new THREE.MeshBasicMaterial({ color: '#ff8a1f' })
  private flameCore = new THREE.MeshBasicMaterial({ color: '#ffe066' })

  private pick = {} as Record<Board, THREE.Mesh>
  private dyn = {} as Record<Board, THREE.Group>
  private ships: Record<Board, Map<ShipKey, ShipObj>> = { me: new Map(), enemy: new Map() }
  private markers: Record<Board, Map<number, THREE.Object3D[]>> = { me: new Map(), enemy: new Map() }
  private cannons = {} as Record<Board, Cannon>
  private target = new THREE.Group()
  private ghosts = new Map<ShipKey, THREE.Group>()
  private ghostTiles: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = []

  private camTarget = new THREE.Vector3(BOARD_X.me, 0, 0)
  private camDir = new THREE.Vector3(0, 1, 0.78).normalize()
  private camDist = 12
  private shake = 0
  private ray = new THREE.Raycaster()

  constructor(
    private canvas: HTMLCanvasElement,
    private models: Models,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.scene.background = new THREE.Color('#7cc8ea')
    this.scene.fog = new THREE.Fog('#7cc8ea', 18, 40)
    this.scene.add(new THREE.HemisphereLight(0xe6f6ff, 0x2a6f8f, 1.7))
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4)
    sun.position.set(6, 12, 7)
    this.scene.add(sun)

    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { t: { value: 0 } },
      vertexShader: `varying vec2 vp; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vp = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float t; varying vec2 vp;
        void main(){
          vec3 base = vec3(.20, .62, .80);
          float w = sin(vp.x*.45 + t*.5) * sin(vp.y*.40 - t*.4);
          gl_FragColor = vec4(base + w * .025, 1.0);
        }`,
    })
    const water = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), this.waterMat)
    water.rotation.x = -Math.PI / 2
    this.scene.add(water)

    for (const b of BOARDS) this.buildBoard(b)
    this.buildTarget()
    this.buildCannon('enemy')
    this.buildCannon('me')
    this.decorateMiddle()
    this.buildGhostTiles()
    this.loop()
  }

  // ---- public API ------------------------------------------------------------------------------

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    const v = THREE.MathUtils.degToRad(this.camera.fov)
    const hf = 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect)
    this.camDist = Math.max(4.3 / Math.tan(hf / 2), 5.4 / Math.tan(v / 2)) * 1.05
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }

  /** Pans the camera to a sea (0.9 s), or jumps there with `instant`. */
  focus(board: Board, instant = false): Promise<void> {
    const to = BOARD_X[board]
    if (instant || this.camTarget.x === to) {
      this.camTarget.x = to
      return Promise.resolve()
    }
    const from = this.camTarget.x
    return this.tween(0.9, (k) => {
      this.camTarget.x = from + (to - from) * ease(k)
    })
  }

  /** Makes the ship models on `board` match `ships` (no animation). */
  setFleet(board: Board, ships: Ship[]): void {
    const map = this.ships[board]
    for (const [key, s] of map) {
      const next = ships.find((x) => x.key === key)
      if (!next || next.cells.join() !== s.cells) this.removeShip(board, key)
    }
    for (const s of ships) if (!map.has(s.key)) this.addShip(board, s)
  }

  /** Makes the hit/miss markers on `board` match `shots` (no animation); sunk ships are shown sunk. */
  setShots(board: Board, shots: ShotView[]): void {
    const cells = new Set(shots.map((s) => s.cell))
    for (const [cell, objs] of this.markers[board]) {
      if (!cells.has(cell)) {
        objs.forEach((o) => o.parent?.remove(o))
        this.fires = this.fires.filter((f) => !objs.includes(f.g))
        this.markers[board].delete(cell)
      }
    }
    for (const s of shots) if (!this.markers[board].has(s.cell)) this.addMarker(board, s.cell, s.result !== 'miss')
    for (const s of shots) {
      if (s.result !== 'sunk' || !s.shipKey) continue
      const ship = this.ships[board].get(s.shipKey)
      if (ship && !ship.sunk) this.sinkPose(ship)
    }
  }

  /** Cannon aims and fires at `shot.cell` on `board`, then the splash or explosion; a sunk ship is revealed and sinks. */
  async playShot(board: Board, shot: ShotView, sunkShip: Ship | null): Promise<void> {
    const cn = this.cannons[board]
    this.aimAt(board, shot.cell)
    await wait(board === 'me' ? 600 : 250)
    const from = cn.muzzle.getWorldPosition(new THREE.Vector3())
    const p = this.cellPos(board, shot.cell)
    const onShip = this.shipAt(board, shot.cell)
    const to = p.clone()
    to.y = onShip ? 0.3 : 0.02
    this.fireFx(cn, from)
    const ball = this.fitModel('cannon-ball', { maxXZ: 0.2 })
    ball.position.copy(from)
    this.scene.add(ball)
    await this.tween(0.85, (k) => {
      ball.position.lerpVectors(from, to, k)
      ball.position.y += Math.sin(k * Math.PI) * 3.4
    })
    this.scene.remove(ball)

    if (shot.result === 'miss') {
      this.burst(p, { count: 22, color: '#ffffff', speed: 1.4, up: 4.2, g: 11, life: 0.8, s0: 0.07, s1: 0.03 })
      this.ring(p, '#ffffff', 1.1)
    } else {
      this.burst(to, { count: 26, color: '#ffb02e', speed: 2.2, up: 3, g: 6, life: 0.6, s0: 0.09, s1: 0.02 })
      this.burst(to, { count: 12, color: '#555b60', speed: 0.6, up: 1.4, g: -0.4, life: 1.4, s0: 0.1, s1: 0.35, opacity: 0.75 })
      this.ring(p, '#ffb02e', 1.3)
      this.flash(to)
    }
    if (!this.markers[board].has(shot.cell)) this.addMarker(board, shot.cell, shot.result !== 'miss')
    if (sunkShip) {
      if (!this.ships[board].has(sunkShip.key)) this.addShip(board, sunkShip)
      const s = this.ships[board].get(sunkShip.key)!
      if (!s.sunk) this.sinkAnimated(s)
    }
  }

  /** Shows the aiming marker on the enemy sea and swings your cannon onto it (null hides it). */
  setTarget(cell: number | null): void {
    this.target.visible = cell !== null
    if (cell === null) return
    const p = this.cellPos('enemy', cell)
    this.target.position.set(p.x, 0.05, p.z)
    this.aimAt('enemy', cell)
  }

  /** The cell under a screen point on `board`, or -1. */
  pickCell(clientX: number, clientY: number, board: Board): number {
    const r = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(ndc, this.camera)
    const hit = this.ray.intersectObject(this.pick[board])[0]
    if (!hit) return -1
    const c = Math.floor(hit.point.x - BOARD_X[board] + N / 2)
    const row = Math.floor(hit.point.z + N / 2)
    return c < 0 || c >= N || row < 0 || row >= N ? -1 : row * N + c
  }

  /** Translucent ship preview on your sea with green (ok) or red cells. */
  showGhost(key: ShipKey, cells: number[], ok: boolean): void {
    this.hideGhost()
    const g = this.ghostFor(key)
    g.position.copy(this.cellPos('me', cells[0])).add(this.cellPos('me', cells[cells.length - 1])).multiplyScalar(0.5)
    g.rotation.y = isHoriz(cells) ? Math.PI / 2 : 0
    g.visible = true
    cells.forEach((c, k) => {
      const t = this.ghostTiles[k]
      t.position.copy(this.cellPos('me', c))
      t.position.y = 0.03
      t.material.color.set(ok ? '#4fd18b' : '#ff5a3c')
      t.visible = true
    })
  }

  hideGhost(): void {
    for (const g of this.ghosts.values()) g.visible = false
    for (const t of this.ghostTiles) t.visible = false
  }

  /** Places (or moves) one of your ships with a little drop and splash. */
  dropShip(ship: Ship): void {
    this.removeShip('me', ship.key)
    const s = this.addShip('me', ship)
    const o = s.obj
    const y = o.userData.baseY as number
    o.userData.sinking = true
    o.position.y = y + 0.6
    void this.tween(0.3, (k) => {
      o.position.y = y + (1 - ease(k)) * 0.6
    }).then(() => {
      o.userData.sinking = false
      this.ring(o.position.clone(), '#ffffff', 1.4)
    })
  }

  /** Canvas-relative CSS pixel point just above a ship (for the floating rotate button), or null. */
  screenPointAbove(board: Board, ship: Ship): { x: number; y: number } | null {
    const a = this.cellPos(board, ship.cells[0])
    const b = this.cellPos(board, ship.cells[ship.cells.length - 1])
    const v = a.add(b).multiplyScalar(0.5)
    v.y = 1.05
    this.camera.updateMatrixWorld()
    v.project(this.camera)
    if (v.z > 1) return null
    const r = this.canvas.getBoundingClientRect()
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height }
  }

  // ---- building --------------------------------------------------------------------------------

  private fitModel(name: ModelName, opts: FitOpts): THREE.Group {
    return fit(this.models[name], opts)
  }

  private cellPos(board: Board, i: number): THREE.Vector3 {
    const [r, c] = rc(i)
    return new THREE.Vector3(BOARD_X[board] + (c - (N - 1) / 2), 0, r - (N - 1) / 2)
  }

  private textSprite(txt: string): THREE.Sprite {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const g = cv.getContext('2d')!
    g.font = '700 40px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(11,31,51,.55)'
    g.fillText(txt, 33, 35)
    g.fillStyle = '#ffffff'
    g.fillText(txt, 32, 33)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }))
    sp.scale.setScalar(0.42)
    return sp
  }

  private buildBoard(key: Board): void {
    const root = new THREE.Group()
    root.position.x = BOARD_X[key]
    this.scene.add(root)

    const tint = new THREE.Mesh(
      new THREE.PlaneGeometry(N, N),
      new THREE.MeshBasicMaterial({ color: key === 'enemy' ? '#ffffff' : '#bfe9ff', transparent: true, opacity: 0.08, depthWrite: false }),
    )
    tint.rotation.x = -Math.PI / 2
    tint.position.y = 0.015
    root.add(tint)

    const pts: number[] = []
    for (let i = 0; i <= N; i++) {
      const v = i - N / 2
      pts.push(v, 0.02, -N / 2, v, 0.02, N / 2, -N / 2, 0.02, v, N / 2, 0.02, v)
    }
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    root.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45 })))

    const wood = new THREE.MeshStandardMaterial({ color: key === 'enemy' ? '#7a4b2a' : '#a0703c', roughness: 0.9 })
    for (const [x, z, w, d] of [
      [0, -N / 2, N + 0.24, 0.14],
      [0, N / 2, N + 0.24, 0.14],
      [-N / 2, 0, 0.14, N],
      [N / 2, 0, 0.14, N],
    ]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), wood)
      b.position.set(x, 0.04, z)
      root.add(b)
    }
    for (let i = 0; i < N; i++) {
      const a = this.textSprite(COLS[i])
      a.position.set(i - (N - 1) / 2, 0.3, -N / 2 - 0.45)
      root.add(a)
      const n = this.textSprite(String(i + 1))
      n.position.set(-N / 2 - 0.45, 0.3, i - (N - 1) / 2)
      root.add(n)
    }
    this.decorate(key, root)

    const p = new THREE.Mesh(new THREE.PlaneGeometry(N, N), new THREE.MeshBasicMaterial({ visible: false }))
    p.rotation.x = -Math.PI / 2
    root.add(p)
    this.pick[key] = p
    this.dyn[key] = new THREE.Group()
    this.scene.add(this.dyn[key])
  }

  private place(
    parent: THREE.Object3D,
    name: ModelName,
    opt: FitOpts,
    x: number,
    z: number,
    { y = 0, ry = 0, bob = false, tilt = 0 }: { y?: number; ry?: number; bob?: boolean; tilt?: number } = {},
  ): THREE.Group {
    const o = this.fitModel(name, opt)
    o.position.set(x, y, z)
    o.rotation.y = ry
    if (bob) {
      o.userData.baseY = y
      o.userData.bob = Math.random() * 6
      o.userData.rz = tilt
      this.bobbers.push(o)
    }
    parent.add(o)
    return o
  }

  private foam(parent: THREE.Object3D, x: number, z: number, r: number): void {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(r, r + 0.1, 40),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.3, depthWrite: false }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.set(x, 0.012, z)
    parent.add(m)
    this.foamRings.push({ m, ph: Math.random() * 6 })
  }

  private decorate(key: Board, R: THREE.Object3D): void {
    if (key === 'enemy') {
      this.foam(R, -3.7, -4.4, 1.25)
      this.place(R, 'patch-sand-foliage', { maxXZ: 2.4 }, -3.7, -4.4, { y: -0.05 })
      this.place(R, 'tower-complete-small', { height: 1.9 }, -3.95, -4.6, { ry: 0.4 })
      this.place(R, 'flag-pirate-high', { height: 1.4 }, -3.05, -4.05, { ry: -0.5 })
      this.foam(R, 3.8, -4.3, 0.95)
      this.place(R, 'ship-wreck', { maxXZ: 1.8 }, 3.8, -4.3, { y: -0.12, ry: 2.2 })
      this.place(R, 'rocks-sand-a', { maxXZ: 0.9 }, 4.5, -3.4, { y: -0.05 })
      this.foam(R, 3.6, 4.4, 0.9)
      this.place(R, 'patch-sand', { maxXZ: 1.6 }, 3.6, 4.4, { y: -0.05 })
      this.place(R, 'palm-detailed-bend', { height: 1.7 }, 3.6, 4.4, { ry: 2.5 })
      this.foam(R, -3.6, 4.4, 0.6)
      this.place(R, 'rocks-sand-b', { maxXZ: 1 }, -3.6, 4.4, { y: -0.05 })
      this.place(R, 'barrel', { height: 0.36 }, 4.3, 1.6, { y: -0.1, bob: true, tilt: 0.5 })
      this.place(R, 'bottle', { height: 0.3 }, -4.2, 0.6, { y: -0.08, bob: true, tilt: 0.9 })
      this.place(R, 'crate', { maxXZ: 0.4 }, 4.4, -1.2, { y: -0.12, ry: 0.6, bob: true })
      this.place(R, 'rocks-c', { maxXZ: 0.8 }, -4.4, -1.8, { y: -0.08 })
    } else {
      this.foam(R, -3.7, 4.4, 1.2)
      this.place(R, 'patch-sand', { maxXZ: 2.3 }, -3.7, 4.4, { y: -0.05 })
      this.place(R, 'tower-watch', { height: 1.7 }, -3.95, 4.6)
      this.place(R, 'structure-platform-dock-small', { maxXZ: 1 }, -2.55, 4.15, { y: -0.02, ry: Math.PI / 2 })
      this.place(R, 'boat-row-small', { maxXZ: 0.8 }, -2.2, 4.95, { y: -0.08, ry: 0.3, bob: true })
      this.foam(R, 3.7, 4.4, 1.1)
      this.place(R, 'patch-sand-foliage', { maxXZ: 2.1 }, 3.7, 4.4, { y: -0.05 })
      this.place(R, 'palm-detailed-straight', { height: 1.9 }, 3.95, 4.6)
      this.place(R, 'chest', { maxXZ: 0.45 }, 3.2, 4.1, { ry: -0.6 })
      this.foam(R, 3.8, -4.4, 0.8)
      this.place(R, 'rocks-sand-a', { maxXZ: 1.2 }, 3.8, -4.4, { y: -0.05 })
      this.place(R, 'grass-plant', { height: 0.5 }, 3.55, -4.2)
      this.foam(R, -3.8, -4.4, 1)
      this.place(R, 'patch-sand', { maxXZ: 1.6 }, -3.8, -4.4, { y: -0.05 })
      this.place(R, 'palm-bend', { height: 1.6 }, -3.8, -4.4, { ry: 1 })
      this.place(R, 'barrel', { height: 0.36 }, -4.3, 1.4, { y: -0.1, bob: true, tilt: 0.5 })
      this.place(R, 'rocks-b', { maxXZ: 0.8 }, 4.4, 0.4, { y: -0.08 })
      this.place(R, 'crate-bottles', { maxXZ: 0.45 }, 4.3, -2, { y: -0.14, ry: 0.4, bob: true })
    }
  }

  /** Island between the two seas (seen while the camera pans) and a ghost ship far out in the fog. */
  private decorateMiddle(): void {
    const G = new THREE.Group()
    this.scene.add(G)
    this.foam(G, 0, -0.5, 1.7)
    this.place(G, 'patch-sand-foliage', { maxXZ: 3.2 }, 0, -0.5, { y: -0.05 })
    this.place(G, 'palm-detailed-bend', { height: 2.2 }, -0.4, -0.8, { ry: 0.8 })
    this.place(G, 'palm-detailed-straight', { height: 2.4 }, 0.5, -0.2)
    this.foam(G, 0.3, 1.5, 0.6)
    this.place(G, 'rocks-sand-c', { maxXZ: 1 }, 0.3, 1.5, { y: -0.05 })
    this.place(G, 'ship-ghost', { maxXZ: 3 }, -1, -9, { y: -0.1, ry: 0.5, bob: true })
  }

  private buildTarget(): void {
    const mat = new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide })
    const r = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32), mat)
    r.rotation.x = -Math.PI / 2
    this.target.add(r)
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group()
      g.rotation.y = (i * Math.PI) / 2
      const a = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.05), mat)
      a.rotation.x = -Math.PI / 2
      a.position.set(-0.35, 0, -0.45)
      g.add(a)
      const b = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.22), mat)
      b.rotation.x = -Math.PI / 2
      b.position.set(-0.45, 0, -0.35)
      g.add(b)
      this.target.add(g)
    }
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.96, 0.96),
      new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.18, depthWrite: false }),
    )
    fill.rotation.x = -Math.PI / 2
    this.target.add(fill)
    this.target.position.y = 0.05
    this.target.visible = false
    this.scene.add(this.target)
  }

  /** `key` is the sea this cannon fires at: yours sits below the enemy sea, theirs above yours. */
  private buildCannon(key: Board): void {
    const mine = key === 'enemy'
    const base = new THREE.Group()
    base.position.set(BOARD_X[key], 0, mine ? N / 2 + 1.25 : -(N / 2 + 1.25))
    const island = this.fitModel('patch-sand', { maxXZ: 2.2 })
    island.position.y = -0.06
    base.add(island)
    const yaw = new THREE.Group()
    yaw.position.y = 0.06
    base.add(yaw)
    const gun = this.fitModel('cannon-mobile', { maxXZ: 0.95 }) // the model's barrel points +Z
    yaw.add(gun)
    const box = new THREE.Box3().setFromObject(gun)
    const muzzle = new THREE.Object3D()
    muzzle.position.set(0, box.max.y * 0.8, box.max.z)
    yaw.add(muzzle)
    if (!mine) {
      const flag = this.fitModel('flag-pirate', { height: 1.1 })
      flag.position.set(0.75, 0, -0.35)
      base.add(flag)
    }
    const rest = mine ? Math.PI : 0
    yaw.rotation.y = rest
    this.scene.add(base)
    this.cannons[key] = { base, yaw, gun, muzzle, rest, aim: rest }
  }

  private buildGhostTiles(): void {
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.94, 0.94),
        new THREE.MeshBasicMaterial({ color: '#4fd18b', transparent: true, opacity: 0.5, depthWrite: false }),
      )
      m.rotation.x = -Math.PI / 2
      m.visible = false
      this.scene.add(m)
      this.ghostTiles.push(m)
    }
  }

  private ghostFor(key: ShipKey): THREE.Group {
    const have = this.ghosts.get(key)
    if (have) return have
    const len = FLEET.find((f) => f.key === key)!.len
    const g = this.fitModel(SHIP_MODEL[key], { len: len * 0.95 })
    g.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mat = (mesh.material as THREE.Material).clone()
      mat.transparent = true
      mat.opacity = 0.6
      mat.depthWrite = false
      mesh.material = mat
    })
    g.visible = false
    this.scene.add(g)
    this.ghosts.set(key, g)
    return g
  }

  // ---- ships and markers -----------------------------------------------------------------------

  private addShip(board: Board, ship: Ship): ShipObj {
    const len = FLEET.find((f) => f.key === ship.key)!.len
    const w = this.fitModel(SHIP_MODEL[ship.key], { len: len * 0.95 })
    w.position.copy(this.cellPos(board, ship.cells[0])).add(this.cellPos(board, ship.cells[ship.cells.length - 1])).multiplyScalar(0.5)
    w.userData.baseY = -(w.userData.h as number) * 0.18
    w.position.y = w.userData.baseY
    w.rotation.y = isHoriz(ship.cells) ? Math.PI / 2 : 0
    w.userData.bob = Math.random() * 6
    this.dyn[board].add(w)
    this.bobbers.push(w)
    const s: ShipObj = { obj: w, cells: ship.cells.join(), sunk: false }
    this.ships[board].set(ship.key, s)
    return s
  }

  private removeShip(board: Board, key: ShipKey): void {
    const s = this.ships[board].get(key)
    if (!s) return
    s.obj.parent?.remove(s.obj)
    this.bobbers = this.bobbers.filter((b) => b !== s.obj)
    this.fires = this.fires.filter((f) => !isDescendant(f.g, s.obj))
    this.ships[board].delete(key)
  }

  private shipAt(board: Board, cell: number): ShipObj | null {
    for (const s of this.ships[board].values()) if (s.cells.split(',').map(Number).includes(cell)) return s
    return null
  }

  private addMarker(board: Board, cell: number, hit: boolean): void {
    const p = this.cellPos(board, cell)
    const objs: THREE.Object3D[] = []
    const mark = new THREE.Mesh(
      new THREE.PlaneGeometry(0.94, 0.94),
      new THREE.MeshBasicMaterial({ color: hit ? '#ff5a3c' : '#ffffff', transparent: true, opacity: hit ? 0.35 : 0.22, depthWrite: false }),
    )
    mark.rotation.x = -Math.PI / 2
    mark.position.set(p.x, 0.018, p.z)
    this.dyn[board].add(mark)
    objs.push(mark)
    if (!hit) {
      const buoy = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.04, 8, 20), new THREE.MeshStandardMaterial({ color: '#f4fbff' }))
      buoy.rotation.x = -Math.PI / 2
      buoy.position.set(p.x, 0.03, p.z)
      this.dyn[board].add(buoy)
      objs.push(buoy)
    } else {
      const ship = this.shipAt(board, cell)
      if (ship) {
        const local = ship.obj.worldToLocal(new THREE.Vector3(p.x, 0.3, p.z))
        objs.push(this.addFire(ship.obj, local))
      } else {
        const deb = new THREE.Mesh(
          new THREE.CircleGeometry(0.34, 20),
          new THREE.MeshBasicMaterial({ color: '#3a2a20', transparent: true, opacity: 0.75, depthWrite: false }),
        )
        deb.rotation.x = -Math.PI / 2
        deb.position.set(p.x, 0.025, p.z)
        this.dyn[board].add(deb)
        objs.push(deb, this.addFire(this.dyn[board], new THREE.Vector3(p.x, 0.02, p.z)))
      }
    }
    this.markers[board].set(cell, objs)
  }

  private addFire(parent: THREE.Object3D, localPos: THREE.Vector3): THREE.Group {
    const g = new THREE.Group()
    g.position.copy(localPos)
    const cones: THREE.Mesh[] = []
    for (const [x, z, r, mat] of [
      [0, 0, 0.2, this.flameMat],
      [0.1, 0.05, 0.14, this.flameMat],
      [-0.08, -0.06, 0.15, this.flameMat],
      [0, 0, 0.1, this.flameCore],
    ] as const) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(r * 0.55, r * 2.2, 7), mat)
      c.position.set(x, r * 1.1, z)
      g.add(c)
      cones.push(c)
    }
    parent.add(g)
    this.fires.push({ g, cones, emit: Math.random() * 0.3 })
    return g
  }

  private sinkPose(s: ShipObj): void {
    s.sunk = true
    s.obj.userData.sinking = true
    s.obj.position.y = (s.obj.userData.baseY as number) - (s.obj.userData.h as number) * 0.55
    s.obj.rotation.z = 0.45
    s.obj.rotation.x = 0.12
  }

  private sinkAnimated(s: ShipObj): void {
    s.sunk = true
    const obj = s.obj
    obj.userData.sinking = true
    const y0 = obj.position.y
    const rz = (Math.random() < 0.5 ? -1 : 1) * 0.45
    void this.tween(2.6, (k) => {
      const e = ease(k)
      obj.position.y = y0 - e * (obj.userData.h as number) * 0.55
      obj.rotation.z = rz * e
      obj.rotation.x = 0.12 * e
    })
  }

  // ---- effects ---------------------------------------------------------------------------------

  private tween(dur: number, fn: (k: number) => void): Promise<void> {
    return new Promise((res) => this.tweens.push({ t: 0, dur, fn, res }))
  }

  private burst(pos: THREE.Vector3, o: BurstOpts): void {
    const { count, color, speed, up, g = 9, life = 0.8, s0 = 0.06, s1 = 0.02, opacity = 1, soft = false, drift = 0, push = null } = o
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }))
      m.position.copy(pos)
      const a = Math.random() * Math.PI * 2
      const sp = speed * (0.4 + Math.random() * 0.6)
      const vel = new THREE.Vector3(Math.cos(a) * sp + drift, up * (0.6 + Math.random() * 0.6), Math.sin(a) * sp)
      if (push) vel.addScaledVector(push, 0.6 + Math.random() * 0.6)
      if (soft) m.material.opacity = 0
      m.scale.setScalar(s0)
      this.scene.add(m)
      this.parts.push({ m, vel, g, life: 0, max: life * (0.7 + Math.random() * 0.5), s0, s1, o0: opacity, soft })
    }
  }

  private ring(pos: THREE.Vector3, color: string, size: number): void {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.copy(pos)
    m.position.y = 0.04
    m.scale.setScalar(0.1)
    this.scene.add(m)
    void this.tween(0.7, (k) => {
      m.scale.setScalar(0.1 + k * size)
      m.material.opacity = 0.9 * (1 - k)
    }).then(() => this.scene.remove(m))
  }

  private flash(pos: THREE.Vector3): void {
    const l = new THREE.PointLight('#ffae42', 30, 6)
    l.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0))
    this.scene.add(l)
    void this.tween(0.5, (k) => {
      l.intensity = 30 * (1 - k)
    }).then(() => this.scene.remove(l))
  }

  private aimAt(board: Board, cell: number): void {
    const c = this.cannons[board]
    const p = this.cellPos(board, cell)
    c.aim = Math.atan2(p.x - c.base.position.x, p.z - c.base.position.z)
  }

  private fireFx(c: Cannon, at: THREE.Vector3): void {
    const dir = new THREE.Vector3(Math.sin(c.yaw.rotation.y), 0.25, Math.cos(c.yaw.rotation.y))
    void this.tween(0.5, (k) => {
      c.gun.position.z = k < 0.1 ? (-0.24 * k) / 0.1 : -0.24 * (1 - ease((k - 0.1) / 0.9))
    })
    this.flash(at.clone().add(new THREE.Vector3(0, -0.5, 0)))
    this.burst(at, { count: 16, color: '#ffd04a', speed: 0.5, up: 0.3, g: 0, life: 0.22, s0: 0.1, s1: 0.02, push: dir.clone().multiplyScalar(2.6) })
    this.burst(at, {
      count: 12,
      color: '#d9dde0',
      speed: 0.35,
      up: 0.35,
      g: -0.12,
      life: 1.8,
      s0: 0.12,
      s1: 0.55,
      opacity: 0.6,
      soft: true,
      push: dir.clone().multiplyScalar(0.7),
    })
    this.shake = c === this.cannons.enemy ? 0.12 : 0.05
  }

  // ---- frame loop ------------------------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return
    const dt = Math.min(this.clock.getDelta(), 0.05)
    const t = this.clock.elapsedTime
    this.waterMat.uniforms.t.value = t

    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i]
      tw.t += dt
      const k = Math.min(1, tw.t / tw.dur)
      tw.fn(k)
      if (k >= 1) {
        this.tweens.splice(i, 1)
        tw.res()
      }
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]
      p.life += dt
      const k = p.life / p.max
      if (k >= 1) {
        this.scene.remove(p.m)
        p.m.material.dispose()
        this.parts.splice(i, 1)
        continue
      }
      p.vel.y -= p.g * dt
      p.m.position.addScaledVector(p.vel, dt)
      if (p.soft) {
        p.m.scale.setScalar(p.s0 + (p.s1 - p.s0) * (1 - Math.pow(1 - k, 2)))
        p.m.material.opacity = p.o0 * Math.sin(Math.PI * Math.min(1, k * 1.15)) * (k < 1 / 1.15 ? 1 : 0)
      } else {
        p.m.scale.setScalar(p.s0 + (p.s1 - p.s0) * k)
        p.m.material.opacity = p.o0 * (1 - k)
      }
    }
    for (const o of this.bobbers) {
      if (o.userData.sinking) continue
      o.position.y = (o.userData.baseY as number) + Math.sin(t * 1.6 + (o.userData.bob as number)) * 0.035
      o.rotation.z = Math.sin(t * 1.1 + (o.userData.bob as number)) * 0.04 + ((o.userData.rz as number) || 0)
    }
    const wp = new THREE.Vector3()
    this.fires.forEach((f, fi) => {
      f.cones.forEach((c, i) => {
        const ph = i * 1.7 + fi * 2.3
        const s = 1 + Math.sin(t * 5.2 + ph) * 0.12 + Math.sin(t * 8.3 + ph * 1.3) * 0.07
        c.scale.set(1 - (s - 1) * 0.4, s, 1 - (s - 1) * 0.4)
        c.rotation.z = Math.sin(t * 3.1 + ph) * 0.08
      })
      f.emit -= dt
      if (f.emit <= 0) {
        f.emit = 0.1 + Math.random() * 0.05
        f.g.getWorldPosition(wp)
        wp.y += 0.3
        wp.x += (Math.random() - 0.5) * 0.1
        wp.z += (Math.random() - 0.5) * 0.1
        this.burst(wp, { count: 1, color: '#575d63', speed: 0.05, up: 0.55, g: -0.08, life: 2.2, s0: 0.07, s1: 0.34, opacity: 0.32, soft: true, drift: 0.12 })
      }
    })
    if (this.target.visible) this.target.scale.setScalar(1 + Math.sin(t * 6) * 0.06)
    for (const g of this.ghosts.values()) if (g.visible) g.position.y = 0.14 + Math.sin(t * 4) * 0.04
    for (const f of this.foamRings) {
      f.m.scale.setScalar(1 + Math.sin(t * 1.1 + f.ph) * 0.05)
      f.m.material.opacity = 0.22 + Math.sin(t * 1.1 + f.ph) * 0.1
    }
    for (const c of Object.values(this.cannons)) {
      let d = c.aim - c.yaw.rotation.y
      d = Math.atan2(Math.sin(d), Math.cos(d))
      c.yaw.rotation.y += d * Math.min(1, dt * 7)
    }
    this.camera.position.copy(this.camTarget).addScaledVector(this.camDir, this.camDist)
    if (this.shake > 0.002) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake
      this.camera.position.y += (Math.random() - 0.5) * this.shake
      this.shake *= Math.pow(0.01, dt)
    }
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z + 0.35)
    this.renderer.render(this.scene, this.camera)
    this.raf = requestAnimationFrame(this.loop)
  }
}

function isHoriz(cells: number[]): boolean {
  return cells.length < 2 || cells[1] - cells[0] === 1
}

function isDescendant(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true
  return false
}
