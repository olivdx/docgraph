type Env = Partial<Record<string, string>>

/** Admins are the Telegram user ids listed in `ADMIN_TELEGRAM_IDS` (comma separated). No list: no admins. */
export function isAdmin(userId: string, env: Env = process.env): boolean {
  if (!userId) return false
  return (env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(userId)
}
