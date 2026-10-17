// One extraction run through the real API (S8-006; D24, D38, D42, D45.8, D47, D52.6, D64): how well
// a full-pipeline org's extraction did against the answer key, stored as one run with S8-002's routes.
// The API key, the org and the output are the command's (packages/infra/scripts/bench-run.ts); this
// is the run itself, through `ExtractionApi` only, and it changes nothing in the org but the run.
// 1. `--wait`: until none of the org's documents is waiting or being processed (../run/wait.ts);
//    when the minutes are up, no run is started.
// 2. The org, read (./snapshot.ts): its records, their links and its link findings.
// 3. The items, scored by fixed rules (./score.ts).
// 4. `POST /api/v1/benchmark/runs` with part `extraction`, mode `pipeline`, the set's format version
//    and source (the data version), no questions, and the org's records the answer key couldn't be
//    matched to, per kind, which the API keeps in the run's settings.
// 5. The items in batches of at most 25, then `POST …/finish`: `finished`, or `failed` with a code.
//    The API's summary holds the seven extraction ratios, each with its numerator and denominator.
// Failures: a 429 is waited out by the client and the same call sent again. The API unreachable
// (`api_unreachable`), the org not read (`records_not_read`), results that couldn't be stored
// (`results_not_stored`) or a stop (Ctrl-C, `stopped`) end it early: before the run starts, no run
// is made; after, the run is finished `failed` with its code. Nothing here is random: the same org
// and answer key always give the same items (D45.8).
import {
  BENCHMARK_EXTRACTION_MODE,
  BENCHMARK_LIMITS,
  summariseBenchmark,
  type BenchmarkResultItemInput,
  type BenchmarkRunDetail,
  type BenchmarkSummary,
  type QuestionSet,
} from '@grc/shared';
import { BenchStoppedError, type CallOptions } from '../run/api-client.js';
import {
  BENCH_RUN_FAILURES,
  FINAL_CALL_TIMEOUT_MS,
  benchErrorLine,
  isUnreachable,
  type BenchRunStored,
} from '../run/run.js';
import { waitForDocuments, type DocumentCounts } from '../run/wait.js';
import type { ExpectedOrg } from './expected.js';
import { scoreExtraction, type ExtractionCounts } from './score.js';
import { readOrgSnapshot, type ExtractionApi, type OrgSnapshot } from './snapshot.js';

export interface ExtractionRunInput {
  api: ExtractionApi;
  /** The generated question set the run is filed under (its source is the data version). */
  set: QuestionSet;
  /** What the org's sources state and plant (./expected.ts). */
  expected: ExpectedOrg;
  /** Minutes to wait for the org's documents first; null for no wait. */
  waitMinutes: number | null;
  /** The command's stop (Ctrl-C). */
  signal: AbortSignal;
  /** A timer that ends early (rejecting) when the stop signal is aborted. */
  sleep: (ms: number) => Promise<void>;
  /** One line of progress: IDs, counts, outcomes and times only. */
  log: (line: string) => void;
  now?: () => number;
}

