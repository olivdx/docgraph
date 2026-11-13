'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BackButton } from '@/src/client/back-button'
import { apiPost } from '@/src/client/api'
import { initTelegram } from '@/src/client/telegram'
import { putPollCache, usePoll } from '@/src/client/use-poll'
import { RANKED_MIN_PLAYERS } from '@/src/battleship/rating'
import type { RankingResponse, RankRow } from '@/src/server/battleship-rating'

const PATH = '/api/battleship/ranking'
const COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#6c79ff', '#06b6d4']
const MEDALS = ['🥇', '🥈', '🥉']
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'
const points = (n: number) => n.toLocaleString('en-US')

function Avatar({ row, size }: { row: Pick<RankRow, 'name' | 'avatarUrl' | 'rank'>; size: number }) {
  const style = { width: size, height: size }
  if (row.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={row.avatarUrl} alt="" style={style} className="flex-none rounded-full object-cover" />
  }
  return (
    <div
      style={{ ...style, background: COLORS[row.rank % COLORS.length] }}
      className="grid flex-none place-items-center rounded-full font-display text-[13px] text-white"
    >
      {initial(row.name)}
    </div>
  )
}

export default function BattleshipRanking() {
  const router = useRouter()
  const ranking = usePoll<RankingResponse>(PATH, 30_000)
  // Admin only: wipe the whole ranking, after a second tap to confirm.
  const [resetStep, setResetStep] = useState<'idle' | 'confirm' | 'busy' | 'failed'>('idle')
  const reset = async () => {
    setResetStep('busy')
    try {
      putPollCache(PATH, await apiPost<RankingResponse>(`${PATH}/reset`))
      ranking.refresh()
      setResetStep('idle')
    } catch {
      setResetStep('failed')
    }
  }

  useEffect(() => {
    initTelegram()
  }, [])

  const data = ranking.data
  const me = data?.me ?? null

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4">
      <header className="flex items-center gap-2.5">
        <BackButton onClick={() => router.push('/battleship')} label="Back to Battleship" />
        <div>
          <div className="font-display text-xl leading-tight text-white">Ranking</div>
          <div className="text-xs text-muted">Battleship · all captains</div>
        </div>
      </header>

      {ranking.error && !data && <div className="text-sm text-o">Could not load the ranking. Retrying…</div>}

      {data &&
        (me ? (
          <div>
            <div className="flex items-center gap-3 rounded-[18px] border border-accent bg-[radial-gradient(circle_at_30%_20%,#2b3380,var(--panel)_85%)] p-3.5">
              <Avatar row={me} size={44} />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-muted">Your rank</div>
                <div className="font-display text-[26px] leading-none text-white">
                  #{me.rank} <span className="text-xs text-muted">of {points(data.total)}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="font-display text-xl leading-none text-white">{points(me.rating)}</div>
                {me.lastDelta !== 0 && (
                  <div className={`mt-1 font-display text-[11px] ${me.lastDelta > 0 ? 'text-win' : 'text-o'}`}>
                    {me.lastDelta > 0 ? `▲ +${me.lastDelta}` : `▼ ${me.lastDelta}`} last match
                  </div>
                )}
              </div>
            </div>
            <div className="mt-1.5 px-1 text-[11px] text-muted">
              {me.wins} {me.wins === 1 ? 'win' : 'wins'} · {me.losses} {me.losses === 1 ? 'loss' : 'losses'} · {me.cupsWon}{' '}
              {me.cupsWon === 1 ? 'cup' : 'cups'} won
            </div>
          </div>
        ) : (
          <div className="rounded-[18px] border border-line bg-panel p-3.5 text-sm text-muted">
            <div className="font-display text-base text-white">You&apos;re not ranked yet</div>
            Play a match in a cup with {RANKED_MIN_PLAYERS}+ captains to get your rating. Everyone starts at 1,000.
          </div>
        ))}

      {data && (
        <>
          <div className="px-0.5 font-display text-[11px] tracking-widest text-muted uppercase">Top captains</div>
          {data.top.length === 0 && (
            <div className="rounded-2xl border border-line bg-panel py-7 text-center text-sm text-muted">
              No rated matches yet. Be the first!
            </div>
          )}
          {data.top.map((r, i) => (
            <div
              key={i}
              className={`flex items-center gap-2.5 rounded-[14px] border px-3 py-2 ${
                r.isYou ? 'border-accent bg-[linear-gradient(90deg,rgba(108,121,255,0.18),var(--panel))]' : 'border-line bg-panel'
              }`}
            >
              <div className="w-6 flex-none text-center font-display text-sm text-muted">{MEDALS[r.rank - 1] ?? r.rank}</div>
              <Avatar row={r} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-sm text-white">{r.isYou ? `${r.name} (you)` : r.name}</div>
                <div className="text-[10px] text-muted">
                  {r.wins} W · {r.losses} L
                </div>
              </div>
              <div className="font-display text-sm text-white">{points(r.rating)}</div>
            </div>
          ))}
          <p className="px-1 text-center text-[11px] leading-snug text-muted">
            Rated: matches in cups with {RANKED_MIN_PLAYERS}+ captains, once the battle has started. Win to take points from your
            opponent; reach the final for a bonus.
          </p>
          {data.canReset &&
            (resetStep === 'idle' || resetStep === 'failed' ? (
              <button
                type="button"
                onClick={() => setResetStep('confirm')}
                className="mx-auto rounded-[10px] border border-o/50 px-3 py-2 font-display text-xs tracking-wider text-o uppercase"
              >
                {resetStep === 'failed' ? 'Reset failed. Try again' : 'Reset ranking'}
              </button>
            ) : (
              <div className="flex items-center gap-2 rounded-2xl border border-o/50 bg-panel p-3 text-sm">
                <span className="flex-1">Delete every rating? All captains start again at 1,000. This can&apos;t be undone.</span>
                <button
                  type="button"
                  disabled={resetStep === 'busy'}
                  onClick={() => setResetStep('idle')}
                  className="rounded-[10px] border border-line bg-panel2 px-3 py-1.5 font-display text-xs text-white uppercase disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={resetStep === 'busy'}
                  onClick={() => void reset()}
                  className="rounded-[10px] bg-rose-500/90 px-3 py-1.5 font-display text-xs text-white uppercase disabled:opacity-50"
                >
                  {resetStep === 'busy' ? 'Resetting…' : 'Reset'}
                </button>
              </div>
            ))}
        </>
      )}
    </main>
  )
}
