'use client'

import { useState } from 'react'
import { N } from '@/src/battleship/constants'

const COLS = 'ABCDEFGHIJ'
export const coordName = (cell: number) => `${COLS[cell % N]}${Math.floor(cell / N) + 1}`

const ROUND =
  'grid size-[78px] flex-none place-items-center rounded-full font-display text-[17px] font-bold transition active:translate-y-1 disabled:translate-y-0'
export const FIRE_BTN = `${ROUND} bg-[radial-gradient(circle_at_50%_35%,#ffd36b,#ffb627_55%,#c9820a)] text-[#3b2200] shadow-[0_6px_0_#8a5600,0_10px_22px_rgba(0,0,0,.4)] disabled:grayscale disabled:brightness-[.55]`
export const READY_BTN = `${ROUND} bg-[radial-gradient(circle_at_50%_35%,#8af0b6,#4fd18b_55%,#2a9a5e)] text-[#06301a] shadow-[0_6px_0_#1d6b41,0_10px_22px_rgba(0,0,0,.4)] disabled:grayscale disabled:brightness-[.55]`
const TOOL =
  'h-11 rounded-[14px] border border-white/15 bg-white/10 px-3 font-display text-sm text-white backdrop-blur-md active:translate-y-0.5 disabled:opacity-50'

export function BattleControls({
  target,
  shots,
  canFire,
  busy,
  onFire,
  onResign,
}: {
  target: number | null
  shots: number
  canFire: boolean
  busy: boolean
  onFire: () => void
  onResign: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  if (confirm) {
    return (
      <div className="flex items-center gap-2 rounded-[14px] border border-white/15 bg-white/10 p-2.5 text-sm backdrop-blur-md">
        <span className="flex-1">Give up this battle? Your opponent wins.</span>
        <button type="button" onClick={() => setConfirm(false)} className={TOOL}>
          Keep playing
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirm(false)
            onResign()
          }}
          className={`${TOOL} border-o/60 text-o`}
        >
          Give up
        </button>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <div className="flex flex-col gap-0.5 text-[10px] font-extrabold tracking-wider text-muted uppercase">
        Target
        <b className="font-display text-xl font-semibold tracking-normal text-text normal-case tabular-nums">
          {target === null ? '—' : coordName(target)}
        </b>
      </div>
      <button type="button" disabled={!canFire || busy} onClick={onFire} className={FIRE_BTN}>
        FIRE
      </button>
      <div className="flex flex-col items-end gap-1 text-[10px] font-extrabold tracking-wider text-muted uppercase">
        <span>
          Shots <b className="font-display text-base tracking-normal text-text tabular-nums">{shots}</b>
        </span>
        <button type="button" onClick={() => setConfirm(true)} className="text-[11px] font-bold text-muted underline normal-case">
          Give up
        </button>
      </div>
    </div>
  )
}

export function PlacementButtons({
  canReady,
  locked,
  onRotate,
  onReady,
  onRandom,
}: {
  canReady: boolean
  locked: boolean
  onRotate: () => void
  onReady: () => void
  onRandom: () => void
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <button type="button" disabled={locked} onClick={onRotate} className={TOOL}>
        ↻ Rotate
      </button>
      <button type="button" disabled={!canReady || locked} onClick={onReady} className={READY_BTN}>
        {locked ? '✓' : 'READY'}
      </button>
      <button type="button" disabled={locked} onClick={onRandom} className={TOOL}>
        Random
      </button>
    </div>
  )
}
