'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useRouter } from 'next/navigation'
import { BackButton } from '@/src/client/back-button'
import { ApiError, apiPost } from '@/src/client/api'
import { usePoll } from '@/src/client/use-poll'
import { battleshipMatchChannel } from '@/src/realtime/channels'
import { FLEET } from '@/src/battleship/constants'
import type { Seat, Ship } from '@/src/battleship/types'
import type { BattleMatchView } from '@/src/battleship/views'
import { BattleControls, PlacementButtons, coordName } from '@/src/client/battleship/battle-controls'
import { MatchHud } from '@/src/client/battleship/match-hud'
import { FloatingRotate, ShipTray, usePlacement, type Placement } from '@/src/client/battleship/placement-controls'
import { boardOf, newShots, type Board, type NewShot } from '@/src/client/battleship/sync'
import { useBattleScene } from '@/src/client/battleship/use-battle-scene'

type Handlers = Pick<Placement, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerLeave'>

const other = (s: Seat): Seat => (s === 'a' ? 'b' : 'a')
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const shipName = (key: string | null) => FLEET.find((f) => f.key === key)?.name ?? 'ship'

const END_COPY: Record<string, string> = {
  fleet_sunk: 'Fleet sunk',
  no_show: "Opponent didn't show up",
  afk: 'Too many missed turns',
  disconnect_timeout: 'Opponent disconnected',
  resign: 'Opponent gave up',
  left: 'Opponent left the cup',
}

/** Which sea the camera should show for this view (null: leave it where it is). */
function focusBoard(v: BattleMatchView): Board | null {
  if (v.status === 'playing' && v.turn) return boardOf(v.you, other(v.turn))
  if (v.status === 'placing' || v.status === 'pending') return 'me'
  return null
}

function shotMessage(s: NewShot, you: Seat | null): string {
  const at = coordName(s.shot.cell)
  const auto = s.shot.auto ? 'Random shot: ' : ''
  if (s.board === 'enemy' || !you) {
    if (s.shot.result === 'sunk') return `${auto}Sank the ${shipName(s.shot.shipKey)}!`
    if (s.shot.result === 'hit') return `${auto}Hit! ${at}`
    return `${auto}Miss at ${at}`
  }
  if (s.shot.result === 'sunk') return `Your ${shipName(s.shot.shipKey)} was sunk!`
  if (s.shot.result === 'hit') return `Hit at ${at}!`
  return `They missed at ${at}`
}

