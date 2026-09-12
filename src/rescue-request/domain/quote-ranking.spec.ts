import { estimateEtaMinutes, rankQuotes } from './quote-ranking';

describe('estimateEtaMinutes', () => {
  it('estimates minutes from distance at 20 km/h', () => {
    // 10 km at 20 km/h = 0.5h = 30 min
    expect(estimateEtaMinutes(10)).toBe(30);
  });

  it('rounds to the nearest minute', () => {
    // 3 km at 20 km/h = 0.15h = 9 min
    expect(estimateEtaMinutes(3)).toBe(9);
  });

  it('returns 0 for zero distance', () => {
    expect(estimateEtaMinutes(0)).toBe(0);
  });
});

describe('rankQuotes', () => {
  it('ranks a cheaper-but-slower quote above a pricier-but-faster one when price dominates the weighting', () => {
    const quotes = [
      {
        offerId: 'a',
        operatorId: 'op-a',
        businessName: 'Swift Towing',
        quotedPrice: 30000,
        etaMinutes: 20,
      },
      {
        offerId: 'b',
        operatorId: 'op-b',
        businessName: 'Lagos Rescue Co',
        quotedPrice: 20000,
        etaMinutes: 22,
      },
    ];

    const ranked = rankQuotes(quotes);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].offerId).toBe('b'); // cheaper wins despite slightly slower ETA
    expect(ranked[1].offerId).toBe('a');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('ranks a much-faster quote above a slightly-cheaper one when ETA gap is large', () => {
    const quotes = [
      {
        offerId: 'a',
        operatorId: 'op-a',
        businessName: 'QuickHaul',
        quotedPrice: 26000,
        etaMinutes: 10,
      },
      {
        offerId: 'b',
        operatorId: 'op-b',
        businessName: 'Lagos Rescue Co',
        quotedPrice: 25000,
        etaMinutes: 30,
      },
    ];

    const ranked = rankQuotes(quotes);

    // price gap (26000 vs 25000, ~4% higher) is small relative to
    // the ETA gap (10 vs 30 min, 3x) — QuickHaul should win
    expect(ranked[0].offerId).toBe('a');
  });

  it('handles a single quote without dividing by zero', () => {
    const quotes = [
      {
        offerId: 'a',
        operatorId: 'op-a',
        businessName: 'Solo Towing',
        quotedPrice: 20000,
        etaMinutes: 15,
      },
    ];

    const ranked = rankQuotes(quotes);

    expect(ranked).toHaveLength(1);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  it('returns an empty array for no quotes', () => {
    expect(rankQuotes([])).toEqual([]);
  });
});
