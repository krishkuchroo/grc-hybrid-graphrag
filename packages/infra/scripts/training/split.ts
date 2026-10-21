// The split and the sample of `pnpm train:data` (TR-001; D248, principle 8). Pure and seeded: the
// same seed and inputs always give the same choice, with no clock and no Math.random.
// - The split is by world: a seeded choice of about 10% of the worlds (at least one) gives the
//   `validation` rows and the rest give `train`, so near-identical rows from one world never sit
//   on both sides.
// - The sample: a job with more rows than its cap keeps a seeded choice of that many, in the same
//   split ratio, in the order they were built.
// A choice ranks items by the SHA-256 of a text naming the seed and the item, smallest first.
import { createHash } from 'node:crypto';
import type { Split } from './jobs.js';

/** The share of the worlds whose rows are `validation` (D248). */
export const VALIDATION_SHARE = 0.1;

function rank(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The items by the rank of the text `textOf` gives each, smallest first. */
function byRank<T>(items: readonly T[], textOf: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, rank: rank(textOf(item)) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((entry) => entry.item);
}

/** How many of `worlds` worlds give validation rows: about 10%, at least one. */
export function validationWorldCount(worlds: number): number {
  return Math.max(1, Math.round(worlds * VALIDATION_SHARE));
}

/** The world seeds whose rows are `validation`: a choice seeded by `seed`, ascending. */
export function validationSeeds(seed: number, worldSeeds: readonly number[]): number[] {
  const count = Math.min(worldSeeds.length, validationWorldCount(worldSeeds.length));
  return byRank(worldSeeds, (worldSeed) => `split|${seed}|${worldSeed}`)
    .slice(0, count)
    .sort((a, b) => a - b);
}

export interface SampleResult<T> {
  kept: T[];
  /** Rows per split before the sample. */
  before: Record<Split, number>;
}

/**
 * At most `max` of `items` (each with its split), chosen per split in the ratio the items have
 * (rounded), by a ranking seeded with `seed` and `label`. Kept in their given order.
 */
export function sampleBySplit<T>(
  items: readonly T[],
  splitOf: (item: T) => Split,
  max: number,
  seed: number,
  label: string,
): SampleResult<T> {
  const indexed = items.map((item, index) => ({ item, index, split: splitOf(item) }));
  const before: Record<Split, number> = { train: 0, validation: 0 };
  for (const entry of indexed) before[entry.split] += 1;
  if (items.length <= max) return { kept: [...items], before };

  const validation = Math.min(before.validation, Math.round((max * before.validation) / items.length));
  const train = Math.min(before.train, max - validation);
  const quota: Record<Split, number> = { train, validation };
  const keep = new Set<number>();
  for (const split of ['train', 'validation'] as const) {
    const ofSplit = indexed.filter((entry) => entry.split === split);
    for (const entry of byRank(ofSplit, (e) => `sample|${seed}|${label}|${e.index}`).slice(0, quota[split])) {
      keep.add(entry.index);
    }
  }
  return { kept: indexed.filter((entry) => keep.has(entry.index)).map((entry) => entry.item), before };
}
