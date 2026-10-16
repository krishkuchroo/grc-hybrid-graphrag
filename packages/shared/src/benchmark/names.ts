// The benchmark's names (D47, D56, D186; S8 shared notes, "Audit"): the audit actions, the target
// type of their entries, their meta, and the error codes with their HTTP status and a plain message.
// - `benchmark.run_started` and `benchmark.run_finished`, each written in Postgres in the transaction
//   that saves the run (`AuditService.appendInTx`), with the run as the target. Their meta holds
//   counts and headline scores and the run's label (so the audit viewer can hide the contents from
//   readers below it, D186), never a question's or an answer's text. Adding results isn't audited.
// - Error messages never hold a question, an answer or a record's name.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import {
  BENCHMARK_MODES,
  BENCHMARK_PARTS,
  BENCHMARK_RUN_STATUSES,
  benchmarkCodeSchema,
} from './kinds.js';
import { QUESTION_SET_SOURCE_TYPES } from './question-set.js';
import { benchmarkHeadlineSchema } from './summary.js';

export const BENCHMARK_AUDIT_ACTIONS = Object.freeze({
  runStarted: 'benchmark.run_started',
  runFinished: 'benchmark.run_finished',
} as const);

export type BenchmarkAuditAction = (typeof BENCHMARK_AUDIT_ACTIONS)[keyof typeof BENCHMARK_AUDIT_ACTIONS];

/** The `targetType` of a benchmark entry; its `targetId` is the run's ID. */
export const BENCHMARK_RUN_TARGET_TYPE = 'benchmark_run';

const count = z.int().min(0);

/** A `benchmark.run_started` entry's meta. */
export const benchmarkRunStartedMetaSchema = z.object({
  parts: z.array(z.enum(BENCHMARK_PARTS)),
  modes: z.array(z.enum(BENCHMARK_MODES)),
  questionCount: count,
  /** The question set's source type: generated or hand-written. */
  questionSetSource: z.enum(QUESTION_SET_SOURCE_TYPES),
  label: z.enum(LABELS),
});

/** A `benchmark.run_finished` entry's meta. */
export const benchmarkRunFinishedMetaSchema = z.object({
  status: z.enum(BENCHMARK_RUN_STATUSES),
  failure: benchmarkCodeSchema.nullable(),
  resultCount: count,
  skippedCount: count,
  headline: benchmarkHeadlineSchema,
  label: z.enum(LABELS),
});

export type BenchmarkRunStartedMeta = z.infer<typeof benchmarkRunStartedMetaSchema>;
export type BenchmarkRunFinishedMeta = z.infer<typeof benchmarkRunFinishedMetaSchema>;

export interface BenchmarkError {
  status: 400 | 404 | 409;
  message: string;
}

/** Each S8 benchmark error code, its status and its plain message (D47's one error format adds a
 * reference ID). */
export const BENCHMARK_ERRORS = Object.freeze({
  /** Adding to or finishing a run that is finished or failed. */
  run_not_running: { status: 409, message: 'This benchmark run has already ended.' },
  /** A body that doesn't fit (S1's code). */
  validation_failed: { status: 400, message: 'The input is not valid.' },
  /** Another org's run, or a missing one. */
  not_found: { status: 404, message: 'The benchmark run was not found.' },
} as const satisfies Record<string, BenchmarkError>);

export type BenchmarkErrorCode = keyof typeof BENCHMARK_ERRORS;

export const BENCHMARK_ERROR_CODES = Object.freeze(Object.keys(BENCHMARK_ERRORS) as BenchmarkErrorCode[]);

export function isBenchmarkErrorCode(v: unknown): v is BenchmarkErrorCode {
  return typeof v === 'string' && Object.hasOwn(BENCHMARK_ERRORS, v);
}
