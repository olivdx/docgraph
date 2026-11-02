import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getService, parseMoveBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/matches/[matchId]/move'>) {
  try {
    const user = authenticate(req)
    const { code, matchId } = await ctx.params
    const { x, y, clientMoveNo } = parseMoveBody(await readJson(req))
    return Response.json(
      await (await getService()).move(codeOf(code), matchId.toUpperCase(), user, { x, y }, clientMoveNo),
    )
  } catch (e) {
    return errorResponse(e)
  }
}
