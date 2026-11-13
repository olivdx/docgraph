import { createHash, timingSafeEqual } from 'node:crypto'
import { RANKED_MIN_PLAYERS } from '@/src/battleship/rating'
import { isAdmin } from './admin'
import type { RankingView } from './battleship-rating'

type Env = Partial<Record<string, string>>

/** A Bot API call returned as the webhook's response body, so no outgoing request (or bot token) is needed. */
export interface BotReply {
  method: 'sendMessage'
  chat_id: number | string
  text: string
  reply_markup: { inline_keyboard: { text: string; url: string }[][] }
}

/** `/name`, `/name arg`, `/name@bot arg`: groups 1 = command, 2 = addressed bot, 3 = argument. */
const COMMAND = /^\/([a-z0-9_]+)(?:@(\w+))?(?:\s+(.*))?$/i
const CODE = /^[A-Za-z0-9_-]{1,64}$/
/** The Mini App start parameter that opens the Battleship ranking (see startPath). */
const RANKING_START = 'ranking'
const RANK_LINES = 10
const MEDALS = ['🥇', '🥈', '🥉']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface Command {
  name: string
  arg: string
  chatId: number | string
  /** Telegram id of the sender, when the message has one */
  userId: string | null
  /** `https://t.me/<bot>/<app>` */
  appUrl: string
}

/** The bot command in this update, if it is one for this bot and the bot is configured. */
function parseCommand(update: unknown, env: Env): Command | null {
  const bot = env.TELEGRAM_BOT_USERNAME
  const app = env.TELEGRAM_MINIAPP_SHORTNAME
  if (!bot || !app || !isObject(update) || !isObject(update.message)) return null
  const { chat, text, from } = update.message
  if (!isObject(chat) || typeof text !== 'string') return null
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return null
  const m = COMMAND.exec(text.trim())
  if (!m) return null
  if (m[2] && m[2].toLowerCase() !== bot.toLowerCase()) return null
  const fromId = isObject(from) ? from.id : null
  return {
    name: m[1].toLowerCase(),
    arg: m[3]?.trim() ?? '',
    chatId: chat.id,
    userId: typeof fromId === 'number' || typeof fromId === 'string' ? String(fromId) : null,
    appUrl: `https://t.me/${bot}/${app}`,
  }
}

/**
 * The reply to `/start`: a button that opens the Mini App (straight into a room when the command
 * carries its code). Everything else, or a bot that is not configured, gets null.
 */
export function replyToUpdate(update: unknown, env: Env = process.env): BotReply | null {
  const cmd = parseCommand(update, env)
  if (!cmd || cmd.name !== 'start') return null
  const url = `${cmd.appUrl}${CODE.test(cmd.arg) ? `?startapp=${cmd.arg}` : ''}`
  return {
    method: 'sendMessage',
    chat_id: cmd.chatId,
    text: 'Welcome to Game Cup! Play Caro, Sudoku and Battleship cups with your friends.',
    reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game Cup', url }]] },
  }
}

export type TextReply = Pick<BotReply, 'method' | 'chat_id' | 'text'>

/**
 * `/reset`: wipes the Battleship ranking, for the admin only and only as `/reset confirm` (a bare
 * `/reset` just explains that). `reset` says whether the caller should wipe; `reply` assumes it worked.
 */
export function resetCommand(update: unknown, env: Env = process.env): { reset: boolean; reply: TextReply } | null {
  const cmd = parseCommand(update, env)
  if (!cmd || cmd.name !== 'reset' || !cmd.userId) return null
  const say = (text: string): TextReply => ({ method: 'sendMessage', chat_id: cmd.chatId, text })
  if (!isAdmin(cmd.userId)) return { reset: false, reply: say('Only the admin can reset the ranking.') }
  if (cmd.arg.toLowerCase() !== 'confirm') {
    return {
      reset: false,
      reply: say(
        ["This deletes every Battleship rating: all captains start again at 1,000, and it can't be undone.", '', 'Send /reset confirm to do it.'].join(
          '\n',
        ),
      ),
    }
  }
  return { reset: true, reply: say('Done. The Battleship ranking was reset: everyone starts again at 1,000.') }
}

/** Who sent `/rank` and where, or null when this update is not a `/rank` from a known sender. */
export function rankCommand(update: unknown, env: Env = process.env): { chatId: number | string; userId: string } | null {
  const cmd = parseCommand(update, env)
  if (!cmd || cmd.name !== 'rank' || !cmd.userId) return null
  return { chatId: cmd.chatId, userId: cmd.userId }
}

const points = (n: number) => n.toLocaleString('en-US')

/** The reply to `/rank`: the top captains, the sender's own line, and a button to the full ranking. */
export function rankReply(chatId: number | string, view: RankingView, env: Env = process.env): BotReply {
  const lines = ['🏆 Battleship Ranking', '']
  if (view.top.length === 0) lines.push('No rated matches yet. Be the first!')
  for (const r of view.top.slice(0, RANK_LINES)) {
    lines.push(`${MEDALS[r.rank - 1] ?? `${r.rank}.`} ${r.name} · ${points(r.rating)}`)
  }
  lines.push('')
  lines.push(
    view.me
      ? `You: #${view.me.rank} of ${points(view.total)} · ${points(view.me.rating)} (${view.me.wins} W · ${view.me.losses} L)`
      : `You're not ranked yet. Play a match in a cup with ${RANKED_MIN_PLAYERS}+ captains to get your rating.`,
  )
  const url = `https://t.me/${env.TELEGRAM_BOT_USERNAME}/${env.TELEGRAM_MINIAPP_SHORTNAME}?startapp=${RANKING_START}`
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '🏆 Open Ranking', url }]] },
  }
}

/** Telegram sends the secret given to setWebhook in `X-Telegram-Bot-Api-Secret-Token`. No secret configured: reject. */
export function isWebhookAuthorized(given: string | null, expected: string | undefined): boolean {
  if (!expected || given === null) return false
  const hash = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(hash(given), hash(expected))
}
