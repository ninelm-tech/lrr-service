const ASSUMED_AVG_SPEED_KMH = 20; // conservative urban-Lagos-traffic assumption

export function estimateEtaMinutes(distanceKm: number): number {
  return Math.round((distanceKm / ASSUMED_AVG_SPEED_KMH) * 60);
}

export interface QuoteForRanking {
  offerId: string;
  operatorId: string;
  businessName: string;
  quotedPrice: number;
  etaMinutes: number;
}

export interface RankedQuote extends QuoteForRanking {
  score: number;
}

const WEIGHT_PRICE = 0.6;
const WEIGHT_ETA = 0.4;

export function rankQuotes(quotes: QuoteForRanking[]): RankedQuote[] {
  if (quotes.length === 0) return [];

  const maxPrice = Math.max(...quotes.map((q) => q.quotedPrice), 1);
  const maxEta = Math.max(...quotes.map((q) => q.etaMinutes), 1);

  const scored: RankedQuote[] = quotes.map((quote) => {
    // Lower price/ETA is better — normalize so 1.0 = best in this set, 0.0 = worst.
    const priceScore = 1 - quote.quotedPrice / maxPrice;
    const etaScore = 1 - quote.etaMinutes / maxEta;

    const score = priceScore * WEIGHT_PRICE + etaScore * WEIGHT_ETA;

    return { ...quote, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}
