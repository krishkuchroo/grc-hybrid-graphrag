// The benchmark tables in Postgres (S8-001; D1, D45.8, D50, D51, D56, D57, D73), created by the
// benchmark migration. Both are org tables (M0-009 rule: `org_id uuid not null`, RLS enabled and
// forced) whose row security is narrower than the standard org wall: every read, insert and update
// needs the row's org to be the context org (`app.org_id`, never one seen through a grant or a
// parent link) and the context role (`app.role`) to be `admin`, the role table's `admin` cell (D50,
// S8-Q1). Another role of the same org, and another org's Admin, see none and add none.
//
// - `benchmark_runs`: one per run, in the org it ran against. `startedBy` is the starter's principal
//   user ID (an API key's is `api_key:<id>`); `settings` the start body plus what the API ran with
//   (S8-001's `BenchmarkRunSettings`, D45.8); `summary` is `summariseBenchmark` over its results,
//   null until it ends; `label` is the starter's clearance (D51). grc_app may insert, and change only
//   `status`, `summary`, `failureCode`, `finishedAt` and `lastActivityAt`; never delete.
// - `benchmark_results`: one per result item (S8-001's item shape). Unique on run + item key + mode,
//   so a repeated item adds nothing (insert with `onConflictDoNothing`). The foreign key covers
//   (org, run), so a result can only go into a run of the same org. `id` counts up in the order the
//   results were stored. grc_app may insert and read; never change or delete.
// Neither holds anything the logs may show beyond IDs, counts and codes (D163): the questions,
// answers and record names in `details` and `settings` are never logged.
import {
  BENCHMARK_LIMITS,
  BENCHMARK_MODES,
  BENCHMARK_OUTCOMES,
  BENCHMARK_PARTS,
  BENCHMARK_QUESTION_KINDS,
  BENCHMARK_QUESTION_MODES,
  BENCHMARK_QUESTION_PARTS,
  BENCHMARK_RUN_STATUSES,
  EXTRACTION_ITEM_KINDS,
  LABELS,
  type BenchmarkAnswersDetails,
  type BenchmarkExtractionDetails,
  type BenchmarkItemKind,
  type BenchmarkItemMetrics,
  type BenchmarkMode,
  type BenchmarkOutcome,
  type BenchmarkPart,
  type BenchmarkRetrievalDetails,
  type BenchmarkRunSettings,
  type BenchmarkRunStatus,
  type BenchmarkSummary,
  type Label,
} from '@grc/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organization } from '../../identity/schema.js';

/** Who started a run: a principal user ID of 1 to 200 characters. */
export const MAX_BENCHMARK_STARTED_BY_LENGTH = 200;

/** An item's details, by part (S8-001). */
export type BenchmarkResultDetails = BenchmarkRetrievalDetails | BenchmarkAnswersDetails | BenchmarkExtractionDetails;

// `'a', 'b', …` from a fixed list of lowercase names.
function names(values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`benchmark.schema: unexpected list value '${v}'`);
  }
  return values.map((v) => `'${v}'`).join(', ');
}