export default function BattleMatchPage() {
  const { code, matchId } = useParams<{ code: string; matchId: string }>()
  const router = useRouter()
  const path = `/api/battleship/${code}/matches/${matchId}`
  const poll = usePoll<BattleMatchView>(path, 1_000, { channel: battleshipMatchChannel(code, matchId), liveIntervalMs: 2_000 })
  const [override, setOverride] = useState<BattleMatchView | null>(null)
  const view = override && (!poll.data || override.serverNow > poll.data.serverNow) ? override : poll.data

  // Element state (not refs): the canvas mounts only once the first view arrives, and the scene must
  // be created then, even if the (cached) models finished loading long before.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null)
  const { scene, error: sceneError } = useBattleScene(canvasEl, stageEl)

  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2_000)
  }, [])

  // ---- clock: count down locally from when each view arrived ----
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const [stamp, setStamp] = useState({ sn: -1, at: 0 })
  if (view && stamp.sn !== view.serverNow) setStamp({ sn: view.serverNow, at: now })
  const left = (ms: number | null) => (ms === null ? null : Math.max(0, ms - (now - stamp.at)))

  // ---- keep the scene in step with the views, animating new shots in order ----
  const shown = useRef<BattleMatchView | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!scene || !view) return
    const v = view
    chain.current = chain.current
      .then(async () => {
        const prev = shown.current
        if (prev && v.serverNow <= prev.serverNow) return
        const me: Seat = v.you ?? 'a'
        const foe = other(me)
        if (!prev) {
          const f = focusBoard(v)
          if (f) await scene.focus(f, true)
        } else {
          const fresh = newShots(prev, v)
          if (fresh.length > 0 && fresh.length <= 4) {
            for (const s of fresh) {
              await scene.focus(s.board)
              if (s.board === 'enemy') scene.setTarget(null)
              await scene.playShot(s.board, s.shot, s.sunkShip)
              say(shotMessage(s, v.you), s.board === 'me' && s.shot.result !== 'miss')
              await wait(350)
            }
          }
        }
        // While you place your fleet, the placement layer owns your ships.
        if (!(v.status === 'placing' && v.you)) scene.setFleet('me', v.fleets[me])
        scene.setFleet('enemy', v.fleets[foe])
        scene.setShots('me', v.shots[foe])
        scene.setShots('enemy', v.shots[me])
        shown.current = v
        const f = focusBoard(v)
        if (f) await scene.focus(f)
      })
      .catch((e: unknown) => console.error(e))
  }, [scene, view, say])

  // ---- missed turns ----
  const missed = view?.you ? view.missedTurns[view.you] : 0
  const lastMissed = useRef(0)
  useEffect(() => {
    if (missed > lastMissed.current) say(`Missed turn: a random shot was fired for you (${missed}/3)`, true)
    lastMissed.current = missed
  }, [missed, say])

  // ---- aiming ----
  const [picked, setTarget] = useState<number | null>(null)
  const yourTurn = !!view && view.status === 'playing' && view.you !== null && view.turn === view.you
  const target = yourTurn ? picked : null
  useEffect(() => {
    if (!yourTurn) scene?.setTarget(null)
  }, [yourTurn, scene])

  const [busy, setBusy] = useState(false)
  const post = useCallback(
    async (action: string, body?: unknown) => {
      try {
        const v = await apiPost<BattleMatchView>(`${path}/${action}`, body)
        setOverride(v)
        return v
      } catch (e) {
        const c = e instanceof ApiError ? e.code : 'unknown'
        if (!['not_your_turn', 'occupied', 'not_playing', 'not_placing', 'locked'].includes(c)) {
          say('Something went wrong. Try again.', true)
        }
        poll.refresh()
        return null
      }
    },
    [path, poll, say],
  )

  const fire = useCallback(async () => {
    if (!view?.you || target === null || busy) return
    setBusy(true)
    await post('fire', { cell: target, seq: view.shots[view.you].length + 1 })
    setTarget(null)
    scene?.setTarget(null)
    setBusy(false)
  }, [view, target, busy, post, scene])

  const save = useCallback(
    async (ships: Ship[], lock: boolean) => (await post('fleet', { ships, lock })) !== null,
    [post],
  )

  // ---- pointer input: placement layer when placing, aiming when it's your turn ----
  const placementHandlers = useRef<Handlers | null>(null)
  const bindPlacement = useCallback((h: Handlers | null) => {
    placementHandlers.current = h
  }, [])
  const downAt = useRef<[number, number] | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    downAt.current = [e.clientX, e.clientY]
    placementHandlers.current?.onPointerDown(e)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => placementHandlers.current?.onPointerMove(e)
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (placementHandlers.current) {
      placementHandlers.current.onPointerUp(e)
      return
    }
    const d = downAt.current
    downAt.current = null
    if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 10) return
    if (!scene || !view?.you || !yourTurn) return
    const cell = scene.pickCell(e.clientX, e.clientY, 'enemy')
    if (cell < 0) return
    if (view.shots[view.you].some((s) => s.cell === cell)) {
      say(`${coordName(cell)} was already fired at`)
      return
    }
    setTarget(cell)
    scene.setTarget(cell)
  }

  if (!view) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 p-4 text-sm text-muted">
        {poll.error?.status === 404 ? 'Match not found.' : poll.error ? 'Could not load the match. Retrying…' : 'Loading…'}
        <button onClick={() => router.push(`/b/${code}`)} className="rounded-xl border border-line bg-panel2 px-4 py-2.5">
          Back to bracket
        </button>
      </main>
    )
  }

  const you = view.you
  const placingMine = view.status === 'placing' && you !== null
  const foeName = view.players[other(you ?? 'a')]?.name ?? 'Opponent'
  const label =
    view.status === 'pending'
      ? 'Get ready'
      : view.status === 'placing'
        ? 'Place your fleet'
        : view.status === 'playing'
          ? yourTurn
            ? 'Your turn'
            : you
              ? "Opponent's turn"
              : `${view.players[view.turn ?? 'a']?.name ?? '?'}'s turn`
          : 'Battle over'
  const clock =
    view.status === 'placing' ? left(view.placingRemainingMs) : view.status === 'playing' ? left(view.turnRemainingMs) : left(view.pendingRemainingMs)
  const hint = !you
    ? '👁 Watching'
    : view.status === 'pending'
      ? `Waiting for ${foeName} to open the match`
      : view.status === 'playing'
        ? yourTurn
          ? target === null
            ? 'Tap a square in enemy waters to aim'
            : 'Press FIRE, or pick another square'
          : `${foeName} is aiming…`
        : ''

  return (
    <main className="mx-auto flex h-dvh w-full max-w-md flex-col gap-2.5 px-3 pt-2 pb-3">
      <div className="flex items-center gap-2">
        <BackButton onClick={() => router.push(`/b/${code}`)} label="Back to bracket" />
        <div className="min-w-0 flex-1 truncate font-display text-sm text-white">
          {view.roundName} · #{view.id}
        </div>
        {!you && <span className="lime-pill">👁 WATCHING</span>}
      </div>

      <MatchHud view={view} clockMs={clock} label={label} />

      <div ref={setStageEl} className="relative min-h-0 flex-1 overflow-hidden rounded-[22px] border border-line bg-[#2b8db3]">
        <canvas
          ref={setCanvasEl}
          className="block size-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => placementHandlers.current?.onPointerLeave()}
        />
        {view.status === 'playing' && you && !yourTurn && (
          <div className="pointer-events-none absolute inset-0 rounded-[22px] shadow-[inset_0_0_0_3px_rgba(255,90,60,.6),inset_0_0_40px_rgba(255,90,60,.3)]" />
        )}
        {toast && (
          <div
            className={`pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-[#0b1f33]/85 px-4 py-2 font-display text-sm whitespace-nowrap ${
              toast.bad ? 'text-rose-200 shadow-[inset_0_0_0_2px_var(--o)]' : 'text-white'
            }`}
          >
            {toast.text}
          </div>
        )}
        {view.opponentDisconnected && view.opponentReconnectRemainingMs !== null && (
          <div className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 rounded-full bg-amber-500/90 px-3 py-1 text-xs font-bold text-amber-950">
            Opponent disconnected · {Math.ceil((left(view.opponentReconnectRemainingMs) ?? 0) / 1000)}s
          </div>
        )}
        {hint && !placingMine && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 text-center text-[13px] font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]">
            {hint}
          </div>
        )}
        {!scene && (
          <div className="absolute inset-0 grid place-items-center bg-bg font-display text-muted">
            {sceneError ?? 'Loading the sea…'}
          </div>
        )}
        {view.status === 'finished' && <ResultPanel view={view} code={code} />}
      </div>

      {placingMine ? (
        <PlacementLayer
          key={view.id}
          view={view}
          scene={scene}
          stage={stageEl}
          save={save}
          say={say}
          bind={bindPlacement}
        />
      ) : view.status === 'playing' && you ? (
        <BattleControls
          target={target}
          shots={view.shots[you].length}
          canFire={yourTurn && target !== null}
          busy={busy}
          onFire={fire}
          onResign={() => void post('resign')}
        />
      ) : (
        <div className="h-[78px]" />
      )}
    </main>
  )
}