export interface ExtractionRunResult {
  /** `finished`; `failed` (a run that ended early, or couldn't be finished); `not_started`. */
  end: 'finished' | 'failed' | 'not_started';
  /** The run's failure code, or why none was started; null when it finished. */
  failure: string | null;
  /** The error behind the failure, in one line (never the API's message). */
  errorLine: string | null;
  runId: string | null;
  /** The run as the API last gave it: the finish answer, else the start answer. */
  run: BenchmarkRunDetail | null;
  /** What was read and scored; null when the org couldn't be read. */
  counts: ExtractionCounts | null;
  /** Every item, as sent. */
  items: BenchmarkResultItemInput[];
  stored: BenchRunStored;
  /** The API's summary of the finished run, or the same summary computed here when it gave none. */
  summary: BenchmarkSummary;
  summaryFrom: 'api' | 'local';
  /** The documents still waiting and being processed at the last check (`--wait` only). */
  documents: DocumentCounts | null;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

function finalOptions(): CallOptions {
  return { signal: AbortSignal.timeout(FINAL_CALL_TIMEOUT_MS), timeoutMs: FINAL_CALL_TIMEOUT_MS };
}

/** Runs the extraction part: never throws; every way it ends is in the result. */
export async function runExtraction(input: ExtractionRunInput): Promise<ExtractionRunResult> {
  const now = input.now ?? (() => Date.now());
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const { api, set, expected, log } = input;

  const result: ExtractionRunResult = {
    end: 'not_started',
    failure: null,
    errorLine: null,
    runId: null,
    run: null,
    counts: null,
    items: [],
    stored: { batches: 0, stored: 0, repeats: 0, unsent: 0 },
    summary: summariseBenchmark([]),
    summaryFrom: 'local',
    documents: null,
    startedAt,
    endedAt: startedAt,
    elapsedMs: 0,
  };
  const done = (): ExtractionRunResult => {
    const endedMs = now();
    result.endedAt = new Date(endedMs).toISOString();
    result.elapsedMs = Math.max(0, endedMs - startedMs);
    if (result.summaryFrom === 'local') result.summary = summariseBenchmark(result.items);
    return result;
  };
  const notStarted = (failure: string, err?: unknown): ExtractionRunResult => {
    result.end = 'not_started';
    result.failure = input.signal.aborted || err instanceof BenchStoppedError ? BENCH_RUN_FAILURES.stopped : failure;
    result.errorLine = err === undefined || err instanceof BenchStoppedError ? null : benchErrorLine(err);
    return done();
  };
  const readFailure = (err: unknown): string =>
    isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.recordsNotRead;

  // 1. The org's documents, processed first.
  if (input.waitMinutes !== null) {
    log(`waiting up to ${input.waitMinutes} min for the org's documents to be processed`);
    try {
      const waited = await waitForDocuments(api, {
        minutes: input.waitMinutes,
        sleep: input.sleep,
        now,
        onCounts: (counts, minutes) =>
          log(`  documents waiting ${counts.waiting}, being processed ${counts.processing} (${minutes} min waited)`),
      });
      result.documents = waited.counts;
      if (!waited.done) return notStarted(BENCH_RUN_FAILURES.documentsNotProcessed);
      log('  every document is processed');
    } catch (err) {
      return notStarted(readFailure(err), err);
    }
  }

  // 2. The org, read.
  log("reading the org's records, links and link findings");
  let snapshot: OrgSnapshot;
  try {
    snapshot = await readOrgSnapshot(api, log);
  } catch (err) {
    return notStarted(readFailure(err), err);
  }

  // 3. The items, scored.
  try {
    const scored = scoreExtraction(expected, snapshot);
    result.counts = scored.counts;
    result.items = scored.items;
  } catch (err) {
    return notStarted(BENCH_RUN_FAILURES.unexpectedError, err);
  }
  log(`scored ${result.items.length} item(s)`);
  if (input.signal.aborted) return notStarted(BENCH_RUN_FAILURES.stopped);

  // 4. The run.
  try {
    result.run = await api.startRun({
      parts: ['extraction'],
      modes: [BENCHMARK_EXTRACTION_MODE],
      questionSet: { version: set.version, source: set.source },
      questionCount: 0,
      unmatchedRecords: { ...(result.counts?.unmatched ?? {}) },
    });
    result.runId = result.run.id;
  } catch (err) {
    return notStarted(isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.runNotStarted, err);
  }
  const runId = result.runId;
  log(`run ${runId} started: ${result.items.length} extraction item(s)`);

  // 5. The items, then the end.
  for (let i = 0; i < result.items.length; i += BENCHMARK_LIMITS.itemsPerBatch) {
    if (input.signal.aborted) {
      result.failure = BENCH_RUN_FAILURES.stopped;
      result.stored.unsent += result.items.length - i;
      break;
    }
    const batch = result.items.slice(i, i + BENCHMARK_LIMITS.itemsPerBatch);
    try {
      const added = await api.addResults(runId, { items: batch });
      result.stored.batches += 1;
      result.stored.stored += added.stored;
      result.stored.repeats += added.repeats;
    } catch (err) {
      result.stored.unsent += result.items.length - i;
      if (err instanceof BenchStoppedError) {
        result.failure = BENCH_RUN_FAILURES.stopped;
      } else {
        result.failure = isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.resultsNotStored;
        result.errorLine = benchErrorLine(err);
      }
      break;
    }
  }
  if (result.failure === null) log(`  stored ${result.stored.stored} item(s) in ${result.stored.batches} batch(es)`);

  try {
    const finished = await api.finishRun(
      runId,
      result.failure === null ? { outcome: 'finished' } : { outcome: 'failed', failure: result.failure },
      finalOptions(),
    );
    result.run = finished;
    result.end = finished.status === 'finished' ? 'finished' : 'failed';
    if (finished.summary !== null) {
      result.summary = finished.summary;
      result.summaryFrom = 'api';
    }
  } catch (err) {
    result.end = 'failed';
    result.failure ??= BENCH_RUN_FAILURES.finishNotStored;
    result.errorLine ??= benchErrorLine(err);
  }
  return done();
}
