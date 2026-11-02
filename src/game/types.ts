export type Side = 'X' | 'O';
export type Cell = { x: number; y: number };
export type Move = Cell & { side: Side; at: number };
export const BOARD_SIZE = 30;
