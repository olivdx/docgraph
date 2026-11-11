import { isWebhookAuthorized, rankCommand, rankReply, replyToUpdate } from '@/src/server/telegram-bot'
import { getBattleshipRatings, readJson } from '@/src/server/http'

export const dynamic = 'force-dynamic'

/** Telegram bot webhook: /start opens the Mini App, /rank shows the Battleship ranking. */
export async function POST(req: Request) {
  if (!isWebhookAuthorized(req.headers.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response(null, { status: 401 })
  }
  // Always 200 for an authorized update (even on a failure), so Telegram never retries it.
  try {
    const update = await readJson(req)
    const rank = rankCommand(update)
    const reply = rank ? rankReply(rank.chatId, await (await getBattleshipRatings()).ranking(rank.userId)) : replyToUpdate(update)
    if (reply) return Response.json(reply)
  } catch (e) {
    console.error('[telegram-webhook]', e)
  }
  return new Response(null, { status: 200 })
}
