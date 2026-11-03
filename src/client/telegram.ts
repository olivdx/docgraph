interface TelegramWebApp {
  initData: string
  initDataUnsafe?: { start_param?: string }
  ready(): void
  expand(): void
  openTelegramLink(url: string): void
  /** Bot API 7.7+; older clients don't have it. */
  disableVerticalSwipes?(): void
  colorScheme?: 'light' | 'dark'
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

function webApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null
  return window.Telegram?.WebApp ?? null
}

export function getInitData(): string {
  return webApp()?.initData ?? ''
}

export function getStartParam(): string | null {
  const sp = webApp()?.initDataUnsafe?.start_param
  if (sp) return sp
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('startapp') || null
}

export function initTelegram(): void {
  const wa = webApp()
  if (!wa) return
  wa.ready()
  wa.expand()
  // Vertical swipes would minimize the Mini App while the player pans the board.
  wa.disableVerticalSwipes?.()
}

export function shareInvite(url: string, text: string): void {
  const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`
  const wa = webApp()
  if (wa) wa.openTelegramLink(link)
  else if (typeof window !== 'undefined') window.open(link, '_blank')
}
