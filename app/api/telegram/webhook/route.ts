import { isWebhookAuthorized, replyToUpdate } from '@/src/server/telegram-bot'
import { readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** Telegram bot webhook: answers /start with a button that opens the Mini App. */
export async function POST(req: Request) {
  if (!isWebhookAuthorized(req.headers.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response(null, { status: 401 })
  }
  // Always 200 for an authorized update, so Telegram never retries one we choose to ignore.
  const reply = replyToUpdate(await readJson(req))
  return reply ? Response.json(reply) : new Response(null, { status: 200 })
}
