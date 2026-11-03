export type Side = 'X' | 'O';
export type Cell = { x: number; y: number };
export type Move = Cell & { side: Side; at: number };
/** The board is 100×100 cells, -50..49 on both axes, centred on (0,0). Beyond it counts as blocked. */
export const BOARD_MIN = -50;
export const BOARD_MAX = 49;
