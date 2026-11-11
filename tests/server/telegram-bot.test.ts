import { describe, expect, it } from 'vitest'
import { isWebhookAuthorized, replyToUpdate } from '@/src/server/telegram-bot'

const env = { TELEGRAM_BOT_USERNAME: 'caroday_bot', TELEGRAM_MINIAPP_SHORTNAME: 'play' }
const msg = (text: string, chatId = 42) => ({ update_id: 1, message: { message_id: 7, chat: { id: chatId, type: 'private' }, text } })
const buttonUrl = (r: ReturnType<typeof replyToUpdate>) => r?.reply_markup.inline_keyboard[0][0].url

describe('replyToUpdate', () => {
  it('/start answers in the same chat with a button that opens the app', () => {
    const r = replyToUpdate(msg('/start'), env)
    expect(r).toMatchObject({ method: 'sendMessage', chat_id: 42 })
    expect(r!.text.length).toBeGreaterThan(0)
    expect(buttonUrl(r)).toBe('https://t.me/caroday_bot/play')
  })

  it('/start with a room code opens that room', () => {
    expect(buttonUrl(replyToUpdate(msg('/start AB12'), env))).toBe('https://t.me/caroday_bot/play?startapp=AB12')
  })

  it('accepts the command addressed to this bot in a group, in any letter case', () => {
    expect(buttonUrl(replyToUpdate(msg('/start@CaroDay_Bot'), env))).toBe('https://t.me/caroday_bot/play')
  })

  it('ignores a payload that is not a plain code', () => {
    expect(buttonUrl(replyToUpdate(msg('/start a&b=<x>'), env))).toBe('https://t.me/caroday_bot/play')
  })

  it('ignores everything else', () => {
    expect(replyToUpdate(msg('hello'), env)).toBeNull()
    expect(replyToUpdate(msg('/starting'), env)).toBeNull()
    expect(replyToUpdate(msg('/start@other_bot'), env)).toBeNull()
    expect(replyToUpdate({ update_id: 2 }, env)).toBeNull()
    expect(replyToUpdate(null, env)).toBeNull()
    expect(replyToUpdate('junk', env)).toBeNull()
  })

  it('does nothing when the bot username or app short name is not configured', () => {
    expect(replyToUpdate(msg('/start'), {})).toBeNull()
  })
})

describe('isWebhookAuthorized', () => {
  it('accepts only the configured secret', () => {
    expect(isWebhookAuthorized('s3cret', 's3cret')).toBe(true)
    expect(isWebhookAuthorized('wrong', 's3cret')).toBe(false)
    expect(isWebhookAuthorized(null, 's3cret')).toBe(false)
  })
  it('rejects everything while no secret is configured', () => {
    expect(isWebhookAuthorized('', undefined)).toBe(false)
    expect(isWebhookAuthorized('', '')).toBe(false)
    expect(isWebhookAuthorized(null, undefined)).toBe(false)
  })
})
