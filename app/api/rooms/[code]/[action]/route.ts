import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getService, parseFormatBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

const ACTIONS = ['join', 'leave', 'cancel', 'start'] as const

export async function POST(req: Request, ctx: RouteContext<'/api/rooms/[code]/[action]'>) {
  try {
    const user = authenticate(req)
    const { code, action } = await ctx.params
    if (action !== 'format' && !(ACTIONS as readonly string[]).includes(action)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const service = await getService()
    if (action === 'format') {
      const bestOf = parseFormatBody(await readJson(req))
      return Response.json(await service.setFormat(codeOf(code), user, bestOf))
    }
    return Response.json(await service[action as (typeof ACTIONS)[number]](codeOf(code), user))
  } catch (e) {
    return errorResponse(e)
  }
}
