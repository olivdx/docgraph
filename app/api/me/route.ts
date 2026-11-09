import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getBattleshipService, getService, getSudokuService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** Who am I, and where am I active (at most one room across all three games)? */
export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    const caro = await (await getService()).me(user)
    if (caro.active) return Response.json({ user, active: { game: 'caro', ...caro.active } })
    const code = await (await getSudokuService()).activeCode(user.id)
    if (code) return Response.json({ user, active: { game: 'sudoku', code, matchId: null } })
    const battle = await (await getBattleshipService()).me(user)
    return Response.json({ user, active: battle ? { game: 'battleship', ...battle } : null })
  } catch (e) {
    return errorResponse(e)
  }
}
