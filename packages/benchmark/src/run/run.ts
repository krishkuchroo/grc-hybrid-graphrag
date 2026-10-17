// One benchmark run through the real API (S8-005; D1, D45.8, D46, D47, D48, D64): a question set's
// questions searched, and with the answers part asked, in each mode, scored by S8-004's fixed rules
// and stored as one run with S8-002's routes. The API key, the org and the output are the command's
// (packages/infra/scripts/bench-run.ts); this is the run itself, through `BenchApi` only.
// 1. `--wait`: until none of the org's documents is waiting or being processed (./wait.ts); when
//    the minutes are up, no run is started.
// 2. The expected records, found through the record lists (./resolve.ts). A question with one not
//    found, or found twice, is stored `skipped` (`expected_record_not_found`) and never asked.
// 3. `POST /api/v1/benchmark/runs` with the parts, the modes, the set's format version and source
//    (the data version) and the question count.
// 4. Question by question in the set's order, mode by mode: `retrieval`, one search scored with
//    `scoreRetrieval`; `answers`, a new conversation, the question asked in that mode, its stream
//    read to `done` or `error`, the saved message scored with `scoreAnswer`. Each question's items
//    are sent as soon as it is done (at most 25 a batch), so the Benchmark screen shows progress.
// 5. `POST …/finish`: `finished`, or `failed` with a code.
// Waits and failures: a 429 is waited out by the client and the same call sent again; waiting in
// Gemma's queue is normal. Any other failure on one question stores that item `fail` with its code
// and reference ID. Five failures in a row (`too_many_failures`), the API unreachable
// (`api_unreachable`), results that couldn't be stored (`results_not_stored`) or a stop (Ctrl-C,
// `stopped`) end the run `failed`; whatever was scored is stored first. Nothing here is random: the
// same answers always give the same items (D45.8).
import {
  BENCHMARK_LIMITS,
  summariseBenchmark,
  type BenchmarkQuestion,
  type BenchmarkQuestionPart,
  type BenchmarkResultItemInput,
  type BenchmarkRunDetail,
  type BenchmarkSummary,
  type QuestionSet,
  type SearchMode,
} from '@grc/shared';
import { ApiRequestError } from '@grc/generators';
import { scoreAnswer } from '../score/answers.js';
import type { ResolvedExpectedRecord } from '../score/common.js';
import { scoreRetrieval } from '../score/retrieval.js';
import { BenchStoppedError, type BenchApi, type CallOptions } from './api-client.js';
import { sendableItem, unscoredItem } from './items.js';
import { expectedKinds, readOrgRecords, resolveQuestion, type QuestionResolution } from './resolve.js';
import { waitForDocuments, type DocumentCounts } from './wait.js';

/** Failures in a row that end the run. */
export const MAX_FAILURES_IN_A_ROW = 5;
/** The time limit of each call that ends a run (storing the last results, finishing it). */
export const FINAL_CALL_TIMEOUT_MS = 60_000;

/** The codes a run that ends early gets (each fits S8-001's code rule), and those of a run that
 * never started. */
export const BENCH_RUN_FAILURES = Object.freeze({
  tooManyFailures: 'too_many_failures',
  apiUnreachable: 'api_unreachable',
  resultsNotStored: 'results_not_stored',
  stopped: 'stopped',
  documentsNotProcessed: 'documents_not_processed',
  recordsNotRead: 'records_not_read',
  runNotStarted: 'run_not_started',
  finishNotStored: 'finish_not_stored',
  unexpectedError: 'unexpected_error',
} as const);

