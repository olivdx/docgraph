import { describe, expect, it } from 'vitest'
import { isWebhookAuthorized, rankCommand, rankReply, replyToUpdate } from '@/src/server/telegram-bot'

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

describe('/rank', () => {
  const from = (text: string) => ({ update_id: 3, message: { message_id: 9, chat: { id: -100, type: 'group' }, from: { id: 555 }, text } })
  const row = (rank: number, name: string, rating: number) => ({ rank, name, avatarUrl: null, rating, wins: 3, losses: 1, isYou: false })
  const top = Array.from({ length: 12 }, (_, i) => row(i + 1, `Captain ${i + 1}`, 1500 - i * 10))

  it('rankCommand finds who asked and where', () => {
    expect(rankCommand(from('/rank'), env)).toEqual({ chatId: -100, userId: '555' })
    expect(rankCommand(from('/rank@caroday_bot'), env)).toEqual({ chatId: -100, userId: '555' })
    expect(rankCommand(from('/start'), env)).toBeNull()
    expect(rankCommand(from('/ranking'), env)).toBeNull()
    expect(rankCommand(from('/rank@other_bot'), env)).toBeNull()
    expect(rankCommand(msg('/rank'), env)).toBeNull() // no sender
    expect(rankCommand(from('/rank'), {})).toBeNull()
  })

  it('lists the top 10 with medals, then your own line', () => {
    const me = { ...row(27, 'Me', 1084), wins: 9, losses: 5, isYou: true, cupsWon: 2, lastDelta: 18 }
    const r = rankReply(-100, { top, total: 248, me }, env)
    expect(r).toMatchObject({ method: 'sendMessage', chat_id: -100 })
    const lines = r.text.split('\n')
    expect(lines).toContain('🥇 Captain 1 · 1,500')
    expect(lines).toContain('🥉 Captain 3 · 1,480')
    expect(lines).toContain('10. Captain 10 · 1,410')
    expect(r.text).not.toContain('Captain 11')
    expect(lines).toContain('You: #27 of 248 · 1,084 (9 W · 5 L)')
    expect(r.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/caroday_bot/play?startapp=ranking')
  })

  it('says so when you are not ranked or nobody is', () => {
    expect(rankReply(1, { top, total: 12, me: null }, env).text).toContain("You're not ranked yet")
    const empty = rankReply(1, { top: [], total: 0, me: null }, env).text
    expect(empty).toContain('No rated matches yet')
    expect(empty).not.toContain('🥇')
  })
})
