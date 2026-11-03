/** Realtime channel names, shared by server (publish) and client (subscribe). Codes are upper-case. */
export const caroRoomChannel = (code: string) => `caro:${code.toUpperCase()}`
export const caroMatchChannel = (code: string, matchId: string) => `caro:${code.toUpperCase()}:${matchId}`
export const sudokuChannel = (code: string) => `sudoku:${code.toUpperCase()}`
