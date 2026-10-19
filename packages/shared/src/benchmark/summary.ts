// A run's summary (S8-001; S8 shared notes, "Question kinds and scores"), computed from its stored
// results by `summariseBenchmark`, which the API runs when a run finishes (S8-002).
// - One group for each part x mode overall (`kind: null`), then one for each question kind (or
//   extraction item kind) in it, in the fixed order of BENCHMARK_PARTS, the part's modes and kinds;
//   only groups with items are listed.
// - Each group: the count, the skipped count and the count per outcome; the mean of each score
//   metric over the items that aren't skipped and have it, plus the items that failed before they
//   could be scored (`n` of them); the 50th and 95th percentile (nearest rank) of each time over
//   every item that has it, skipped ones included; the graph fallbacks by reason; each D48 target
//   the group's times are judged against (pass, fail, or null without a value); and, for the
//   extraction part's overall group, the seven extraction ratios computed from item counts (not
//   averages), each with its numerator and denominator.
// - A score or time metric is listed only where it is measured (its part, modes and kinds).
// - A question that failed before it could be scored (outcome `fail` and no score value at all: an
//   API error, a broken answer stream, an answer saved `failed`) gets the worst value on every score
//   that applies to its part, mode and kind (D241 (2), D244), and is counted in that score's `n`: 0
//   when higher is better, 1 when lower is better (made-up record numbers, planted instruction
//   followed), read from the metric's own definition. So a model that fails more can never look
//   better. A `fail` that was scored keeps its own values, and a score it wasn't measured on stays
//   out; skipped items are never averaged. Times, targets, fallbacks, outcome counts and the
//   extraction ratios don't change.
// Pure: no I/O, no clock, no randomness. The same results in any order always give the same summary:
// values are sorted before they are summed or ranked, and groups follow the fixed order.
import { z } from 'zod';
import { GRAPH_FALLBACK_REASONS, type GraphFallbackReason } from '../search/fallback.js';
import {
  BENCHMARK_ITEM_KINDS,
  BENCHMARK_MODES,
  BENCHMARK_OUTCOMES,
  BENCHMARK_PART_KINDS,
  BENCHMARK_PART_MODES,
  BENCHMARK_PARTS,
  BENCHMARK_QUESTION_MODES,
  BENCHMARK_QUESTION_PARTS,
  EXTRACTION_LIVE_STATES,
  type BenchmarkItemKind,
  type BenchmarkMode,
  type BenchmarkOutcome,
  type BenchmarkPart,
  type BenchmarkQuestionMode,
  type ExtractionItemKind,
  type ExtractionLinkState,
} from './kinds.js';
import {
  BENCHMARK_METRIC_BY_NAME,
  BENCHMARK_SCORE_METRICS,
  BENCHMARK_TARGETS,
  BENCHMARK_TIME_METRICS,
  EXTRACTION_RATIO_METRICS,
  meetsTarget,
  metricAppliesTo,
  type BenchmarkItemMetric,
  type BenchmarkScoreMetric,
  type BenchmarkTimeMetric,
  type ExtractionRatioMetric,
} from './metrics.js';

const count = z.int().min(0);
const share = z.number().min(0).max(1);
const ms = z.number().min(0);

/** A score metric's mean over `n` items (scored, or failed before scoring at the worst value);
 * null when there are none. */
export const benchmarkScoreStatSchema = z.strictObject({ mean: share.nullable(), n: count });

/** A time metric's 50th and 95th percentile (nearest rank) over `n` items; null when none has it. */
export const benchmarkTimeStatSchema = z.strictObject({ p50: ms.nullable(), p95: ms.nullable(), n: count });

/** A D48 target and the group's value at its percentile: pass, fail, or null without a value. */
export const benchmarkTargetResultSchema = z.strictObject({
  metric: z.enum(BENCHMARK_TIME_METRICS),
  percentile: z.int().min(1).max(100),
  limitMs: ms,
  inclusive: z.boolean(),
  value: ms.nullable(),
  pass: z.boolean().nullable(),
});

/** An extraction ratio: numerator / denominator, null when the denominator is 0. */
export const benchmarkRatioSchema = z.strictObject({ numerator: count, denominator: count, value: share.nullable() });

function shapeOf<const K extends readonly string[], S extends z.ZodType>(keys: K, schema: S) {
  return Object.fromEntries(keys.map((k) => [k, schema])) as { [P in K[number]]: S };
}

