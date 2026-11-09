'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { getStartParam, initTelegram } from '@/src/client/telegram'
import { putPollCache, usePoll } from '@/src/client/use-poll'

interface Me {
  user: { id: string; name: string; avatarUrl: string | null }
  active: { game: 'caro' | 'sudoku' | 'battleship'; code: string; matchId: string | null } | null
}

const activePath = (a: NonNullable<Me['active']>) =>
  a.game === 'caro' && a.matchId
    ? `/r/${a.code}/m/${a.matchId}`
    : a.game === 'battleship' && a.matchId
      ? `/b/${a.code}/m/${a.matchId}`
      : roomPath(a.code)

/** True only the first time this session (sessionStorage flag). */
function firstBoot(): boolean {
  try {
    if (sessionStorage.getItem('booted')) return false
    sessionStorage.setItem('booted', '1')
    return true
  } catch {
    return false
  }
}

export default function GamePicker() {
  const router = useRouter()
  const [booting, setBooting] = useState(true)
  const me = usePoll<Me>(booting ? null : '/api/me', 30_000)

  // First open: a ref link goes straight to its room; otherwise resume wherever you're active.
  useEffect(() => {
    initTelegram()
    if (!firstBoot()) {
      void Promise.resolve().then(() => setBooting(false))
      return
    }
    const start = getStartParam()
    if (start) {
      router.replace(`${roomPath(start.toUpperCase())}?join=1`)
      return
    }
    apiGet<Me>('/api/me')
      .then((m) => {
        putPollCache('/api/me', m)
        if (m.active) router.replace(activePath(m.active))
        else setBooting(false)
      })
      .catch(() => setBooting(false))
  }, [router])

  if (booting) {
    return <main className="flex flex-1 items-center justify-center font-display text-sm text-muted">Loading…</main>
  }

  const user = me.data?.user
  const firstName = user?.name.split(' ')[0]
  const initial = [...(user?.name ?? '').trim()][0]?.toUpperCase() ?? 'G'
  const active = me.data?.active ?? null

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 p-4">
      {/* Header + hero, with snow falling behind them; it fades out just above "Originals Games". */}
      <div className="relative isolate flex flex-col gap-4">
        <div aria-hidden className="snowfall absolute -inset-x-4 -top-4 -bottom-4 -z-10" />
        <header className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="arcade-glow grid size-10 flex-none place-items-center rounded-xl bg-gradient-to-br from-[#6c79ff] to-[#a855f7] font-display text-lg text-white">
              🏆
            </div>
            <div className="min-w-0">
              <div className="font-display text-[17px] leading-tight text-white">Game Cup</div>
              <div className="truncate text-xs font-semibold text-muted">
                {firstName ? `Hi, ${firstName}` : 'Telegram Arcade'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {active && (
              <button
                onClick={() => router.push(activePath(active))}
                className="flex items-center gap-1.5 rounded-xl border border-line bg-panel px-2.5 py-1.5 font-display text-xs text-white"
              >
                <span className="size-2 rounded-full bg-lime shadow-[0_0_8px_var(--lime)]" />
                <span>{active.code}</span>
              </button>
            )}
            {user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt=""
                className="size-9 flex-none rounded-xl border-2 border-lime object-cover"
              />
            ) : (
              <div className="grid size-9 flex-none place-items-center rounded-xl border-2 border-lime bg-gradient-to-br from-lime-400 to-emerald-500 font-display text-sm font-bold text-slate-900">
                {initial}
              </div>
            )}
          </div>
        </header>

        <div className="glow-clip relative rounded-[22px] border border-[#8b95ff]/25 bg-gradient-to-br from-[#272d52] via-[#1b2038] to-[#171b2d] p-5 shadow-lg">
          <div className="pointer-events-none absolute -right-2 -bottom-2 grid size-32 -rotate-6 place-items-center text-[64px] drop-shadow-lg">
            ❄️
          </div>
          <div className="max-w-[225px] font-display text-[22px] leading-[1.08] tracking-wide text-white uppercase">
            {active ? `YOUR ${active.game.toUpperCase()} ROOM IS LIVE!` : 'GAME CUP TOURNAMENT INVITES YOU!'}
          </div>
          <div className="mt-2">
            <span className="lime-pill">● {active ? `ACTIVE · ${active.code}` : '3 GAMES · INSTANT PLAY'}</span>
          </div>
          <button
            onClick={() => router.push(active ? activePath(active) : '/caro')}
            className="mt-3.5 inline-flex items-center gap-2.5 rounded-xl border border-[#8b95ff]/45 bg-[#6c79ff]/25 py-2 pr-3.5 pl-2 font-display text-xs font-bold tracking-wider text-white uppercase"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-white shadow-[0_2px_6px_rgba(108,121,255,0.35)]">
              ▶
            </span>
            <span>{active ? `RESUME ${active.code}` : 'EXPLORE TOURNAMENTS'}</span>
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="font-display text-lg text-white">Originals Games</div>
        <span className="lime-pill">TELEGRAM MINI APP</span>
      </div>

      <GameCard
        title="Caro Knockout"
        badge="KNOCKOUT CUP"
        blurb="Five in a row on a 100×100 board. Knockout bracket, bots fill the empty seats."
        statLabel="Format"
        statValue="Bo1 · Bo3"
        thumbClass="bg-[radial-gradient(circle_at_30%_25%,#4f46e5,#1e1b4b_85%)]"
        art={
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-950/55 p-1.5 backdrop-blur-xs">
            {['X', 'O', 'X', '', 'X', 'O', 'O', '', 'X'].map((c, i) => (
              <span
                key={i}
                className={`grid size-6 place-items-center rounded-md bg-white/10 font-display text-sm ${
                  c === 'X' ? 'text-[#60a5fa]' : 'text-[#fb7185]'
                }`}
              >
                {c}
              </span>
            ))}
          </div>
        }
        onClick={() => router.push('/caro')}
      />
      <GameCard
        title="Sudoku Race"
        badge="SPEED RACE & SOLO"
        blurb="9×9 race on the same random puzzle, or play solo. 30 minutes, −30 s per mistake."
        statLabel="Time limit"
        statValue="30:00"
        thumbClass="bg-[radial-gradient(circle_at_30%_25%,#0ea5e9,#172554_85%)]"
        art={
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-950/55 p-1.5 backdrop-blur-xs">
            {['5', '', '3', '', '7', '', '9', '', '1'].map((c, i) => (
              <span
                key={i}
                className="grid size-6 place-items-center rounded-md bg-white/10 font-display text-sm text-yellow-300"
              >
                {c}
              </span>
            ))}
          </div>
        }
        onClick={() => router.push('/sudoku')}
      />
      <GameCard
        title="Battleship Cup"
        badge="KNOCKOUT CUP"
        blurb="Hide your pirate fleet, then sink theirs. 6×6 sea, Bo1 knockout, friends only."
        statLabel="Format"
        statValue="Bo1"
        thumbClass="bg-[radial-gradient(circle_at_30%_25%,#0284c7,#082f49_85%)]"
        art={
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/assets/Previews/ship-pirate-large.png" alt="" className="w-[92px] drop-shadow-lg" />
        }
        onClick={() => router.push('/battleship')}
      />
    </main>
  )
}

