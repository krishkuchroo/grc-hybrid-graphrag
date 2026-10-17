// The result items the command makes itself (S8-005), beside the scored ones (S8-004): a question
// in one part and mode that couldn't be scored, `skipped` with its reason, or that failed on the
// way (an API error, a broken answer stream), `fail` with its code and the error's reference ID
// (D47). Both carry the question, its expected records and, for an injection trap, its planted
// instruction (not checked), and no metric values. Every item fits S8-001's input form.
import {
  BENCHMARK_LIMITS,
  benchmarkCodeSchema,
  benchmarkResultItemInputSchema,
  type BenchmarkExpectedDetail,
  type BenchmarkQuestion,
  type BenchmarkQuestionPart,
  type BenchmarkResultItemInput,
  type BenchmarkTimings,
  type SearchMode,
} from '@grc/shared';
import { injectionDetail } from '../score/common.js';
import { storableText } from '../score/text.js';

const NO_TIMINGS: BenchmarkTimings = Object.freeze({
  embeddingMs: null,
  vectorSearchMs: null,
  queryWritingMs: null,
  queryRunningMs: null,
  fusionMs: null,
  waitedMs: null,
  firstWordsMs: null,
  totalMs: null,
});

const REFERENCE = /^[A-Za-z0-9-]{1,100}$/;

/** A short code as an item can store it, else the fallback. */
export function itemCode(code: string, fallback: string): string {
  return benchmarkCodeSchema.safeParse(code).success ? code : fallback;
}

/** A reference ID as an item can store it, else null. */
export function itemReference(referenceId: string | null | undefined): string | null {
  return typeof referenceId === 'string' && REFERENCE.test(referenceId) ? referenceId : null;
}

/** A question's item in one part and mode that wasn't scored: `skipped` with its reason, or `fail`
 * with its error code and reference ID. */
export function unscoredItem(
  question: BenchmarkQuestion,
  part: BenchmarkQuestionPart,
  mode: SearchMode,
  outcome: 'fail' | 'skipped',
  reason: string,
  expected: readonly BenchmarkExpectedDetail[],
  referenceId: string | null = null,
): BenchmarkResultItemInput {
  const details = {
    reason: itemCode(reason, outcome === 'skipped' ? 'not_scored' : 'failed'),
    referenceId: itemReference(referenceId),
    question: storableText(question.text),
    expected: expected.slice(0, BENCHMARK_LIMITS.expectedPerQuestion),
    found: [],
    firstMatchRank: null,
    graph: null,
    timings: { ...NO_TIMINGS },
    answer: null,
    injection: injectionDetail(question, null),
  };
  const base = { itemKey: question.id, mode, kind: question.kind, outcome, metrics: {} };
  return part === 'retrieval' ? { ...base, part, details } : { ...base, part, details };
}

/** The item as the API takes it, or a `fail` item (`item_not_valid`) in its place when a scored
 * item somehow doesn't fit S8-001's form, so one bad item never refuses a whole batch. */
export function sendableItem(
  item: BenchmarkResultItemInput,
  question: BenchmarkQuestion,
  expected: readonly BenchmarkExpectedDetail[],
): BenchmarkResultItemInput {
  if (benchmarkResultItemInputSchema.safeParse(item).success) return item;
  if (item.part === 'extraction') return item;
  return unscoredItem(question, item.part, item.mode, 'fail', 'item_not_valid', expected);
}
