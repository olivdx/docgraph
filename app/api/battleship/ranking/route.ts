import { authenticate } from '@/src/server/telegram-auth'
import { isAdmin } from '@/src/server/admin'
import type { RankingResponse } from '@/src/server/battleship-rating'
import { errorResponse, getBattleshipRatings } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** The Battleship leaderboard (top players) plus the caller's own rank. */
export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    const view = await (await getBattleshipRatings()).ranking(user.id)
    return Response.json({ ...view, canReset: isAdmin(user.id) } satisfies RankingResponse)
  } catch (e) {
    return errorResponse(e)
  }
}
