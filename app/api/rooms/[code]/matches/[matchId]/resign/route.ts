import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/matches/[matchId]/resign'>) {
  try {
    const user = authenticate(req)
    const { code, matchId } = await ctx.params
    return Response.json(await (await getService()).resign(codeOf(code), matchId.toUpperCase(), user))
  } catch (e) {
    return errorResponse(e)
  }
}
