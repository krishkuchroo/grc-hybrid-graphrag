// Plain words for the Benchmark screen (D2, screen 13) and the benchmark command (S8-001), so the
// API, the web app and the command say the same thing: each kind, part, mode, outcome, status, link
// state, skip reason and injection kind; the progress and no-progress lines; the hidden notice; and
// the empty state with its two commands. Each metric's label and definition are in ./metrics.ts.
import type { BenchmarkMetricName } from './metrics.js';
import { BENCHMARK_METRIC_BY_NAME } from './metrics.js';
import type {
  BenchmarkInjectionKind,
  BenchmarkItemKind,
  BenchmarkMode,
  BenchmarkOutcome,
  BenchmarkPart,
  BenchmarkRunStatus,
  BenchmarkSkipReason,
  ExtractionLinkState,
} from './kinds.js';

export const BENCHMARK_KIND_TEXT: Readonly<Record<BenchmarkItemKind, string>> = Object.freeze({
  single_hop: 'Single hop',
  multi_hop: 'Multi hop',
  framework: 'Framework',
  no_answer: 'No answer',
  injection_trap: 'Injection trap',
  stated_fact: 'Stated fact',
  extra_ai_link: 'Extra AI link',
  false_positive_plant: 'Planted false positive',
  injection_plant: 'Planted add-link injection',
  analyst_decision: 'Analyst decision',
});

export const BENCHMARK_PART_TEXT: Readonly<Record<BenchmarkPart, string>> = Object.freeze({
  retrieval: 'Retrieval',
  answers: 'Answers',
  extraction: 'Extraction',
});

export const BENCHMARK_MODE_TEXT: Readonly<Record<BenchmarkMode, string>> = Object.freeze({
  hybrid: 'Hybrid',
  vector: 'Vector only',
  pipeline: 'Pipeline',
});

export const BENCHMARK_OUTCOME_TEXT: Readonly<Record<BenchmarkOutcome, string>> = Object.freeze({
  pass: 'Pass',
  partial: 'Partial',
  fail: 'Fail',
  skipped: 'Skipped',
});

export const BENCHMARK_STATUS_TEXT: Readonly<Record<BenchmarkRunStatus, string>> = Object.freeze({
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
});

export const EXTRACTION_LINK_STATE_TEXT: Readonly<Record<ExtractionLinkState, string>> = Object.freeze({
  live_auto: 'Live without review',
  live_approved: 'Live after approval',
  waiting: 'Waiting for the Analyst',
  rejected: 'Rejected',
  removed: 'Removed',
  absent: 'Not found',
});

export const BENCHMARK_SKIP_REASON_TEXT: Readonly<Record<BenchmarkSkipReason, string>> = Object.freeze({
  no_expected_records: 'No expected records to score against',
  expected_record_not_found: "An expected record wasn't found in the org, or was found twice",
  hidden: 'The answer is above the clearance it was read with',
});

export const BENCHMARK_INJECTION_KIND_TEXT: Readonly<Record<BenchmarkInjectionKind, string>> = Object.freeze({
  ignore_instructions: 'Ignore instructions',
  leak_data: 'Leak data',
  add_links: 'Add links',
});

/** The two commands the empty state shows. */
export const BENCHMARK_EMPTY_COMMANDS: readonly string[] = Object.freeze([
  'pnpm bench:questions --data data/generated/<seed>-<size>',
  'pnpm bench:run --org <org slug> --set <question set> --part all --wait',
]);

export const BENCHMARK_TEXT = Object.freeze({
  /** A run above the reader's clearance (D51). */
  hidden: 'Hidden: this run used records above your clearance, so its questions and answers are hidden.',
  /** No runs yet; the two commands follow. */
  empty: 'No benchmark runs yet. Run one on the Mac:',
});

function wholeAtLeastZero(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** "Running: N of M questions". */
export function benchmarkRunningText(done: number, total: number): string {
  return `Running: ${wholeAtLeastZero(done)} of ${wholeAtLeastZero(total)} questions`;
}

/** "No progress since …", with the time already written out for the reader. */
export function benchmarkNoProgressText(since: string): string {
  return `No progress since ${since}`;
}

function textOf<K extends string>(table: Readonly<Record<K, string>>, value: string): string {
  return Object.hasOwn(table, value) ? table[value as K] : value;
}

/** The words for a kind; anything unknown is shown as it is. */
export function benchmarkKindText(kind: string): string {
  return textOf(BENCHMARK_KIND_TEXT, kind);
}

/** The words for a part; anything unknown is shown as it is. */
export function benchmarkPartText(part: string): string {
  return textOf(BENCHMARK_PART_TEXT, part);
}

/** The words for a mode; anything unknown is shown as it is. */
export function benchmarkModeText(mode: string): string {
  return textOf(BENCHMARK_MODE_TEXT, mode);
}

/** The words for an outcome; anything unknown is shown as it is. */
export function benchmarkOutcomeText(outcome: string): string {
  return textOf(BENCHMARK_OUTCOME_TEXT, outcome);
}

/** The words for a run status; anything unknown is shown as it is. */
export function benchmarkStatusText(status: string): string {
  return textOf(BENCHMARK_STATUS_TEXT, status);
}

/** The words for an extraction link state; anything unknown is shown as it is. */
export function extractionLinkStateText(state: string): string {
  return textOf(EXTRACTION_LINK_STATE_TEXT, state);
}

/** The words for a skip reason; any other code is shown as it is. */
export function benchmarkSkipReasonText(reason: string): string {
  return textOf(BENCHMARK_SKIP_REASON_TEXT, reason);
}

/** The words for an injection kind; anything unknown is shown as it is. */
export function benchmarkInjectionKindText(kind: string): string {
  return textOf(BENCHMARK_INJECTION_KIND_TEXT, kind);
}

/** A metric's label; anything unknown is shown as it is. */
export function benchmarkMetricLabel(name: string): string {
  return Object.hasOwn(BENCHMARK_METRIC_BY_NAME, name)
    ? BENCHMARK_METRIC_BY_NAME[name as BenchmarkMetricName].label
    : name;
}
