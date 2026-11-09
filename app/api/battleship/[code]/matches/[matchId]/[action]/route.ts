import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getBattleshipService, parseFireBody, parseFleetBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: RouteContext<'/api/battleship/[code]/matches/[matchId]/[action]'>) {
  try {
    const user = authenticate(req)
    const { code: raw, matchId, action } = await ctx.params
    const code = codeOf(raw)
    const svc = await getBattleshipService()
    switch (action) {
      case 'fleet': {
        const { ships, lock } = parseFleetBody(await readJson(req))
        return Response.json(await svc.saveFleet(code, matchId, user, ships, lock))
      }
      case 'fire': {
        const { cell, seq } = parseFireBody(await readJson(req))
        return Response.json(await svc.fire(code, matchId, user, cell, seq))
      }
      case 'resign':
        return Response.json(await svc.resign(code, matchId, user))
      default:
        return Response.json({ error: 'not_found' }, { status: 404 })
    }
  } catch (e) {
    return errorResponse(e)
  }
}
