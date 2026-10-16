// Reciprocal Rank Fusion (D6: the spec's Python `reciprocal_rank_fusion`, ported to TypeScript; S6
// shared notes, "Fusion"). It merges ranked lists into one:
// - Each list is best first; an item's rank in a list is its place there, counted from 1.
// - An item's score is the sum, over the lists it appears in, of 1 / (k + rank), with k = 60 unless
//   another k is given. An item listed twice in one list counts once, at its best (lowest) rank.
// - The output is sorted by score, high to low. Ties go to the better best rank, then to the key in
//   plain code-unit order, so the same input always gives the same order (D45.8).
// - Each output item keeps the first copy of the item seen (the lists in the order given, each best
//   first, as the spec does), and says which lists found it and its rank in each.
// A score is summed best rank first, so two items with the same ranks get exactly the same score
// whatever the order of the lists. Pure: no I/O, no clock, no randomness.
import { SEARCH_LIMITS } from './limits.js';

/** Anything with a key: items with the same key are the same item. */
export interface Keyed {
  readonly key: string;
}

/** One ranked list, best first, with its name (for example `vector` or `graph`). */
export interface RankedList<T extends Keyed, L extends string = string> {
  readonly name: L;
  readonly items: readonly T[];
}

export interface FusedItem<T extends Keyed, L extends string = string> {
  readonly key: string;
  /** The first copy of the item seen. */
  readonly item: T;
  /** The sum of 1 / (k + rank) over the lists that found it. */
  readonly score: number;
  /** Its place in the fused order, from 1. */
  readonly rank: number;
  /** Its best rank in any list. */
  readonly bestRank: number;
  /** The lists that found it, in the order the lists were given. */
  readonly foundBy: readonly L[];
  /** Its rank in each list that found it (its best rank there). */
  readonly ranks: Readonly<Partial<Record<L, number>>>;
}

export interface RrfOptions {
  /** RRF's k: a finite number of at least 0. Defaults to 60. */
  k?: number;
}

interface Entry<T extends Keyed, L extends string> {
  key: string;
  item: T;
  ranks: Map<L, number>;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Fuses the ranked lists with RRF. Throws a RangeError for a k that isn't a finite number of at
 * least 0, and an Error for two lists with the same name or an item without a string key.
 */
export function reciprocalRankFusion<T extends Keyed, L extends string>(
  lists: readonly RankedList<T, L>[],
  options: RrfOptions = {},
): FusedItem<T, L>[] {
  const k = options.k ?? SEARCH_LIMITS.rrfK;
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 0) {
    throw new RangeError('reciprocalRankFusion: k must be a finite number of at least 0');
  }

  const names = new Set<string>();
  const entries = new Map<string, Entry<T, L>>();
  for (const list of lists) {
    if (names.has(list.name)) throw new Error('reciprocalRankFusion: two lists have the same name');
    names.add(list.name);
    list.items.forEach((item, index) => {
      const key = item?.key;
      if (typeof key !== 'string') throw new Error('reciprocalRankFusion: every item needs a string key');
      const rank = index + 1;
      let entry = entries.get(key);
      if (!entry) {
        entry = { key, item, ranks: new Map() };
        entries.set(key, entry);
      }
      // Listed twice in one list: the first place is its best rank there.
      if (!entry.ranks.has(list.name)) entry.ranks.set(list.name, rank);
    });
  }

  const scored = [...entries.values()].map((entry) => {
    const ranks = [...entry.ranks.values()].sort((a, b) => a - b);
    const score = ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0);
    return { entry, score, bestRank: ranks[0] ?? Number.POSITIVE_INFINITY };
  });

  scored.sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || compareKeys(a.entry.key, b.entry.key));

  return scored.map(({ entry, score, bestRank }, index) => ({
    key: entry.key,
    item: entry.item,
    score,
    rank: index + 1,
    bestRank,
    foundBy: [...entry.ranks.keys()],
    ranks: Object.fromEntries(entry.ranks) as Partial<Record<L, number>>,
  }));
}