export interface BenchRunInput {
  api: BenchApi;
  set: QuestionSet;
  parts: readonly BenchmarkQuestionPart[];
  modes: readonly SearchMode[];
  /** Only the first N questions; null for all. */
  limit: number | null;
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

export interface BenchRunQuestion {
  question: BenchmarkQuestion;
  resolution: QuestionResolution;
}

export interface BenchRunStored {
  batches: number;
  stored: number;
  repeats: number;
  /** Items scored but not stored (a batch the API refused, or the API gone). */
  unsent: number;
}

export interface BenchRunResult {
  /** `finished`; `failed` (a run that ended early, or couldn't be finished); `not_started`. */
  end: 'finished' | 'failed' | 'not_started';
  /** The run's failure code, or why none was started; null when it finished. */
  failure: string | null;
  /** The error behind the failure, in one line: an API refusal's method, path, status, code and
   * reference ID, or the error's type. Never the API's message. */
  errorLine: string | null;
  runId: string | null;
  /** The run as the API last gave it: the finish answer, else the start answer. */
  run: BenchmarkRunDetail | null;
  questions: BenchRunQuestion[];
  /** Every item, as sent (answers in full). */
  items: BenchmarkResultItemInput[];
  stored: BenchRunStored;
  /** The API's summary of the finished run, or the same summary computed here when the finish
   * couldn't be stored. */
  summary: BenchmarkSummary;
  summaryFrom: 'api' | 'local';
  /** The documents still waiting and being processed at the last check (`--wait` only). */
  documents: DocumentCounts | null;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

/** An error in one line (D163, D164): an API refusal's method, path, status, code and reference
 * ID; else the error's type and code. */
export function benchErrorLine(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof BenchStoppedError) return 'stopped';
  if (typeof err !== 'object' || err === null) return 'type=unknown';
  const e = err as { name?: unknown; code?: unknown };
  const type = typeof e.name === 'string' ? e.name : 'unknown';
  return typeof e.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(e.code)
    ? `type=${type} code=${e.code}`
    : `type=${type}`;
}

/** Whether the error means the API can't be reached: no answer at all, or the front door's 502 or
 * 504 when nothing answers behind it. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.code === 'network_error' || err.status === 502 || err.status === 504);
}

class EndRun extends Error {
  constructor(
    readonly failure: string,
    readonly cause?: unknown,
  ) {
    super(failure);
    this.name = 'EndRun';
  }
}

function finalOptions(): CallOptions {
  return { signal: AbortSignal.timeout(FINAL_CALL_TIMEOUT_MS), timeoutMs: FINAL_CALL_TIMEOUT_MS };
}

/** Runs the benchmark: never throws; every way it ends is in the result. */
export async function runBenchmark(input: BenchRunInput): Promise<BenchRunResult> {
  const now = input.now ?? (() => Date.now());
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const { api, set, parts, modes, log } = input;
  const questions = input.limit === null ? set.questions : set.questions.slice(0, input.limit);

  const result: BenchRunResult = {
    end: 'not_started',
    failure: null,
    errorLine: null,
    runId: null,
    run: null,
    questions: [],
    items: [],
    stored: { batches: 0, stored: 0, repeats: 0, unsent: 0 },
    summary: summariseBenchmark([]),
    summaryFrom: 'local',
    documents: null,
    startedAt,
    endedAt: startedAt,
    elapsedMs: 0,
  };
  const done = (): BenchRunResult => {
    const endedMs = now();
    result.endedAt = new Date(endedMs).toISOString();
    result.elapsedMs = Math.max(0, endedMs - startedMs);
    if (result.summaryFrom === 'local') result.summary = summariseBenchmark(result.items);
    return result;
  };
  const notStarted = (failure: string, err?: unknown): BenchRunResult => {
    result.end = 'not_started';
    result.failure = input.signal.aborted || err instanceof BenchStoppedError ? BENCH_RUN_FAILURES.stopped : failure;
    result.errorLine = err === undefined ? null : benchErrorLine(err);
    return done();
  };

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
      return notStarted(
        isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.recordsNotRead,
        err,
      );
    }
  }

  // 2. The expected records, from the record lists.
  try {
    const records = await readOrgRecords(api, expectedKinds(questions));
    result.questions = questions.map((question) => ({ question, resolution: resolveQuestion(question, records) }));
  } catch (err) {
    return notStarted(isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.recordsNotRead, err);
  }
  const skipped = result.questions.filter((q) => q.resolution.resolved === null).length;
  log(
    `expected records found for ${result.questions.length - skipped} of ${result.questions.length} question(s)` +
      (skipped > 0 ? `; ${skipped} skipped (expected_record_not_found)` : ''),
  );
  if (input.signal.aborted) return notStarted(BENCH_RUN_FAILURES.stopped);

  // 3. The run.
  try {
    result.run = await api.startRun({
      parts: [...parts],
      modes: [...modes],
      questionSet: { version: set.version, source: set.source },
      questionCount: questions.length,
    });
    result.runId = result.run.id;
  } catch (err) {
    return notStarted(isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.runNotStarted, err);
  }
  const runId = result.runId;
  log(`run ${runId} started: ${questions.length} question(s), parts ${parts.join(', ')}, modes ${modes.join(', ')}`);

  // 4. Question by question, mode by mode.
  let failuresInARow = 0;
  let ended: EndRun | null = null;

  const failed = (): void => {
    failuresInARow += 1;
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) throw new EndRun(BENCH_RUN_FAILURES.tooManyFailures);
  };

  const store = async (items: BenchmarkResultItemInput[], final: boolean): Promise<void> => {
    for (let i = 0; i < items.length; i += BENCHMARK_LIMITS.itemsPerBatch) {
      const batch = items.slice(i, i + BENCHMARK_LIMITS.itemsPerBatch);
      try {
        const added = await api.addResults(runId, { items: batch }, final ? finalOptions() : undefined);
        result.stored.batches += 1;
        result.stored.stored += added.stored;
        result.stored.repeats += added.repeats;
      } catch (err) {
        if (err instanceof BenchStoppedError && !final) {
          // Stopped while a batch was on its way: what is left is sent once more as the run ends.
          await store(items.slice(i), true);
          throw new EndRun(BENCH_RUN_FAILURES.stopped);
        }
        result.stored.unsent += items.length - i;
        throw new EndRun(
          isUnreachable(err) ? BENCH_RUN_FAILURES.apiUnreachable : BENCH_RUN_FAILURES.resultsNotStored,
          err,
        );
      }
    }
  };

  for (const [index, { question, resolution }] of result.questions.entries()) {
    const items: BenchmarkResultItemInput[] = [];
    const add = (item: BenchmarkResultItemInput): void => {
      const sendable = sendableItem(item, question, resolution.expected);
      items.push(sendable);
      result.items.push(sendable);
    };
    try {
      if (input.signal.aborted) throw new BenchStoppedError();
      for (const mode of modes) {
        for (const part of parts) {
          if (resolution.resolved === null) {
            add(unscoredItem(question, part, mode, 'skipped', 'expected_record_not_found', resolution.expected));
            continue;
          }
          try {
            const scored =
              part === 'retrieval'
                ? await retrieve(api, question, resolution.resolved, mode)
                : await answer(api, question, resolution, resolution.resolved, mode);
            add(scored.item);
            if (scored.failed) failed();
            else failuresInARow = 0;
          } catch (err) {
            if (err instanceof BenchStoppedError || err instanceof EndRun) throw err;
            if (isUnreachable(err)) throw new EndRun(BENCH_RUN_FAILURES.apiUnreachable, err);
            const apiError = err instanceof ApiRequestError ? err : null;
            add(
              unscoredItem(
                question,
                part,
                mode,
                'fail',
                apiError?.code ?? 'failed',
                resolution.expected,
                apiError?.referenceId ?? null,
              ),
            );
            result.errorLine = benchErrorLine(err);
            failed();
          }
        }
      }
    } catch (err) {
      ended =
        err instanceof EndRun
          ? err
          : new EndRun(
              err instanceof BenchStoppedError ? BENCH_RUN_FAILURES.stopped : BENCH_RUN_FAILURES.unexpectedError,
              err,
            );
    }

    // The question's items, stored now (also what a question that ended the run had scored).
    if (items.length > 0) {
      try {
        await store(items, ended !== null || input.signal.aborted);
      } catch (err) {
        if (ended === null) {
          ended = err instanceof EndRun ? err : new EndRun(BENCH_RUN_FAILURES.stopped, err);
        }
      }
      log(
        `  [${index + 1}/${result.questions.length}] ${question.id} (${question.kind}): ${outcomesLine(items, modes)}`,
      );
    }
    if (ended !== null) break;
  }

  // 5. Finished, or failed with its code.
  if (ended !== null) {
    result.failure = ended.failure;
    if (ended.cause !== undefined && !(ended.cause instanceof BenchStoppedError)) {
      result.errorLine = benchErrorLine(ended.cause);
    }
  }
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