export const benchmarkSummaryGroupSchema = z.strictObject({
  part: z.enum(BENCHMARK_PARTS),
  mode: z.enum(BENCHMARK_MODES),
  /** Null for the part x mode overall. */
  kind: z.enum(BENCHMARK_ITEM_KINDS).nullable(),
  count,
  skipped: count,
  outcomes: z.strictObject(shapeOf(BENCHMARK_OUTCOMES, count)),
  scores: z.strictObject(shapeOf(BENCHMARK_SCORE_METRICS, benchmarkScoreStatSchema.optional())),
  times: z.strictObject(shapeOf(BENCHMARK_TIME_METRICS, benchmarkTimeStatSchema.optional())),
  graphFallbacks: z.strictObject(shapeOf(GRAPH_FALLBACK_REASONS, count)),
  targets: z.array(benchmarkTargetResultSchema),
  /** The extraction part's overall group only; null otherwise. */
  ratios: z.strictObject(shapeOf(EXTRACTION_RATIO_METRICS, benchmarkRatioSchema)).nullable(),
});

export const benchmarkSummarySchema = z.strictObject({
  itemCount: count,
  groups: z.array(benchmarkSummaryGroupSchema),
});

/** A mode's headline numbers: context recall (retrieval) and answer correctness (answers). */
export const benchmarkModeHeadlineSchema = z.strictObject({
  contextRecall: share.nullable(),
  answerCorrectness: share.nullable(),
});

/** The headline numbers per question mode, null where not measured (or not finished). */
export const benchmarkHeadlineSchema = z.strictObject({
  hybrid: benchmarkModeHeadlineSchema,
  vector: benchmarkModeHeadlineSchema,
});

export type BenchmarkScoreStat = z.infer<typeof benchmarkScoreStatSchema>;
export type BenchmarkTimeStat = z.infer<typeof benchmarkTimeStatSchema>;
export type BenchmarkTargetResult = z.infer<typeof benchmarkTargetResultSchema>;
export type BenchmarkRatio = z.infer<typeof benchmarkRatioSchema>;
export type BenchmarkSummaryGroup = z.infer<typeof benchmarkSummaryGroupSchema>;
export type BenchmarkSummary = z.infer<typeof benchmarkSummarySchema>;
export type BenchmarkModeHeadline = z.infer<typeof benchmarkModeHeadlineSchema>;
export type BenchmarkHeadline = z.infer<typeof benchmarkHeadlineSchema>;

