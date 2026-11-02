type CalculateEloInput = {
  winnerRating: number;
  loserRating: number;
  kFactor: number;
};

type CalculateEloResult = {
  winnerAfter: number;
  loserAfter: number;
};

export function calculateElo({
  winnerRating,
  loserRating,
  kFactor,
}: CalculateEloInput): CalculateEloResult {
  const winnerExpectedScore =
    1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
  const loserExpectedScore =
    1 / (1 + 10 ** ((winnerRating - loserRating) / 400));

  const nextWinnerRating = Math.round(winnerRating + kFactor * (1 - winnerExpectedScore));
  const nextLoserRating = Math.round(loserRating + kFactor * (0 - loserExpectedScore));

  return {
    winnerAfter: nextWinnerRating,
    loserAfter: nextLoserRating,
  };
}
