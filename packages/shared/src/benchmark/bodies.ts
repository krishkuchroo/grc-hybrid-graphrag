// The benchmark-runs request bodies (D30, D47; S8-001). Unknown fields are refused.
// - Start, `POST /api/v1/benchmark/runs`: `{ parts, modes, questionSet: { version, source },
//   questionCount }`. Parts and modes are listed once each; every mode is one a part asked for runs
//   in (`hybrid` and `vector` for retrieval and answers, `pipeline` for extraction), and every part
//   has one of its modes. The question count is 0 to 200 (an extraction-only run asks no
//   questions). An extraction run may also say how many of the org's records it couldn't match to
//   the answer key, per record kind (S8-006), which the API keeps in the run's settings.
// - Add results, `POST /api/v1/benchmark/runs/:id/results`: `{ items }`, 1 to 25 result items.
// - Finish, `POST /api/v1/benchmark/runs/:id/finish`: `{ outcome: 'finished' | 'failed', failure? }`,
//   where `failure` is a short code, given only (and always) with `failed`.
import { z } from 'zod';
import { SEARCH_RECORD_KINDS } from '../search/kinds.js';
import {
  BENCHMARK_FINISH_OUTCOMES,
  BENCHMARK_LIMITS,
  BENCHMARK_MODES,
  BENCHMARK_PART_MODES,
  BENCHMARK_PARTS,
  benchmarkCodeSchema,
} from './kinds.js';
import { QUESTION_SET_FORMAT_VERSION, questionSetSourceSchema } from './question-set.js';
import { benchmarkResultItemInputSchema } from './results.js';

function once<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

/** The question set a run uses: its format version and its source (the data version). */
export const benchmarkQuestionSetRefSchema = z.strictObject({
  version: z.literal(QUESTION_SET_FORMAT_VERSION),
  source: questionSetSourceSchema,
});

/** Per record kind, how many of the org's records couldn't be matched to the answer key. */
export const benchmarkUnmatchedRecordsSchema = z.strictObject(
  Object.fromEntries(SEARCH_RECORD_KINDS.map((kind) => [kind, z.int().min(0).optional()])) as {
    [K in (typeof SEARCH_RECORD_KINDS)[number]]: z.ZodOptional<z.ZodInt>;
  },
);

export const startBenchmarkRunBodySchema = z
  .strictObject({
    parts: z.array(z.enum(BENCHMARK_PARTS)).min(1).max(BENCHMARK_PARTS.length),
    modes: z.array(z.enum(BENCHMARK_MODES)).min(1).max(BENCHMARK_MODES.length),
    questionSet: benchmarkQuestionSetRefSchema,
    questionCount: z.int().min(0).max(BENCHMARK_LIMITS.questionsPerSet),
    /** Extraction only: the org's records the answer key couldn't be matched to, per record kind. */
    unmatchedRecords: benchmarkUnmatchedRecordsSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (!once(body.parts)) ctx.addIssue({ code: 'custom', path: ['parts'], message: 'each part only once' });
    if (!once(body.modes)) ctx.addIssue({ code: 'custom', path: ['modes'], message: 'each mode only once' });
    body.modes.forEach((mode, i) => {
      if (!body.parts.some((part) => BENCHMARK_PART_MODES[part].includes(mode))) {
        ctx.addIssue({ code: 'custom', path: ['modes', i], message: 'no part asked for runs in this mode' });
      }
    });
    body.parts.forEach((part, i) => {
      if (!BENCHMARK_PART_MODES[part].some((mode) => body.modes.includes(mode))) {
        ctx.addIssue({ code: 'custom', path: ['parts', i], message: 'none of its modes was asked for' });
      }
    });
    if (body.unmatchedRecords !== undefined && !body.parts.includes('extraction')) {
      ctx.addIssue({ code: 'custom', path: ['unmatchedRecords'], message: 'only for an extraction run' });
    }
  });

export const addBenchmarkResultsBodySchema = z.strictObject({
  items: z.array(benchmarkResultItemInputSchema).min(1).max(BENCHMARK_LIMITS.itemsPerBatch),
});

export const finishBenchmarkRunBodySchema = z
  .strictObject({
    outcome: z.enum(BENCHMARK_FINISH_OUTCOMES),
    failure: benchmarkCodeSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.outcome === 'failed' && body.failure === undefined) {
      ctx.addIssue({ code: 'custom', path: ['failure'], message: 'a failed run needs its code' });
    }
    if (body.outcome === 'finished' && body.failure !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['failure'], message: 'only a failed run has a code' });
    }
  });

export type BenchmarkUnmatchedRecords = z.infer<typeof benchmarkUnmatchedRecordsSchema>;
export type BenchmarkQuestionSetRef = z.infer<typeof benchmarkQuestionSetRefSchema>;
export type StartBenchmarkRunBody = z.infer<typeof startBenchmarkRunBodySchema>;
export type AddBenchmarkResultsBody = z.infer<typeof addBenchmarkResultsBodySchema>;
export type FinishBenchmarkRunBody = z.infer<typeof finishBenchmarkRunBodySchema>;
