import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** Free play: leave the match, which ends the room. */
export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/matches/[matchId]/leave'>) {
  try {
    const user = authenticate(req)
    const { code, matchId } = await ctx.params
    return Response.json(await (await getService()).leaveMatch(codeOf(code), matchId.toUpperCase(), user))
  } catch (e) {
    return errorResponse(e)
  }
}
