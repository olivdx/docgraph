import { authenticate } from '@/src/server/telegram-auth'
import { codeOf, errorResponse, getSudokuService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: RouteContext<'/api/sudoku/[code]'>) {
  try {
    const user = authenticate(req)
    const { code } = await ctx.params
    return Response.json(await (await getSudokuService()).get(codeOf(code), user))
  } catch (e) {
    return errorResponse(e)
  }
}
