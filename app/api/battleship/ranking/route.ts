import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getBattleshipRatings } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** The Battleship leaderboard (top players) plus the caller's own rank. */
export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    return Response.json(await (await getBattleshipRatings()).ranking(user.id))
  } catch (e) {
    return errorResponse(e)
  }
}
