'use client'

import { FLEET } from '@/src/battleship/constants'
import type { Seat } from '@/src/battleship/types'
import type { BattleMatchView } from '@/src/battleship/views'

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

function Avatar({ name, url, foe }: { name: string; url: string | null; foe?: boolean }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="size-8 flex-none rounded-full object-cover" />
  }
  return (
    <div
      className={`grid size-8 flex-none place-items-center rounded-full font-display text-[13px] text-white ${
        foe ? 'bg-rose-900/70' : 'bg-sky-700'
      }`}
    >
      {initial(name)}
    </div>
  )
}

/** Fleet pips: one block per ship cell. Your own hits show red; the enemy's ships only grey out once sunk. */
function Pips({ view, seat, own }: { view: BattleMatchView; seat: Seat; own: boolean }) {
  const other: Seat = seat === 'a' ? 'b' : 'a'
  const incoming = view.shots[other]
  const sunk = new Set(incoming.filter((s) => s.result === 'sunk').map((s) => s.shipKey))
  const hitCells = new Set(incoming.filter((s) => s.result !== 'miss').map((s) => s.cell))
  return (
    <div className={`flex gap-0.5 ${own ? '' : 'justify-end'}`}>
      {FLEET.map((def) => {
        const ship = view.fleets[seat].find((s) => s.key === def.key)
        const isSunk = sunk.has(def.key)
        return (
          <span key={def.key} className={`flex gap-px ${isSunk ? 'opacity-35' : ''}`} title={def.name}>
            {Array.from({ length: def.len }, (_, k) => {
              const hit = own && ship ? hitCells.has(ship.cells[k]) : false
              return (
                <i
                  key={k}
                  className={`block h-[9px] w-1 rounded-[1px] ${isSunk ? 'bg-muted' : hit ? 'bg-o' : 'bg-text'}`}
                />
              )
            })}
          </span>
        )
      })}
    </div>
  )
}

export function MatchHud({ view, clockMs, label }: { view: BattleMatchView; clockMs: number | null; label: string }) {
  const me: Seat = view.you ?? 'a'
  const foe: Seat = me === 'a' ? 'b' : 'a'
  const p1 = view.players[me]
  const p2 = view.players[foe]
  const yourTurn = view.status === 'playing' && view.turn === view.you
  const theirTurn = view.status === 'playing' && view.turn !== null && view.turn !== view.you
  const secs = clockMs === null ? null : Math.ceil(clockMs / 1000)
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-[14px] border border-white/15 bg-white/10 px-2.5 py-2 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={p1?.name ?? '?'} url={p1?.avatarUrl ?? null} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-xs font-bold">{view.you ? 'You' : (p1?.name ?? '?')}</span>
          <Pips view={view} seat={me} own={!!view.you} />
        </div>
      </div>
      <div className="flex flex-col items-center gap-1">
        <span
          className={`rounded-full bg-black/25 px-2.5 py-1 font-display text-[11px] whitespace-nowrap ${
            yourTurn ? 'text-amber-300' : theirTurn ? 'text-o' : 'text-muted'
          }`}
        >
          {label}
        </span>
        {secs !== null && (
          <span className={`font-display text-sm tabular-nums ${secs <= 5 ? 'text-o' : 'text-text'}`}>0:{String(secs).padStart(2, '0')}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-row-reverse items-center gap-2 text-right">
        <Avatar name={p2?.name ?? '?'} url={p2?.avatarUrl ?? null} foe />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-xs font-bold">{p2?.name ?? '?'}</span>
          <Pips view={view} seat={foe} own={false} />
        </div>
      </div>
    </header>
  )
}
