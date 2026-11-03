import { describe, expect, it, vi } from 'vitest'
import { buildInviteUrl, errorResponse, parseCreateBody, parseMoveBody } from '@/src/server/http'
import { RoomError } from '@/src/tournament/types'

describe('errorResponse', () => {
  const cases: Array<[ConstructorParameters<typeof RoomError>[0], number]> = [
    ['not_found', 404], ['not_host', 403], ['not_participant', 403],
    ['conflict', 409], ['already_active', 409], ['not_lobby', 409], ['full', 409],
    ['occupied', 400], ['out_of_bounds', 400], ['not_your_turn', 400],
  ]
  for (const [code, status] of cases) {
    it(`${code} -> ${status}`, async () => {
      const res = errorResponse(new RoomError(code, { activeCode: 'ABC234' }))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error: code, activeCode: 'ABC234' })
    })
  }
  it('passes through a thrown Response', () => {
    const r = new Response(null, { status: 401 })
    expect(errorResponse(r)).toBe(r)
  })
  it('hides internal errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = errorResponse(new Error('secret mongo uri'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    spy.mockRestore()
  })
})

async function status(fn: () => unknown) {
  try { fn() } catch (e) { const r = e as Response; return { s: r.status, b: await r.json() } }
  return null
}

describe('parseMoveBody', () => {
  it('accepts integers', () => {
    expect(parseMoveBody({ x: 1, y: 2, clientMoveNo: 3 })).toEqual({ x: 1, y: 2, clientMoveNo: 3 })
  })
  it('non-integer x -> 400 bad_request', async () => {
    expect(await status(() => parseMoveBody({ x: 1.5, y: 2, clientMoveNo: 3 }))).toEqual({ s: 400, b: { error: 'bad_request' } })
    expect((await status(() => parseMoveBody({ x: '1', y: 2, clientMoveNo: 3 })))?.s).toBe(400)
  })
  it('missing/non-object body -> 400', async () => {
    for (const j of [null, undefined, 5, 'x', [] as unknown]) expect((await status(() => parseMoveBody(j)))?.s).toBe(400)
    expect((await status(() => parseMoveBody({ x: 1, y: 2 })))?.s).toBe(400)
  })
  it('does not range check', () => {
    expect(parseMoveBody({ x: -1, y: 99, clientMoveNo: 0 })).toEqual({ x: -1, y: 99, clientMoveNo: 0 })
  })
})

describe('parseCreateBody', () => {
  it('trims, caps, empties', () => {
    expect(parseCreateBody({ name: '  hi  ' })).toBe('hi')
    expect(parseCreateBody({ name: 'a'.repeat(50) })).toBe('a'.repeat(40))
    expect(parseCreateBody({ name: '   ' })).toBeUndefined()
    expect(parseCreateBody({})).toBeUndefined()
    expect(parseCreateBody(undefined)).toBeUndefined()
    expect(parseCreateBody(null)).toBeUndefined()
  })
  it('non-string name -> 400', async () => {
    expect((await status(() => parseCreateBody({ name: 5 })))?.s).toBe(400)
  })
})

describe('buildInviteUrl', () => {
  it('needs both the bot username and the Mini App short name', () => {
    expect(buildInviteUrl('ABC123', { TELEGRAM_BOT_USERNAME: 'cupbot', TELEGRAM_MINIAPP_SHORTNAME: 'cup' })).toBe(
      'https://t.me/cupbot/cup?startapp=ABC123',
    )
    expect(buildInviteUrl('ABC123', { TELEGRAM_BOT_USERNAME: 'cupbot' })).toBe('')
    expect(buildInviteUrl('ABC123', { TELEGRAM_MINIAPP_SHORTNAME: 'cup' })).toBe('')
    expect(buildInviteUrl('ABC123', {})).toBe('')
  })
})
