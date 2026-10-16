// Fusion (S6-005; D6, D46; S6 shared notes, "One question, step by step" 4 and 5): the two paths
// become one ranked list with Reciprocal Rank Fusion, k=60, then the entity filter keeps the best
// few for the context.
//
// - Path A's list is its passages, in Path A's order; Path B's list is its records, in the order
//   they first appear in the rows. Both are keyed: a passage by its chunk ID, a record by its ID
//   (each with its own prefix, so a chunk and a record can never be taken for one item).
// - A passage Path A found that names a record Path B found also counts in Path B's list, at that
//   record's rank (the best rank, when it names several): planner's reading S6-Q2. Its score is then
//   1 / (k + its Path A rank) + 1 / (k + that record's rank), summed best rank first as the shared
//   `reciprocalRankFusion` sums, so the same ranks always give exactly the same score.
// - Everything else is `reciprocalRankFusion` as it is: one list in vector mode (or when the graph
//   path failed), two in hybrid. The order is score high to low, then the better best rank, then the
//   key, so the same input always gives the same order (D45.8).
// - The entity filter (planner's reading S6-Q1) keeps, in fused order, up to 5 passages and 30
//   records for the context, and only the links whose two ends are both among the kept records.
// Pure: no I/O, no clock, no randomness. The visibility checks run before (./entity-filter.ts).
import { SEARCH_LIMITS, reciprocalRankFusion, type RankedList, type SearchPath } from '@grc/shared';
import type { GraphLink, GraphRecord, VectorPassage } from '../retrieval.js';

/** One item of a list to fuse: a passage of Path A or a record of Path B. */
export type FusionItem =
  | { readonly key: string; readonly type: 'passage'; readonly passage: VectorPassage }
  | { readonly key: string; readonly type: 'record'; readonly record: GraphRecord };

export interface FusedEntry {
  readonly key: string;
  readonly item: FusionItem;
  /** The RRF score: the sum of 1 / (k + rank) over the paths that found it. */
  readonly score: number;
  /** Its place in the fused order, from 1. */
  readonly rank: number;
  /** Its best rank on either path. */
  readonly bestRank: number;
  /** The paths that found it: `vector` first, then `graph`. */
  readonly foundBy: readonly SearchPath[];
  /** Its rank on each path that found it. */
  readonly ranks: Readonly<Partial<Record<SearchPath, number>>>;
}

export function passageKey(chunkId: string): string {
  return `passage:${chunkId}`;
}

export function recordKey(recordId: string): string {
  return `record:${recordId}`;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The RRF score of an item with these ranks, summed best rank first (as `reciprocalRankFusion`). */
function scoreOf(ranks: readonly number[], k: number): number {
  return [...ranks].sort((a, b) => a - b).reduce((sum, rank) => sum + 1 / (k + rank), 0);
}

export interface FuseOptions {
  /** RRF's k; 60 unless given. */
  k?: number;
}

/**
 * Fuses Path A's passages with Path B's records. `records` is null when Path B didn't run or gave
 * nothing usable (vector mode, or the graph path failed): the result is then Path A's passages in
 * Path A's order, each scored 1 / (k + its rank).
 */
export function fuseSources(
  passages: readonly VectorPassage[],
  records: readonly GraphRecord[] | null,
  options: FuseOptions = {},
): FusedEntry[] {
  const k = options.k ?? SEARCH_LIMITS.rrfK;
  const vector: RankedList<FusionItem, SearchPath> = {
    name: 'vector',
    items: passages.map((passage) => ({ key: passageKey(passage.chunkId), type: 'passage', passage })),
  };
  const lists: RankedList<FusionItem, SearchPath>[] = [vector];

  // Each record's rank on Path B: its first place in the list.
  const graphRank = new Map<string, number>();
  if (records !== null) {
    const items: FusionItem[] = records.map((record) => ({ key: recordKey(record.id), type: 'record', record }));
    items.forEach((item, index) => {
      if (item.type === 'record' && !graphRank.has(item.record.id)) graphRank.set(item.record.id, index + 1);
    });
    lists.push({ name: 'graph', items });
  }

  const fused = reciprocalRankFusion(lists, { k }).map((entry) => {
    const ranks: Partial<Record<SearchPath, number>> = { ...entry.ranks };
    if (entry.item.type !== 'passage' || ranks.graph !== undefined || graphRank.size === 0) {
      return { ...entry, ranks, foundBy: [...entry.foundBy] };
    }
    // A passage that names a record Path B found counts for Path B too, at that record's rank.
    let via: number | undefined;
    for (const recordId of entry.item.passage.recordIds) {
      const rank = graphRank.get(recordId);
      if (rank !== undefined && (via === undefined || rank < via)) via = rank;
    }
    if (via === undefined) return { ...entry, ranks, foundBy: [...entry.foundBy] };
    ranks.graph = via;
    const all = Object.values(ranks).filter((r): r is number => typeof r === 'number');
    return {
      ...entry,
      ranks,
      score: scoreOf(all, k),
      bestRank: Math.min(...all),
      foundBy: [...entry.foundBy, 'graph' as const],
    };
  });

  fused.sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || compareKeys(a.key, b.key));

  return fused.map((entry, index) => ({
    key: entry.key,
    item: entry.item,
    score: entry.score,
    rank: index + 1,
    bestRank: entry.bestRank,
    foundBy: entry.foundBy,
    ranks: entry.ranks,
  }));
}

export interface ContextLimits {
  passages: number;
  records: number;
}

export interface ContextSelection {
  /** Every fused entry, in fused order, each marked if it went into the context. */
  entries: { entry: FusedEntry; inContext: boolean }[];
  /** The entries in the context, in fused order: up to `passages` passages and `records` records. */
  kept: FusedEntry[];
  /** The links whose two ends are both among the kept records, each once, in Path B's order. */
  links: GraphLink[];
}

/**
 * The entity filter's last step: in fused order, keeps up to 5 passages and 30 records (unless
 * other limits are given), and the links among the kept records only.
 */
export function selectContext(
  fused: readonly FusedEntry[],
  links: readonly GraphLink[],
  limits: ContextLimits = { passages: SEARCH_LIMITS.contextPassages, records: SEARCH_LIMITS.contextRecords },
): ContextSelection {
  let passages = 0;
  let records = 0;
  const kept: FusedEntry[] = [];
  const keptRecordIds = new Set<string>();
  const entries = fused.map((entry) => {
    let inContext = false;
    if (entry.item.type === 'passage' && passages < limits.passages) {
      passages += 1;
      inContext = true;
    } else if (entry.item.type === 'record' && records < limits.records) {
      records += 1;
      inContext = true;
      keptRecordIds.add(entry.item.record.id);
    }
    if (inContext) kept.push(entry);
    return { entry, inContext };
  });

  const seen = new Set<string>();
  const keptLinks: GraphLink[] = [];
  for (const link of links) {
    if (!keptRecordIds.has(link.from) || !keptRecordIds.has(link.to)) continue;
    const id = `${link.type} ${link.from} ${link.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    keptLinks.push(link);
  }

  return { entries, kept, links: keptLinks };
}
