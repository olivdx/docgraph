import { createHash, timingSafeEqual } from 'node:crypto'

type Env = Partial<Record<string, string>>

/** A Bot API call returned as the webhook's response body, so no outgoing request (or bot token) is needed. */
export interface StartReply {
  method: 'sendMessage'
  chat_id: number | string
  text: string
  reply_markup: { inline_keyboard: { text: string; url: string }[][] }
}

/** `/start`, `/start CODE`, `/start@bot CODE`: groups 1 = addressed bot, 2 = payload. */
const START = /^\/start(?:@(\w+))?(?:\s+(.*))?$/i
const CODE = /^[A-Za-z0-9_-]{1,64}$/

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The reply to one Telegram update: `/start` gets a button that opens the Mini App (straight into a
 * room when the command carries its code). Everything else, or a bot that is not configured, gets null.
 */
export function replyToUpdate(update: unknown, env: Env = process.env): StartReply | null {
  const bot = env.TELEGRAM_BOT_USERNAME
  const app = env.TELEGRAM_MINIAPP_SHORTNAME
  if (!bot || !app || !isObject(update) || !isObject(update.message)) return null
  const { chat, text } = update.message
  if (!isObject(chat) || typeof text !== 'string') return null
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return null
  const m = START.exec(text.trim())
  if (!m) return null
  if (m[1] && m[1].toLowerCase() !== bot.toLowerCase()) return null
  const code = m[2]?.trim()
  const url = `https://t.me/${bot}/${app}${code && CODE.test(code) ? `?startapp=${code}` : ''}`
  return {
    method: 'sendMessage',
    chat_id: chat.id,
    text: 'Welcome to Game Cup! Play Caro, Sudoku and Battleship cups with your friends.',
    reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game Cup', url }]] },
  }
}

/** Telegram sends the secret given to setWebhook in `X-Telegram-Bot-Api-Secret-Token`. No secret configured: reject. */
export function isWebhookAuthorized(given: string | null, expected: string | undefined): boolean {
  if (!expected || given === null) return false
  const hash = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(hash(given), hash(expected))
}
