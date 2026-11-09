import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getBattleshipService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: RouteContext<'/api/battleship/[code]'>) {
  try {
    const user = authenticate(req)
    const { code } = await ctx.params
    return Response.json(await (await getBattleshipService()).getRoom(codeOf(code), user))
  } catch (e) {
    return errorResponse(e)
  }
}
