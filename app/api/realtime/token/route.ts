import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse } from '@/src/server/http'
import { createTokenRequest } from '@/src/server/realtime'

export const dynamic = 'force-dynamic'

/** Ably token request for the signed-in user; 404 when realtime is not configured (client then just polls). */
export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    const token = await createTokenRequest(user.id)
    if (!token) return Response.json({ error: 'realtime_off' }, { status: 404 })
    return Response.json(token)
  } catch (e) {
    return errorResponse(e)
  }
}
