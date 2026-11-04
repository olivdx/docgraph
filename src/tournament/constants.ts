export const TURN_MS = 85_000
export const RECONNECT_GRACE_MS = 30_000
export const DISCONNECT_DETECT_MS = 5_000
export const NO_SHOW_MS = 60_000
/** Bo3: how long a finished game's board stays up before the next game starts. */
export const GAME_BREAK_MS = 3_000
export const MIN_HUMANS = 2
export const MAX_PLAYERS = 32
export const LOBBY_TTL_MS = 2 * 60 * 60 * 1000
export const FINISHED_TTL_MS = 10 * 60 * 1000
export const BOT_DELAY_MIN_MS = 500
export const BOT_DELAY_MAX_MS = 1000
export const BOT_TIME_BUDGET_MS = 250
/**
 * Safety cap for games the bot keeps going on its own: a bot-vs-bot game (or a bot move due in a
 * human-vs-bot game) at this many moves without a winner ends 'board_full', X wins.
 */
export const MAX_BOT_GAME_MOVES = 900
/**
 * Out-of-scope settles leave a due full-strength bot move to its own match's poller, but only for
 * this long: after that the human evidently stopped polling and any settle plays it (no stall).
 */
export const BOT_DEFER_MAX_MS = 5_000
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LEN = 6
export const MATCH_ID_LEN = 4
export const BOT_NAMES = [
  'Bot Alpha', 'Bot Bravo', 'Bot Charlie', 'Bot Delta', 'Bot Echo', 'Bot Foxtrot', 'Bot Golf', 'Bot Hotel',
  'Bot India', 'Bot Juliett', 'Bot Kilo', 'Bot Lima', 'Bot Mike', 'Bot November', 'Bot Oscar', 'Bot Papa',
  'Bot Quebec', 'Bot Romeo', 'Bot Sierra', 'Bot Tango', 'Bot Uniform', 'Bot Victor', 'Bot Whiskey', 'Bot Xray',
  'Bot Yankee', 'Bot Zulu',
]
