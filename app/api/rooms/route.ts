import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getService, parseCreateBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    return Response.json(await (await getService()).list(user))
  } catch (e) {
    return errorResponse(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = authenticate(req)
    const name = parseCreateBody(await readJson(req))
    return Response.json(await (await getService()).create(user, name))
  } catch (e) {
    return errorResponse(e)
  }
}
