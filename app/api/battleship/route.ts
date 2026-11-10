import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getBattleshipService, parseBattleCreateBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    return Response.json(await (await getBattleshipService()).list(user))
  } catch (e) {
    return errorResponse(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = authenticate(req)
    const { name, leaveCurrent } = parseBattleCreateBody(await readJson(req))
    return Response.json(await (await getBattleshipService()).create(user, name, { leaveCurrent }))
  } catch (e) {
    return errorResponse(e)
  }
}
