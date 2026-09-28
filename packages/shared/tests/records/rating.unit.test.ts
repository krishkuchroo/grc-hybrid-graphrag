// S1-001 criterion 4 (D197): the 5x5 risk rating. Score = impact x likelihood; the band is low for
// 1-4, medium for 5-9, high for 10-16 and critical for 17-25.
import { describe, expect, it } from 'vitest';
import { loadRecords } from './load.js';

const SCALE = [1, 2, 3, 4, 5] as const;

function expectedBand(score: number): string {
  if (score <= 4) return 'low';
  if (score <= 9) return 'medium';
  if (score <= 16) return 'high';
  return 'critical';
}

const PAIRS = SCALE.flatMap((impact) =>
  SCALE.map((likelihood) => [impact, likelihood, impact * likelihood, expectedBand(impact * likelihood)] as const),
);

describe('criterion 4: riskRating for every pair on the scale', () => {
  it('covers all 25 pairs', () => {
    expect(PAIRS).toHaveLength(25);
  });

  it.each(PAIRS)('impact %i x likelihood %i -> score %i, %s', async (impact, likelihood, score, band) => {
    const { riskRating } = await loadRecords();
    expect(riskRating(impact, likelihood)).toEqual({ score, band });
  });
});

describe('criterion 4: the band edges', () => {
  it.each([
    [2, 2, 4, 'low'],
    [4, 1, 4, 'low'],
    [1, 5, 5, 'medium'],
    [5, 1, 5, 'medium'],
    [3, 3, 9, 'medium'],
    [2, 5, 10, 'high'],
    [5, 2, 10, 'high'],
    [4, 4, 16, 'high'],
    [4, 5, 20, 'critical'],
    [5, 4, 20, 'critical'],
    [5, 5, 25, 'critical'],
  ] as const)('impact %i x likelihood %i -> %i is %s', async (impact, likelihood, score, band) => {
    const { riskRating } = await loadRecords();
    expect(riskRating(impact, likelihood)).toEqual({ score, band });
  });

  it('no pair on the scale makes 17, so critical starts at 20 in practice', () => {
    expect(PAIRS.some(([, , score]) => score === 17)).toBe(false);
  });
});

describe('criterion 4: numbers off the scale', () => {
  it.each([
    [0, 3],
    [3, 0],
    [6, 3],
    [3, 6],
    [-1, 2],
    [2.5, 2],
    [2, 2.5],
    [Number.NaN, 3],
    [3, Number.POSITIVE_INFINITY],
  ])('refuses impact %s x likelihood %s', async (impact, likelihood) => {
    const { riskRating } = await loadRecords();
    expect(() => riskRating(impact, likelihood)).toThrow();
  });
});
