import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: RouteContext<'/api/rooms/[code]'>) {
  try {
    const user = authenticate(req)
    const { code } = await ctx.params
    return Response.json(await (await getService()).getRoom(codeOf(code), user))
  } catch (e) {
    return errorResponse(e)
  }
}