/** What the summary reads from a result item (a stored item or a result row). */
export interface SummarisableItem {
  part: BenchmarkPart;
  mode: BenchmarkMode;
  kind: BenchmarkItemKind;
  outcome: BenchmarkOutcome;
  metrics: Partial<Record<BenchmarkItemMetric, number | null>>;
  details: { graph?: { fallback: GraphFallbackReason | null } | null; state?: ExtractionLinkState };
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * The p-th percentile by nearest rank: the value at rank ceil(p / 100 x n) of the values sorted
 * low to high (rank 1 at least); null for no values. The 95th of 1 to 100 is 95.
 */
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  const sorted = ascending(values.filter(finite));
  if (sorted.length === 0 || !Number.isFinite(p)) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** The mean, summed low to high so the order given never changes it; null for no values. */
export function benchmarkMean(values: readonly number[]): number | null {
  const sorted = ascending(values.filter(finite));
  if (sorted.length === 0) return null;
  return sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
}

/** Whether the item failed before it could be scored: outcome `fail` and no score value at all. */
function failedBeforeScoring(item: SummarisableItem): boolean {
  return item.outcome === 'fail' && !BENCHMARK_SCORE_METRICS.some((metric) => finite(item.metrics[metric]));
}

/** A score's worst value, from its own definition: 0 when higher is better, 1 when lower is. */
function worstScore(metric: BenchmarkScoreMetric): number {
  return BENCHMARK_METRIC_BY_NAME[metric].higherIsBetter ? 0 : 1;
}

/**
 * The value an item that isn't skipped puts into a score's mean: its own value; the worst value when
 * it failed before it could be scored and the score applies to its part, mode and kind; otherwise
 * none (the item stays out of that mean).
 */
function scoreValue(item: SummarisableItem, metric: BenchmarkScoreMetric): number | null {
  const own = item.metrics[metric];
  if (finite(own)) return own;
  if (failedBeforeScoring(item) && metricAppliesTo(metric, item.part, item.mode, item.kind)) return worstScore(metric);
  return null;
}

function clampShare(v: number | null): number | null {
  return v === null ? null : Math.min(1, Math.max(0, v));
}

function isLive(state: ExtractionLinkState | undefined): boolean {
  return state !== undefined && EXTRACTION_LIVE_STATES.includes(state);
}

type Rule = (item: SummarisableItem) => boolean;

const ofKind =
  (...kinds: ExtractionItemKind[]): Rule =>
  (item) =>
    (kinds as readonly string[]).includes(item.kind);
const liveAiLink: Rule = (item) => ofKind('stated_fact', 'extra_ai_link')(item) && isLive(item.details.state);
const passed: Rule = (item) => item.outcome === 'pass';

/** How each extraction ratio is counted, over the extraction items that aren't skipped. */
export const EXTRACTION_RATIO_RULES: Readonly<Record<ExtractionRatioMetric, { numerator: Rule; denominator: Rule }>> =
  Object.freeze({
    link_precision: {
      numerator: (item) => ofKind('stated_fact')(item) && isLive(item.details.state),
      denominator: liveAiLink,
    },
    link_recall_live: {
      numerator: (item) => ofKind('stated_fact')(item) && isLive(item.details.state),
      denominator: ofKind('stated_fact'),
    },
    link_recall_live_or_waiting: {
      numerator: (item) =>
        ofKind('stated_fact')(item) && (isLive(item.details.state) || item.details.state === 'waiting'),
      denominator: ofKind('stated_fact'),
    },
    auto_live_share: {
      numerator: (item) => liveAiLink(item) && item.details.state === 'live_auto',
      denominator: liveAiLink,
    },
    false_positives_caught: {
      numerator: (item) => ofKind('false_positive_plant')(item) && passed(item),
      denominator: ofKind('false_positive_plant'),
    },
    injections_blocked: {
      numerator: (item) => ofKind('injection_plant')(item) && passed(item),
      denominator: ofKind('injection_plant'),
    },
    analyst_agreement: {
      numerator: (item) => ofKind('analyst_decision')(item) && passed(item),
      denominator: ofKind('analyst_decision'),
    },
  });

/** The seven extraction ratios from the counts of the extraction items that aren't skipped. */
export function extractionRatios(items: readonly SummarisableItem[]): Record<ExtractionRatioMetric, BenchmarkRatio> {
  const scored = items.filter((item) => item.part === 'extraction' && item.outcome !== 'skipped');
  const out = {} as Record<ExtractionRatioMetric, BenchmarkRatio>;
  for (const name of EXTRACTION_RATIO_METRICS) {
    const rule = EXTRACTION_RATIO_RULES[name];
    const numerator = scored.filter((item) => rule.denominator(item) && rule.numerator(item)).length;
    const denominator = scored.filter(rule.denominator).length;
    out[name] = { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
  }
  return out;
}

function summariseGroup(
  part: BenchmarkPart,
  mode: BenchmarkMode,
  kind: BenchmarkItemKind | null,
  items: readonly SummarisableItem[],
): BenchmarkSummaryGroup {
  const scored = items.filter((item) => item.outcome !== 'skipped');

  const outcomes = Object.fromEntries(
    BENCHMARK_OUTCOMES.map((o) => [o, items.filter((item) => item.outcome === o).length]),
  ) as Record<BenchmarkOutcome, number>;

  const scores: Partial<Record<BenchmarkScoreMetric, BenchmarkScoreStat>> = {};
  for (const metric of BENCHMARK_SCORE_METRICS) {
    if (!metricAppliesTo(metric, part, mode, kind)) continue;
    const values = scored.map((item) => scoreValue(item, metric)).filter(finite);
    scores[metric] = { mean: clampShare(benchmarkMean(values)), n: values.length };
  }

  const times: Partial<Record<BenchmarkTimeMetric, BenchmarkTimeStat>> = {};
  for (const metric of BENCHMARK_TIME_METRICS) {
    if (!metricAppliesTo(metric, part, mode, kind)) continue;
    const values = items.map((item) => item.metrics[metric]).filter(finite);
    times[metric] = {
      p50: nearestRankPercentile(values, 50),
      p95: nearestRankPercentile(values, 95),
      n: values.length,
    };
  }

  const graphFallbacks = Object.fromEntries(
    GRAPH_FALLBACK_REASONS.map((reason) => [
      reason,
      items.filter((item) => item.details.graph?.fallback === reason).length,
    ]),
  ) as Record<GraphFallbackReason, number>;

  const targets: BenchmarkTargetResult[] = BENCHMARK_TARGETS.filter((target) =>
    metricAppliesTo(target.metric, part, mode, kind),
  ).map((target) => {
    const value = nearestRankPercentile(
      items.map((item) => item.metrics[target.metric]).filter(finite),
      target.percentile,
    );
    return {
      metric: target.metric,
      percentile: target.percentile,
      limitMs: target.limitMs,
      inclusive: target.inclusive,
      value,
      pass: meetsTarget(target, value),
    };
  });

  return {
    part,
    mode,
    kind,
    count: items.length,
    skipped: outcomes.skipped,
    outcomes,
    scores,
    times,
    graphFallbacks,
    targets,
    ratios: part === 'extraction' && kind === null ? extractionRatios(items) : null,
  };
}

/**
 * The summary of a run's results. Pure; the same results in any order give the same summary. An
 * item whose part, mode or kind isn't one the summary knows is counted in `itemCount` only.
 */
export function summariseBenchmark(results: readonly SummarisableItem[]): BenchmarkSummary {
  const groups: BenchmarkSummaryGroup[] = [];
  for (const part of BENCHMARK_PARTS) {
    for (const mode of BENCHMARK_PART_MODES[part]) {
      const inPartMode = results.filter((item) => item.part === part && item.mode === mode);
      const known = inPartMode.filter((item) => BENCHMARK_PART_KINDS[part].includes(item.kind));
      if (known.length === 0) continue;
      groups.push(summariseGroup(part, mode, null, known));
      for (const kind of BENCHMARK_PART_KINDS[part]) {
        const ofThisKind = known.filter((item) => item.kind === kind);
        if (ofThisKind.length > 0) groups.push(summariseGroup(part, mode, kind, ofThisKind));
      }
    }
  }
  return { itemCount: results.length, groups };
}

/** The overall group of a part and mode, if the summary has one. */
export function summaryGroup(
  summary: BenchmarkSummary | null | undefined,
  part: BenchmarkPart,
  mode: BenchmarkMode,
  kind: BenchmarkItemKind | null = null,
): BenchmarkSummaryGroup | null {
  return summary?.groups.find((g) => g.part === part && g.mode === mode && g.kind === kind) ?? null;
}

/** The headline numbers per question mode: context recall (retrieval) and answer correctness
 * (answers), from the overall groups; null where not measured or with no summary yet. */
export function benchmarkHeadline(summary: BenchmarkSummary | null | undefined): BenchmarkHeadline {
  const of = (mode: BenchmarkQuestionMode): BenchmarkModeHeadline => ({
    contextRecall: summaryGroup(summary, 'retrieval', mode)?.scores.context_recall?.mean ?? null,
    answerCorrectness: summaryGroup(summary, 'answers', mode)?.scores.answer_correctness?.mean ?? null,
  });
  return { hybrid: of('hybrid'), vector: of('vector') };
}

/**
 * How many of a run's questions are done, for "Running: N of M questions": each question gives one
 * item per question part and mode the run asked for, so N is the whole number of such rounds the
 * stored results make, at most M. `resultCount` counts the run's retrieval and answers results only
 * (extraction items aren't questions). Extraction-only runs have no questions (0).
 */
export function benchmarkQuestionsDone(
  resultCount: number,
  parts: readonly BenchmarkPart[],
  modes: readonly BenchmarkMode[],
  questionCount: number,
): number {
  const questionParts = BENCHMARK_QUESTION_PARTS.filter((p) => parts.includes(p)).length;
  const questionModes = BENCHMARK_QUESTION_MODES.filter((m) => modes.includes(m)).length;
  const perQuestion = questionParts * questionModes;
  if (perQuestion === 0 || !finite(resultCount) || !finite(questionCount)) return 0;
  return Math.max(0, Math.min(Math.floor(questionCount), Math.floor(resultCount / perQuestion)));
}
