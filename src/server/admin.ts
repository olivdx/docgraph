/** The owner's Telegram account(s): may reset the Battleship ranking and use the hidden Caro autopilot. */
export const ADMIN_USER_IDS: ReadonlySet<string> = new Set(['2131393989'])

export const isAdmin = (userId: string): boolean => ADMIN_USER_IDS.has(userId)
