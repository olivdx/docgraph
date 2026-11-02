import { authenticate } from '@/src/server/telegram-auth'
import { errorResponse, getService } from '@/src/server/http'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const user = authenticate(req)
    return Response.json(await (await getService()).me(user))
  } catch (e) {
    return errorResponse(e)
  }
}
