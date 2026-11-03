import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getSudokuService, parseDifficultyBody, parseEntryBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: RouteContext<'/api/sudoku/[code]/[action]'>) {
  try {
    const user = authenticate(req)
    const { code: raw, action } = await ctx.params
    const code = codeOf(raw)
    const svc = await getSudokuService()
    switch (action) {
      case 'join':
        return Response.json(await svc.join(code, user))
      case 'leave':
        return Response.json(await svc.leave(code, user))
      case 'cancel':
        return Response.json(await svc.cancel(code, user))
      case 'start':
        return Response.json(await svc.start(code, user))
      case 'give-up':
        return Response.json(await svc.giveUp(code, user))
      case 'difficulty':
        return Response.json(await svc.difficulty(code, user, parseDifficultyBody(await readJson(req))))
      case 'enter': {
        const { cell, digit, seq } = parseEntryBody(await readJson(req))
        return Response.json(await svc.enter(code, user, cell, digit, seq))
      }
      default:
        return Response.json({ error: 'not_found' }, { status: 404 })
    }
  } catch (e) {
    return errorResponse(e)
  }
}
