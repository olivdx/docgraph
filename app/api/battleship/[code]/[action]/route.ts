import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getBattleshipService, parseLeaveCurrent, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: RouteContext<'/api/battleship/[code]/[action]'>) {
  try {
    const user = authenticate(req)
    const { code: raw, action } = await ctx.params
    const code = codeOf(raw)
    const svc = await getBattleshipService()
    switch (action) {
      case 'join':
        return Response.json(await svc.join(code, user, { leaveCurrent: parseLeaveCurrent(await readJson(req)) }))
      case 'leave':
        return Response.json(await svc.leave(code, user))
      case 'cancel':
        return Response.json(await svc.cancel(code, user))
      case 'start':
        return Response.json(await svc.start(code, user))
      default:
        return Response.json({ error: 'not_found' }, { status: 404 })
    }
  } catch (e) {
    return errorResponse(e)
  }
}
