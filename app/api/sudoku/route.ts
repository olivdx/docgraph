import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getSudokuService, parseSudokuCreateBody, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    return Response.json(await (await getSudokuService()).list(user))
  } catch (e) {
    return errorResponse(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = authenticate(req)
    const { name, difficulty } = parseSudokuCreateBody(await readJson(req))
    return Response.json(await (await getSudokuService()).create(user, name, difficulty))
  } catch (e) {
    return errorResponse(e)
  }
}