function GameCard({
  title,
  badge,
  blurb,
  statLabel,
  statValue,
  thumbClass,
  art,
  onClick,
}: {
  title: string
  badge: string
  blurb: string
  statLabel: string
  statValue: string
  thumbClass: string
  art: React.ReactNode
  onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      className="glow-clip flex cursor-pointer items-stretch gap-3.5 rounded-[20px] border border-line bg-panel p-3 text-left transition hover:border-accent/50 active:scale-[0.99]"
    >
      <div className={`grid w-[108px] flex-none place-items-center overflow-hidden rounded-[15px] ${thumbClass}`}>
        {art}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          <div className="font-display text-[17px] text-white">{title}</div>
          <div className="mt-1">
            <span className="lime-pill">{badge}</span>
          </div>
          <p className="mt-1.5 mb-2.5 font-sans text-[11px] leading-[1.4] text-muted">{blurb}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-[11px] bg-accent px-3.5 py-2 font-display text-xs font-bold tracking-wider text-white uppercase ring-1 ring-[#8b95ff]/35">
            PLAY NOW
          </span>
          <div className="rounded-[10px] border border-line bg-bg px-2.5 py-1 font-sans text-[10px] text-muted">
            {statLabel}
            <b className="block font-display text-xs text-white">{statValue}</b>
          </div>
        </div>
      </div>
    </div>
  )
}
