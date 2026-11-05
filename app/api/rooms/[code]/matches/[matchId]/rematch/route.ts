import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** Free play: accept a rematch after a game. */
export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/matches/[matchId]/rematch'>) {
  try {
    const user = authenticate(req)
    const { code, matchId } = await ctx.params
    return Response.json(await (await getService()).acceptRematch(codeOf(code), matchId.toUpperCase(), user))
  } catch (e) {
    return errorResponse(e)
  }
}
