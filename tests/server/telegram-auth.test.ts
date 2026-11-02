import { createHmac } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { authenticate, verifyInitData } from '@/src/server/telegram-auth'

const TOKEN = '123456:TEST-TOKEN'
const NOW = 1_800_000_000

function build(
  token: string,
  authDate: number,
  user: object = { id: 42, first_name: 'Ada', last_name: 'Lovelace', photo_url: 'https://x/y.png' },
): string {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAA', user: JSON.stringify(user) })
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'))
  return p.toString()
}

describe('verifyInitData', () => {
  it('verifies and returns the user', () => {
    expect(verifyInitData(build(TOKEN, NOW - 10), TOKEN, NOW)).toEqual({ id: '42', name: 'Ada Lovelace', avatarUrl: 'https://x/y.png' })
  })
  it('no last name / photo', () => {
    const u = verifyInitData(build(TOKEN, NOW, { id: 7, first_name: 'Bo' }), TOKEN, NOW)
    expect(u).toEqual({ id: '7', name: 'Bo', avatarUrl: null })
  })
  it('tampered user -> null', () => {
    const p = new URLSearchParams(build(TOKEN, NOW))
    p.set('user', JSON.stringify({ id: 99, first_name: 'Eve' }))
    expect(verifyInitData(p.toString(), TOKEN, NOW)).toBeNull()
  })
  it('2-day-old auth_date -> null', () => {
    expect(verifyInitData(build(TOKEN, NOW - 2 * 86_400), TOKEN, NOW)).toBeNull()
  })
  it('wrong token -> null', () => {
    expect(verifyInitData(build(TOKEN, NOW), 'other:token', NOW)).toBeNull()
  })
  it('missing hash / garbage -> null', () => {
    expect(verifyInitData('auth_date=1', TOKEN, NOW)).toBeNull()
    expect(verifyInitData('', TOKEN, NOW)).toBeNull()
  })
})

describe('authenticate', () => {
  afterEach(() => vi.unstubAllEnvs())
  const req = (h: Record<string, string>) => new Request('http://x/api', { headers: h })

  async function fails(fn: () => unknown) {
    try {
      fn()
    } catch (e) {
      expect(e).toBeInstanceOf(Response)
      expect((e as Response).status).toBe(401)
      expect(await (e as Response).json()).toEqual({ error: 'unauthorized' })
      return
    }
    throw new Error('did not throw')
  }

  it('missing header -> 401', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN)
    await fails(() => authenticate(req({})))
  })
  it('valid header -> user', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN)
    const u = authenticate(req({ 'x-telegram-init-data': build(TOKEN, Math.floor(Date.now() / 1000)) }))
    expect(u.id).toBe('42')
  })
  it('dev bypass only in development', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN)
    vi.stubEnv('NODE_ENV', 'development')
    expect(authenticate(req({ 'x-dev-user': 'u9:Dev: Name' }))).toEqual({ id: 'u9', name: 'Dev: Name', avatarUrl: null })
    vi.stubEnv('NODE_ENV', 'production')
    await fails(() => authenticate(req({ 'x-dev-user': 'u9:Dev' })))
  })
})
