/**
 * Line-pattern classification shared by the Caro bots.
 *
 * A pattern is the 11-cell line window centred on an empty cell, seen by one side: offsets -5..-1
 * map to digits 0..4 and +1..+5 to digits 5..9 (base 3: 0 empty, 1 own stone, 2 blocked, i.e. an
 * opponent stone or beyond the board edge). `level(code)` says what playing the centre makes on
 * that line (five, open/closed four, open/closed three, ...), classified recursively by asking how
 * many empty cells turn the window into the next level. A five only counts if it is not blocked on
 * both ends, so the caro blocked-ends rule holds for gapped shapes too. Results are memoised.
 */

const EMPTY = 0;

export const NONE = 0;
export const TWO = 1; // closed two
export const OPEN2 = 2;
export const THREE = 3; // closed three
export const OPEN3 = 4;
export const FOUR = 5; // closed four: exactly one completion square
export const OPEN4 = 6; // two or more completion squares
export const FIVE = 7;

export const W_FIVE = 1e9;
export const W_OPEN4 = 1e7;
export const W_DOUBLE3 = 1e6; // two open threes at once (no renju restrictions in caro)
export const LEVEL_WEIGHT = [0, 50, 500, 1e3, 5e4, 1e5, W_OPEN4, W_FIVE];

// Window: offsets -5..-1 → digits 0..4, offsets 1..5 → digits 5..9 (base 3: 0 empty, 1 own, 2 blocked).
export const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683];
const memo = new Int8Array(59049).fill(-1);

function hasFive(code: number): boolean {
  const cells = new Array<number>(11);
  let c = code;
  for (let i = 0; i < 10; i++) {
    cells[i < 5 ? i : i + 1] = c % 3;
    c = Math.floor(c / 3);
  }
  cells[5] = 1;
  let l = 5;
  while (l > 0 && cells[l - 1] === 1) l--;
  let r = 5;
  while (r < 10 && cells[r + 1] === 1) r++;
  if (r - l + 1 < 5) return false;
  // Beyond the window the board is unknown; treat as open.
  const leftBlocked = l > 0 && cells[l - 1] === 2;
  const rightBlocked = r < 10 && cells[r + 1] === 2;
  return !(leftBlocked && rightBlocked);
}

export function level(code: number): number {
  const cached = memo[code];
  if (cached >= 0) return cached;
  let result: number;
  if (hasFive(code)) {
    result = FIVE;
  } else {
    let fives = 0;
    let best = NONE;
    let c = code;
    for (let i = 0; i < 10; i++) {
      const digit = c % 3;
      c = Math.floor(c / 3);
      if (digit !== EMPTY) continue;
      const lv = level(code + POW3[i]);
      if (lv === FIVE) fives++;
      else if (lv > best) best = lv;
    }
    if (fives >= 2) result = OPEN4;
    else if (fives === 1) result = FOUR;
    else if (best === OPEN4) result = OPEN3;
    else if (best === FOUR) result = THREE;
    else if (best === OPEN3) result = OPEN2;
    else if (best === THREE) result = TWO;
    else result = NONE;
  }
  memo[code] = result;
  return result;
}
