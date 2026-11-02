import { describe, expect, it } from "vitest";

import { calculateElo } from "../../../src/server/persistence/elo";

describe("calculateElo", () => {
  it("updates ratings from 1200 to 1216 for winner and 1184 for loser", () => {
    const result = calculateElo({
      winnerRating: 1200,
      loserRating: 1200,
      kFactor: 32,
    });

    expect(result.winnerAfter).toBe(1216);
    expect(result.loserAfter).toBe(1184);
  });

  it("gives smaller gain when higher-rated player wins", () => {
    const result = calculateElo({
      winnerRating: 1600,
      loserRating: 1400,
      kFactor: 32,
    });

    expect(result.winnerAfter).toBe(1608);
    expect(result.loserAfter).toBe(1392);
  });

  it("respects custom k-factor", () => {
    const result = calculateElo({
      winnerRating: 1200,
      loserRating: 1200,
      kFactor: 16,
    });

    expect(result.winnerAfter).toBe(1208);
    expect(result.loserAfter).toBe(1192);
  });
});