/** One line of a question's outcomes: per mode, each part's outcome. */
function outcomesLine(items: readonly BenchmarkResultItemInput[], modes: readonly SearchMode[]): string {
  const perMode = modes
    .map((mode) => {
      const ofMode = items.filter((item) => item.mode === mode);
      if (ofMode.length === 0) return null;
      return `${mode} ${ofMode.map((item) => `${item.part} ${item.outcome}`).join(', ')}`;
    })
    .filter((line): line is string => line !== null);
  return perMode.length === 0 ? 'nothing scored' : perMode.join('; ');
}

interface Scored {
  item: BenchmarkResultItemInput;
  /** The question failed (counts towards the failures in a row). */
  failed: boolean;
}

/** One search in the mode, scored. */
async function retrieve(
  api: BenchApi,
  question: BenchmarkQuestion,
  expected: readonly ResolvedExpectedRecord[],
  mode: SearchMode,
): Promise<Scored> {
  const found = await api.search(question.text, mode);
  if (found.mode !== mode) throw new ApiRequestError('POST', '/api/v1/search', 200, 'unexpected_answer', null);
  return { item: scoreRetrieval(question, expected, found), failed: false };
}

/** The question asked in a new conversation in the mode, its saved message scored; a stream that
 * ends in `error` is a failed item with its code and reference ID. */
async function answer(
  api: BenchApi,
  question: BenchmarkQuestion,
  resolution: QuestionResolution,
  expected: readonly ResolvedExpectedRecord[],
  mode: SearchMode,
): Promise<Scored> {
  const conversationId = await api.startConversation();
  const outcome = await api.ask(conversationId, question.text, mode);
  if (outcome.type === 'error') {
    return {
      item: unscoredItem(question, 'answers', mode, 'fail', outcome.code, resolution.expected, outcome.referenceId),
      failed: true,
    };
  }
  const message = outcome.message;
  if (!message.hidden && message.mode !== mode) {
    throw new ApiRequestError('POST', '/api/v1/chat/conversations/:id/messages', 200, 'unexpected_answer', null);
  }
  const item = scoreAnswer(question, expected, message, mode);
  return { item, failed: !message.hidden && message.status === 'failed' };
}
