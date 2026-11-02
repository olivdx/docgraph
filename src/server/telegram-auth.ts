import { createHmac, timingSafeEqual } from 'node:crypto'

export interface TelegramUser {
  id: string
  name: string
  avatarUrl: string | null
}

export function verifyInitData(initData: string, botToken: string, nowSec: number, maxAgeSec = 86_400): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null
    params.delete('hash')
    const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
    const expected = createHmac('sha256', secret).update(dcs).digest()
    const given = Buffer.from(hash, 'hex')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

    const authDate = Number(params.get('auth_date'))
    if (!Number.isFinite(authDate) || authDate <= 0 || nowSec - authDate > maxAgeSec) return null

    const raw = params.get('user')
    if (!raw) return null
    const u = JSON.parse(raw) as { id?: number | string; first_name?: string; last_name?: string; photo_url?: string }
    if (u.id === undefined || u.id === null) return null
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'Player'
    return { id: String(u.id), name, avatarUrl: u.photo_url ?? null }
  } catch {
    return null
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

export function authenticate(request: Request): TelegramUser {
  if (process.env.NODE_ENV === 'development') {
    const dev = request.headers.get('x-dev-user')
    if (dev) {
      const i = dev.indexOf(':')
      const id = i > 0 ? dev.slice(0, i) : dev
      const name = i > 0 ? dev.slice(i + 1) : dev
      if (id) return { id, name: name || id, avatarUrl: null }
    }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN
  const initData = request.headers.get('x-telegram-init-data')
  if (!token || !initData) throw unauthorized()
  const user = verifyInitData(initData, token, Math.floor(Date.now() / 1000))
  if (!user) throw unauthorized()
  return user
}
