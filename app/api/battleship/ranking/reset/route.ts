import { isAdmin } from '@/src/server/admin'
import type { RankingResponse } from '@/src/server/battleship-rating'
import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getBattleshipRatings } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** Wipes the whole Battleship ranking. Admins only (see isAdmin). */
export async function POST(req: Request) {
  try {
    const user = authenticate(req)
    if (!isAdmin(user.id)) return Response.json({ error: 'forbidden' }, { status: 403 })
    const ratings = await getBattleshipRatings()
    await ratings.reset()
    console.warn(`[battleship-rating] ranking reset by ${user.id}`)
    return Response.json({ ...(await ratings.ranking(user.id)), canReset: true } satisfies RankingResponse)
  } catch (e) {
    return errorResponse(e)
  }
}