// `<column> IN ('a', 'b', …)` from a fixed list of lowercase names.
function inList(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(names(values))})`;
}

// `ARRAY['a', 'b', …]::text[]` from a fixed list of lowercase names.
function textArray(values: readonly string[]): SQL {
  return sql.raw(`ARRAY[${names(values)}]::text[]`);
}

// A text array of 1 to `values.length` entries, none null, each one of `values`.
function arrayOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`cardinality(${column}) BETWEEN 1 AND ${sql.raw(String(values.length))} AND array_position(${column}, NULL) IS NULL AND ${column} <@ ${textArray(values)}`;
}

function between(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`char_length(${column}) BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))}`;
}

const QUESTION_PARTS: readonly BenchmarkPart[] = BENCHMARK_QUESTION_PARTS;
const QUESTION_MODES: readonly BenchmarkMode[] = BENCHMARK_QUESTION_MODES;
const QUESTION_KINDS: readonly BenchmarkItemKind[] = BENCHMARK_QUESTION_KINDS;
const EXTRACTION_KINDS: readonly BenchmarkItemKind[] = EXTRACTION_ITEM_KINDS;

export const benchmarkRuns = pgTable(
  'benchmark_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    /** The starter's principal user ID (an API key's is `api_key:<id>`). */
    startedBy: text('started_by').notNull(),
    status: text('status').$type<BenchmarkRunStatus>().notNull().default('running'),
    parts: text('parts').array().$type<BenchmarkPart[]>().notNull(),
    modes: text('modes').array().$type<BenchmarkMode[]>().notNull(),
    /** The start body plus the models, prompt versions, limits, cut-offs and injection checks. */
    settings: jsonb('settings').$type<BenchmarkRunSettings>().notNull(),
    /** `summariseBenchmark` over the run's results; null until the run ends. */
    summary: jsonb('summary').$type<BenchmarkSummary>(),
    /** A failed run's short code; null otherwise. */
    failureCode: text('failure_code'),
    /** The starter's clearance (D51). */
    label: text('label').$type<Label>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it finished or failed; null while running. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Moves on with every batch of results. */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The target of the results' foreign key, so a result's org is its run's.
    unique('benchmark_runs_org_id_id_unique').on(t.orgId, t.id),
    index('benchmark_runs_org_started_idx').on(t.orgId, t.startedAt, t.id),
    index('benchmark_runs_org_status_started_idx').on(t.orgId, t.status, t.startedAt),
    check('benchmark_runs_started_by_check', between(t.startedBy, 1, MAX_BENCHMARK_STARTED_BY_LENGTH)),
    check('benchmark_runs_status_check', inList(t.status, BENCHMARK_RUN_STATUSES)),
    check('benchmark_runs_parts_check', arrayOf(t.parts, BENCHMARK_PARTS)),
    check('benchmark_runs_modes_check', arrayOf(t.modes, BENCHMARK_MODES)),
    check('benchmark_runs_settings_check', sql`jsonb_typeof(${t.settings}) = 'object'`),
    check(
      'benchmark_runs_summary_check',
      sql`${t.summary} IS NULL OR (jsonb_typeof(${t.summary}) = 'object' AND ${t.status} <> 'running')`,
    ),
    check(
      'benchmark_runs_failure_code_check',
      sql`(${t.failureCode} IS NULL) = (${t.status} <> 'failed') AND (${t.failureCode} IS NULL OR (${between(t.failureCode, 1, BENCHMARK_LIMITS.codeMaxLength)} AND ${t.failureCode} ~ '^[a-z][a-z0-9_]*$'))`,
    ),
    check('benchmark_runs_finished_at_check', sql`(${t.finishedAt} IS NULL) = (${t.status} = 'running')`),
    check('benchmark_runs_label_check', inList(t.label, LABELS)),
  ],
);

export const benchmarkResults = pgTable(
  'benchmark_results',
  {
    /** Counts up in the order results were stored. */
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    runId: uuid('run_id').notNull(),
    /** The question's ID, or the extraction item's key. */
    itemKey: text('item_key').notNull(),
    part: text('part').$type<BenchmarkPart>().notNull(),
    mode: text('mode').$type<BenchmarkMode>().notNull(),
    kind: text('kind').$type<BenchmarkItemKind>().notNull(),
    outcome: text('outcome').$type<BenchmarkOutcome>().notNull(),
    metrics: jsonb('metrics')
      .$type<BenchmarkItemMetrics>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The item's details, by part. Never logged (D163). */
    details: jsonb('details').$type<BenchmarkResultDetails>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The run must be the same org's (a foreign key check doesn't pass through RLS).
    foreignKey({
      name: 'benchmark_results_run_fk',
      columns: [t.orgId, t.runId],
      foreignColumns: [benchmarkRuns.orgId, benchmarkRuns.id],
    }),
    unique('benchmark_results_run_item_mode_unique').on(t.runId, t.itemKey, t.mode),
    index('benchmark_results_org_run_idx').on(t.orgId, t.runId, t.id),
    check(
      'benchmark_results_item_key_check',
      sql`${between(t.itemKey, 1, BENCHMARK_LIMITS.itemKeyMaxLength)} AND ${t.itemKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'`,
    ),
    check(
      'benchmark_results_part_mode_check',
      sql`(${inList(t.part, QUESTION_PARTS)} AND ${inList(t.mode, QUESTION_MODES)}) OR (${t.part} = 'extraction' AND ${t.mode} = 'pipeline')`,
    ),
    check(
      'benchmark_results_kind_check',
      sql`(${inList(t.part, QUESTION_PARTS)} AND ${inList(t.kind, QUESTION_KINDS)}) OR (${t.part} = 'extraction' AND ${inList(t.kind, EXTRACTION_KINDS)})`,
    ),
    check('benchmark_results_outcome_check', inList(t.outcome, BENCHMARK_OUTCOMES)),
    check('benchmark_results_metrics_check', sql`jsonb_typeof(${t.metrics}) = 'object'`),
    check('benchmark_results_details_check', sql`jsonb_typeof(${t.details}) = 'object'`),
  ],
);

export type BenchmarkRunDbRow = typeof benchmarkRuns.$inferSelect;
export type NewBenchmarkRunDbRow = typeof benchmarkRuns.$inferInsert;
export type BenchmarkResultDbRow = typeof benchmarkResults.$inferSelect;
export type NewBenchmarkResultDbRow = typeof benchmarkResults.$inferInsert;
