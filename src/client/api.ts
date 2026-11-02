import { getInitData } from './telegram'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

const DEV_KEY = 'devUser'

function devUser(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const q = new URLSearchParams(window.location.search).get('dev')
    if (q) sessionStorage.setItem(DEV_KEY, q)
    return sessionStorage.getItem(DEV_KEY)
  } catch {
    return null
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-telegram-init-data': getInitData() }
  const dev = devUser()
  if (dev) headers['x-dev-user'] = dev
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const { error, ...extra } = (data ?? {}) as { error?: string }
    throw new ApiError(res.status, error ?? 'unknown', extra)
  }
  return data as T
}

export const apiGet = <T>(path: string) => request<T>('GET', path)
export const apiPost = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {})
