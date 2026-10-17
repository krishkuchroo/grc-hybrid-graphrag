// What scoring a search answer and scoring a chat answer share (S8-004): the expected records as the
// org holds them, the item forms the scores fill, the metric values (each only where S8-001 measures
// it), the expected-record and injection details, and matching a result or a citation to an expected
// record. Pure: no I/O, no clock, no randomness.
import {
  BENCHMARK_ITEM_METRICS,
  BENCHMARK_LIMITS,
  metricAppliesTo,
  type BenchmarkExpectedDetail,
  type BenchmarkInjectionDetail,
  type BenchmarkItemMetric,
  type BenchmarkItemMetrics,
  type BenchmarkPart,
  type BenchmarkQuestion,
  type BenchmarkResultItemInput,
  type SearchMode,
  type SearchRecordKind,
} from '@grc/shared';
import { namesNormalised, recordMatcher, storableText, type RecordMatcher } from './text.js';

/** A question's expected record resolved to the org's record: its internal ID, number, name and kind. */
export interface ResolvedExpectedRecord {
  id: string;
  number: string;
  name: string;
  kind: SearchRecordKind;
}

/** A retrieval item, as `scoreRetrieval` gives it and a batch sends it. */
export type RetrievalResultItem = Extract<BenchmarkResultItemInput, { part: 'retrieval' }>;
/** An answers item, as `scoreAnswer` gives it and a batch sends it. */
export type AnswersResultItem = Extract<BenchmarkResultItemInput, { part: 'answers' }>;

/** An expected record with its matcher, normalised once. */
export interface ExpectedMatcher {
  readonly record: ResolvedExpectedRecord;
  readonly matcher: RecordMatcher;
}

/** The expected records each once (by ID, then by number), in the order given, at most the most a
 * question names. A `no_answer` question expects none, whatever is passed. */
export function expectedOf(
  question: BenchmarkQuestion,
  expected: readonly ResolvedExpectedRecord[] | null | undefined,
): ExpectedMatcher[] {
  if (question.kind === 'no_answer' || !Array.isArray(expected)) return [];
  const ids = new Set<string>();
  const numbers = new Set<string>();
  const out: ExpectedMatcher[] = [];
  for (const record of expected) {
    if (record === null || typeof record !== 'object') continue;
    if (ids.has(record.id) || numbers.has(record.number)) continue;
    ids.add(record.id);
    numbers.add(record.number);
    out.push({ record, matcher: recordMatcher(record) });
    if (out.length === BENCHMARK_LIMITS.expectedPerQuestion) break;
  }
  return out;
}

/** Whether a record (a record result or a cited record) is the expected record: the same ID, or the
 * same number. */
export function isExpectedRecord(record: { id?: string; number: string }, expected: ExpectedMatcher): boolean {
  return (record.id !== undefined && record.id === expected.record.id) || record.number === expected.record.number;
}

/** Whether an already normalised text (a passage) names the expected record. */
export function textNamesExpected(normalisedText: string, expected: ExpectedMatcher): boolean {
  return namesNormalised(normalisedText, expected.matcher);
}

/** The expected records as an item's details list them. */
export function expectedDetails(expected: readonly ExpectedMatcher[]): BenchmarkExpectedDetail[] {
  return expected.map(({ record }) => ({ number: record.number, name: storableText(record.name), kind: record.kind }));
}

/** An injection trap's details, with whether the answer followed it (null when no answer was
 * checked); null for any other question. */
export function injectionDetail(
  question: BenchmarkQuestion,
  followed: boolean | null,
): BenchmarkInjectionDetail | null {
  if (question.kind !== 'injection_trap') return null;
  return { kind: question.injection.kind, fileName: question.injection.fileName, followed };
}

/** The metric values an item may carry, in S8-001's order: each finite value whose metric is
 * measured for the part, mode and question kind; the rest are left out. */
export function itemMetrics(
  part: BenchmarkPart,
  mode: SearchMode,
  kind: BenchmarkQuestion['kind'],
  values: Partial<Record<BenchmarkItemMetric, number | null | undefined>>,
): BenchmarkItemMetrics {
  const out: BenchmarkItemMetrics = {};
  for (const name of BENCHMARK_ITEM_METRICS) {
    const value = values[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (!metricAppliesTo(name, part, mode, kind)) continue;
    out[name] = value;
  }
  return out;
}

/** The share `found / total`; null when there is nothing to share. */
export function share(found: number, total: number): number | null {
  return total > 0 ? Math.min(1, Math.max(0, found / total)) : null;
}

/** A time in milliseconds, or null when it is missing or not a time. */
export function msOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
