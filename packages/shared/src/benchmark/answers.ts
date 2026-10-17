// The benchmark-runs answers (D30, D45.8, D47, D51; S8-001, S8-002), shared by the API, the Benchmark
// screen (S8-010) and the benchmark command (S8-005).
// - A run list row: ID, started, finished, last activity, status (with the failure code of a failed
//   run), parts, modes, data version (the question set's source), question count, results count,
//   the headline numbers per mode (context recall and answer correctness), label and who started it.
// - A run's detail: the list row plus its settings (the start body, and what the API fills in itself:
//   the models, the prompt versions, the limits and cut-offs in effect and the injection rules) and
//   its summary (null until it finishes). A reader whose clearance is below the run's label gets
//   `hidden: true` with the list row and the summary only (D51).
// - A result row: the item plus when it was stored. A page of results is `hidden: true` with no items
//   for a reader below the run's label.
// - Adding results answers how many items were stored and how many repeated one already stored.
// Times are ISO date-times with an offset.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import {
  BENCHMARK_INJECTION_KINDS,
  BENCHMARK_MODES,
  BENCHMARK_PARTS,
  BENCHMARK_RUN_STATUSES,
  benchmarkCodeSchema,
} from './kinds.js';
import { benchmarkQuestionSetRefSchema, benchmarkUnmatchedRecordsSchema } from './bodies.js';
import { questionSetSourceSchema } from './question-set.js';
import { benchmarkResultRowSchema } from './results.js';
import { benchmarkHeadlineSchema, benchmarkSummarySchema } from './summary.js';

const dateTime = z.iso.datetime({ offset: true });
const count = z.int().min(0);

/** Who started a run: the principal user ID (an API key's is its own) and the display name, null
 * when it can't be found. */
export const benchmarkPersonSchema = z.object({ id: z.string().min(1), name: z.string().nullable() });

/** A row of `GET /api/v1/benchmark/runs`, newest first. */
export const benchmarkRunRowSchema = z.object({
  id: z.uuid(),
  startedAt: dateTime,
  finishedAt: dateTime.nullable(),
  lastActivityAt: dateTime,
  status: z.enum(BENCHMARK_RUN_STATUSES),
  /** A failed run's code; null otherwise. */
  failure: benchmarkCodeSchema.nullable(),
  parts: z.array(z.enum(BENCHMARK_PARTS)),
  modes: z.array(z.enum(BENCHMARK_MODES)),
  /** The data version: where the question set comes from (generated: generator version, seed,
   * size and org key; or hand-written). */
  dataVersion: questionSetSourceSchema,
  questionCount: count,
  resultCount: count,
  headline: benchmarkHeadlineSchema,
  /** The clearance of whoever started it (D51). */
  label: z.enum(LABELS),
  startedBy: benchmarkPersonSchema,
});

/** What a run ran with (D45.8): the start body, and what the API knows itself. */
export const benchmarkRunSettingsSchema = z.object({
  parts: z.array(z.enum(BENCHMARK_PARTS)),
  modes: z.array(z.enum(BENCHMARK_MODES)),
  questionSet: benchmarkQuestionSetRefSchema,
  questionCount: count,
  /** Extraction only: the org's records that couldn't be matched to the answer key, per kind. */
  unmatchedRecords: benchmarkUnmatchedRecordsSchema.optional(),
  /** The text model (Gemma) and the embedding model (bge-m3) the API runs with. */
  models: z.object({ text: z.string().min(1), embedding: z.string().min(1) }),
  /** The prompt versions in effect, by step (for example `extraction`, `graphQuery`, `answer`). */
  promptVersions: z.record(z.string(), z.string()),
  /** The search and chat limits in effect (`SEARCH_LIMITS`). */
  limits: z.record(z.string(), z.number()),
  /** The duplicate-matching cut-offs in effect (S4). */
  cutOffs: z.record(z.string(), z.number()),
  /** The injection checks, in plain words (`INJECTION_CHECKS`). */
  injectionChecks: z.strictObject(
    Object.fromEntries(BENCHMARK_INJECTION_KINDS.map((kind) => [kind, z.string()])) as {
      [K in (typeof BENCHMARK_INJECTION_KINDS)[number]]: z.ZodString;
    },
  ),
});

export const visibleBenchmarkRunSchema = benchmarkRunRowSchema.extend({
  hidden: z.literal(false),
  settings: benchmarkRunSettingsSchema,
  /** Null until the run ends. */
  summary: benchmarkSummarySchema.nullable(),
});

/** A run above the reader's clearance: the list row and the summary only. */
export const hiddenBenchmarkRunSchema = benchmarkRunRowSchema.extend({
  hidden: z.literal(true),
  summary: benchmarkSummarySchema.nullable(),
});

/** `GET /api/v1/benchmark/runs/:id`; also the answer of starting and finishing a run. */
export const benchmarkRunDetailSchema = z.discriminatedUnion('hidden', [
  visibleBenchmarkRunSchema,
  hiddenBenchmarkRunSchema,
]);

/** A page of `GET /api/v1/benchmark/runs`. */
export const benchmarkRunsPageSchema = z.object({
  items: z.array(benchmarkRunRowSchema),
  page: z.int().min(1),
  pageSize: z.int().min(1),
  total: count,
});

/** A page of `GET /api/v1/benchmark/runs/:id/results`; `hidden: true` with no items for a reader
 * below the run's label. */
export const benchmarkResultsPageSchema = z.object({
  items: z.array(benchmarkResultRowSchema),
  page: z.int().min(1),
  pageSize: z.int().min(1),
  total: count,
  hidden: z.boolean(),
});

/** `POST /api/v1/benchmark/runs/:id/results`: the items stored, and those that repeated an item
 * already stored (the same item key and mode), which were ignored. */
export const benchmarkResultsAddedSchema = z.object({
  stored: count,
  repeats: count,
});

export type BenchmarkPerson = z.infer<typeof benchmarkPersonSchema>;
export type BenchmarkRunRow = z.infer<typeof benchmarkRunRowSchema>;
export type BenchmarkRunSettings = z.infer<typeof benchmarkRunSettingsSchema>;
export type VisibleBenchmarkRun = z.infer<typeof visibleBenchmarkRunSchema>;
export type HiddenBenchmarkRun = z.infer<typeof hiddenBenchmarkRunSchema>;
export type BenchmarkRunDetail = z.infer<typeof benchmarkRunDetailSchema>;
export type BenchmarkRunsPage = z.infer<typeof benchmarkRunsPageSchema>;
export type BenchmarkResultsPage = z.infer<typeof benchmarkResultsPageSchema>;
export type BenchmarkResultsAdded = z.infer<typeof benchmarkResultsAddedSchema>;