function PlacementLayer({
  view,
  scene,
  stage,
  save,
  say,
  bind,
}: {
  view: BattleMatchView
  scene: ReturnType<typeof useBattleScene>['scene']
  stage: HTMLDivElement | null
  save: (ships: Ship[], lock: boolean) => Promise<boolean>
  say: (text: string, bad?: boolean) => void
  bind: (h: Handlers | null) => void
}) {
  const p = usePlacement({ scene, view, save, toast: (t) => say(t, true) })
  useEffect(() => {
    bind(p)
    return () => bind(null)
  }, [p, bind])
  return (
    <>
      {stage &&
        createPortal(
          <>
            <div className="pointer-events-none absolute inset-x-3 bottom-[78px] text-center text-[13px] font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]">
              {p.hint}
            </div>
            {!p.locked && <ShipTray p={p} />}
            <FloatingRotate p={p} scene={scene} />
          </>,
          stage,
        )}
      <PlacementButtons
        canReady={p.ships.length === FLEET.length}
        locked={p.locked}
        onRotate={p.rotate}
        onReady={p.ready}
        onRandom={p.random}
      />
    </>
  )
}

function ResultPanel({ view, code }: { view: BattleMatchView; code: string }) {
  const router = useRouter()
  const you = view.you
  const won = you !== null && view.winner === you
  const winnerName = view.winner ? view.players[view.winner]?.name : null
  const mine = you ? view.shots[you] : []
  const hits = mine.filter((s) => s.result !== 'miss').length
  const title = you === null ? `${winnerName ?? '?'} wins` : won ? 'Victory!' : 'Defeat'
  const reason = view.endReason ? END_COPY[view.endReason] : ''
  const reasonText = won || you === null ? reason : view.endReason === 'fleet_sunk' ? 'Your fleet was sunk' : view.endReason === 'resign' ? 'You gave up' : view.endReason === 'left' ? 'You left the cup' : view.endReason === 'afk' ? 'Too many missed turns' : reason
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#0b1f33]/70">
      <div className="flex max-w-[290px] flex-col items-center gap-2.5 p-5 text-center">
        <h2 className={`font-display text-4xl ${won ? 'text-amber-300' : 'text-white'}`}>{title}</h2>
        <p className="font-bold text-sky-100/80">{reasonText}</p>
        {you && (
          <div className="grid w-full grid-cols-2 gap-2">
            <div className="rounded-xl border border-line bg-panel p-2.5">
              <b className="block font-display text-xl tabular-nums">{mine.length}</b>
              <span className="text-[10px] font-extrabold tracking-wider text-muted uppercase">Shots</span>
            </div>
            <div className="rounded-xl border border-line bg-panel p-2.5">
              <b className="block font-display text-xl tabular-nums">{mine.length ? Math.round((hits / mine.length) * 100) : 0}%</b>
              <span className="text-[10px] font-extrabold tracking-wider text-muted uppercase">Accuracy</span>
            </div>
          </div>
        )}
        {view.nextMatchId && (
          <button
            onClick={() => router.push(`/b/${code}/m/${view.nextMatchId}`)}
            className="arcade-glow w-full rounded-xl bg-accent p-3 font-display text-sm tracking-wider text-white uppercase"
          >
            Next match →
          </button>
        )}
        <button
          onClick={() => router.push(`/b/${code}`)}
          className="w-full rounded-xl border border-line bg-panel2 p-3 font-display text-sm tracking-wider uppercase"
        >
          Back to bracket
        </button>
      </div>
    </div>
  )
}
