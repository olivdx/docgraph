'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet } from '@/src/client/api'
import { roomPath } from '@/src/client/routes'
import { getStartParam, initTelegram } from '@/src/client/telegram'
import { usePoll } from '@/src/client/use-poll'

interface Me {
  user: { id: string; name: string; avatarUrl: string | null }
  active: { game: 'caro' | 'sudoku'; code: string; matchId: string | null } | null
}

const activePath = (a: NonNullable<Me['active']>) =>
  a.game === 'caro' && a.matchId ? `/r/${a.code}/m/${a.matchId}` : roomPath(a.code)

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
        if (m.active) router.replace(activePath(m.active))
        else setBooting(false)
      })
      .catch(() => setBooting(false))
  }, [router])

  if (booting) {
    return <main className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</main>
  }

  const firstName = me.data?.user.name.split(' ')[0]
  const active = me.data?.active ?? null

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <div>
        <div className="text-[22px] font-bold">Game Cup</div>
        {firstName && (
          <div className="text-[13px] text-muted">
            Hi, <b className="text-text">{firstName}</b>. What are we playing?
          </div>
        )}
      </div>

      {active && (
        <div className="flex items-center gap-3 rounded-xl border border-accent bg-[#1a2537] p-3">
          <div className="flex-1 text-sm">
            You&apos;re in a {active.game === 'caro' ? 'Caro tournament' : 'Sudoku room'}{' '}
            <b className="font-mono">{active.code}</b>
          </div>
          <button
            onClick={() => router.push(activePath(active))}
            className="rounded-[9px] bg-accent px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            Resume
          </button>
        </div>
      )}

      <GameCard
        title="Caro"
        blurb="Five in a row, knockout tournaments. Bots fill the empty seats."
        art={
          <div className="grid grid-cols-3 gap-1 text-2xl font-black leading-none">
            {['X', 'O', 'X', '', 'X', 'O', 'O', '', 'X'].map((c, i) => (
              <span key={i} className={`grid size-7 place-items-center ${c === 'X' ? 'text-x' : 'text-o'}`}>
                {c}
              </span>
            ))}
          </div>
        }
        onClick={() => router.push('/caro')}
      />
      <GameCard
        title="Sudoku"
        blurb="9×9 race on the same random puzzle, or play solo. 30 minutes, −30 s per mistake."
        art={
          <div className="grid grid-cols-3 gap-px bg-slate-400 p-px">
            {['5', '', '3', '', '7', '', '9', '', '1'].map((c, i) => (
              <span key={i} className="grid size-7 place-items-center bg-paper text-base font-bold text-slate-800">
                {c}
              </span>
            ))}
          </div>
        }
        onClick={() => router.push('/sudoku')}
      />
    </main>
  )
}

function GameCard({ title, blurb, art, onClick }: { title: string; blurb: string; art: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-4 rounded-2xl border border-line bg-panel p-4 text-left transition active:scale-[0.99]"
    >
      <div className="grid size-[100px] flex-none place-items-center rounded-xl bg-panel2">{art}</div>
      <div className="min-w-0 flex-1">
        <div className="text-lg font-bold">{title}</div>
        <div className="mt-1 text-[13px] leading-snug text-muted">{blurb}</div>
      </div>
      <span className="text-xl text-muted">›</span>
    </button>
  )
}
