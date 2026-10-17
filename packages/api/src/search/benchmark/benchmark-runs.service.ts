// The benchmark runs (S8-002; D30, D45.3, D45.8, D47, D50, D51, D54, D56, D73, D163): the benchmark
// command stores a run in the org it measured, piece by piece, and the Benchmark screen reads it.
// - Who (D50, S8-Q1): only the org's Admins, people and Admin-role API keys, through the role
//   table's `admin` cell: `edit` to start, add results and finish, `view` to read. The routes check
//   it at the guard and this service checks it again (403). Every read and write runs in the
//   caller's own org context (`withOrgContext`), with the caller's org in the query too, and row
//   security on `benchmark_runs` and `benchmark_results` checks the org and the admin role again
//   (D45.3). Another org's run, a missing one or a malformed ID is 404 `not_found`.
// - Start: the run is saved `running`, labelled with the caller's clearance (D51), with its
//   settings: the start body plus the models, prompt versions, limits, cut-offs and injection checks
//   the API runs with (./benchmark-settings.ts, D45.8). `benchmark.run_started` is appended in the
//   same transaction (`AuditService.appendInTx`), with counts and the label only.
// - Add results: 1 to 25 items, only to a `running` run (409 `run_not_running` otherwise), each in
//   one of the run's parts and modes (400 `validation_failed` otherwise). Answers are cut to 4,000
//   characters (`storedBenchmarkItem`). An item that repeats one already stored (the table's unique
//   key: run, item key and mode), in an earlier batch or earlier in the same one, is ignored and
//   counted as a repeat. The run's last-activity time moves on. Not audited.
// - Finish: the summary is `summariseBenchmark` over the run's stored results, saved with the status
//   (`finished`, or `failed` with its code) and the finished time; `benchmark.run_finished` is
//   appended in the same transaction, with counts, the headline numbers per mode and the label,
//   never a question's or an answer's text. The run is locked while it ends, so no batch slips in
//   after its summary is computed. A run that isn't running is 409.
// - Read: the runs, paged, newest first (filters: status, part); one run with its summary; its
//   results, paged, in question order (the order a question's first item was stored) then mode
//   (filters: part, mode, kind, outcome). A reader whose clearance is below the run's label sees its
//   row and summary, with `hidden: true` instead of the settings, and `hidden: true` with no items
//   on its results.
// - Logs (D163): IDs, counts and codes only, never a question, an answer, a name or a setting.
import {
  BENCHMARK_AUDIT_ACTIONS,
  BENCHMARK_ERRORS,
  BENCHMARK_ITEM_KINDS,
  BENCHMARK_MODES,
  BENCHMARK_OUTCOMES,
  BENCHMARK_PARTS,
  BENCHMARK_RUN_STATUSES,
  BENCHMARK_RUN_TARGET_TYPE,
  addBenchmarkResultsBodySchema,
  benchmarkHeadline,
  can,
  finishBenchmarkRunBodySchema,
  isExtractionLinkState,
  isGraphFallbackReason,
  isVisible,
  startBenchmarkRunBodySchema,
  storedBenchmarkItem,
  summariseBenchmark,
  type BenchmarkErrorCode,
  type BenchmarkResultItem,
  type BenchmarkResultRow,
  type BenchmarkResultsAdded,
  type BenchmarkResultsPage,
  type BenchmarkRunDetail,
  type BenchmarkRunFinishedMeta,
  type BenchmarkRunRow,
  type BenchmarkRunStartedMeta,
  type BenchmarkRunsPage,
  type SummarisableItem,
} from '@grc/shared';
import { and, arrayContains, asc, count, desc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import { pageQuerySchema } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member, user } from '../../identity/schema.js';
import type { Caller } from '../../records/records.service.js';
import { runSettings, type ApiRunSettings } from './benchmark-settings.js';
import { benchmarkResults, benchmarkRuns, type BenchmarkRunDbRow } from './benchmark.schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The principal user ID of an API key: `api_key:<key ID>` (D54). */
const KEY_PRINCIPAL_PREFIX = 'api_key:';

/** `GET /api/v1/benchmark/runs`: paging, and the status and part filters. */
export const benchmarkRunListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  status: z.enum(BENCHMARK_RUN_STATUSES).optional(),
  /** Runs that measured this part. */
  part: z.enum(BENCHMARK_PARTS).optional(),
});

/** `GET /api/v1/benchmark/runs/:id/results`: paging, and the part, mode, kind and outcome filters. */
export const benchmarkResultListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  part: z.enum(BENCHMARK_PARTS).optional(),
  mode: z.enum(BENCHMARK_MODES).optional(),
  kind: z.enum(BENCHMARK_ITEM_KINDS).optional(),
  outcome: z.enum(BENCHMARK_OUTCOMES).optional(),
});

export type BenchmarkRunListQuery = z.infer<typeof benchmarkRunListQuerySchema>;
export type BenchmarkResultListQuery = z.infer<typeof benchmarkResultListQuerySchema>;

const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You do not have permission to do this.');

function benchmarkError(code: BenchmarkErrorCode): ApiError {
  const e = BENCHMARK_ERRORS[code];
  return new ApiError(e.status, code, e.message);
}

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

function actorOf(caller: Caller): { actorType: 'user' | 'api_key'; actorId: string } {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The run's ID in lowercase, or 404 for anything that isn't a UUID (nothing can match it). */
function runIdOf(id: unknown): string {
  if (typeof id !== 'string') throw benchmarkError('not_found');
  const lower = id.toLowerCase();
  if (!UUID.test(lower)) throw benchmarkError('not_found');
  return lower;
}

function unique<T>(values: Iterable<T | null | undefined>): T[] {
  const out = new Set<T>();
  for (const v of values) if (v !== null && v !== undefined) out.add(v);
  return [...out];
}

// `ARRAY['a', 'b', …]::text[]` from a fixed list of lowercase names (never from a request).
function textArray(values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`benchmark: unexpected list value '${v}'`);
  }
  return sql.raw(`ARRAY[${values.map((v) => `'${v}'`).join(', ')}]::text[]`);
}

// A run's stored results, counted. Written with explicit table names: in a one-table select Drizzle
// leaves column names unqualified, which inside a subquery would name the subquery's own table. Row
// security on benchmark_results applies to it too.
const RESULT_COUNT =
  sql<number>`(SELECT count(*) FROM "benchmark_results" AS "r" WHERE "r"."org_id" = "benchmark_runs"."org_id" AND "r"."run_id" = "benchmark_runs"."id")`.mapWith(
    Number,
  );

// Question order: where the item's question (its item key) was first stored in the run.
const QUESTION_ORDER = sql`(SELECT min("q"."id") FROM "benchmark_results" AS "q" WHERE "q"."org_id" = "benchmark_results"."org_id" AND "q"."run_id" = "benchmark_results"."run_id" AND "q"."item_key" = "benchmark_results"."item_key")`;
// Then the mode, and the part, in their fixed orders; then the stored order.
const MODE_ORDER = sql`array_position(${textArray(BENCHMARK_MODES)}, ${benchmarkResults.mode})`;
const PART_ORDER = sql`array_position(${textArray(BENCHMARK_PARTS)}, ${benchmarkResults.part})`;

type RunWithCount = BenchmarkRunDbRow & { resultCount: number };

export interface BenchmarkRunsServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  /** The models, prompt versions, limits, cut-offs and injection checks the API runs with. */
  settings: ApiRunSettings;
  log?: Logger;
}

export class BenchmarkRunsService {
  private readonly db: Db;
  private readonly audit: Pick<AuditService, 'appendInTx'>;
  private readonly settings: ApiRunSettings;
  private readonly log: Logger;

  constructor(deps: BenchmarkRunsServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.settings = deps.settings;
    this.log = deps.log ?? createLogger().child({ context: 'BenchmarkRunsService' });
  }

  /** `POST /api/v1/benchmark/runs`: a new `running` run, labelled with the caller's clearance. */
  async start(caller: Caller, body: unknown): Promise<BenchmarkRunDetail> {
    this.allow(caller, 'edit');
    const input = startBenchmarkRunBodySchema.parse(body ?? {});
    const settings = runSettings(input, this.settings);

    const started = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [run] = await tx
        .insert(benchmarkRuns)
        .values({
          orgId: caller.orgId,
          startedBy: caller.userId,
          status: 'running',
          parts: input.parts,
          modes: input.modes,
          settings,
          label: caller.clearance,
        })
        .returning();
      if (!run) throw new Error('benchmark: the run was not saved');
      const meta: BenchmarkRunStartedMeta = {
        parts: run.parts,
        modes: run.modes,
        questionCount: input.questionCount,
        questionSetSource: input.questionSet.source.type,
        label: run.label,
      };
      await this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...actorOf(caller),
        action: BENCHMARK_AUDIT_ACTIONS.runStarted,
        targetType: BENCHMARK_RUN_TARGET_TYPE,
        targetId: run.id,
        meta,
      });
      const people = await this.people(tx, caller, [run.startedBy]);
      return { run: { ...run, resultCount: 0 }, people };
    });

    this.log.info(
      { orgId: caller.orgId, runId: started.run.id, parts: input.parts.length, questionCount: input.questionCount },
      'benchmark run started',
    );
    return this.detail(caller, started.run, started.people);
  }

  /** `POST /api/v1/benchmark/runs/:id/results`: stores a batch; repeats are ignored and counted. */
  async addResults(caller: Caller, id: string, body: unknown): Promise<BenchmarkResultsAdded> {
    this.allow(caller, 'edit');
    const runId = runIdOf(id);
    const input = addBenchmarkResultsBodySchema.parse(body ?? {});
    const items = input.items.map(storedBenchmarkItem);

    const added = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      // Only a running run of the caller's org; the update locks it until the batch is in, so a
      // finish waits for the batch (and a batch after a finish finds the run ended).
      const [run] = await tx
        .update(benchmarkRuns)
        .set({ lastActivityAt: sql`now()` })
        .where(
          and(eq(benchmarkRuns.orgId, caller.orgId), eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, 'running')),
        )
        .returning({ parts: benchmarkRuns.parts, modes: benchmarkRuns.modes });
      if (!run) throw await this.notRunning(tx, caller, runId);
      checkItemsFit(items, run);

      const stored = await tx
        .insert(benchmarkResults)
        .values(
          items.map((item) => ({
            orgId: caller.orgId,
            runId,
            itemKey: item.itemKey,
            part: item.part,
            mode: item.mode,
            kind: item.kind,
            outcome: item.outcome,
            metrics: item.metrics,
            details: item.details,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: benchmarkResults.id });
      return { stored: stored.length, repeats: items.length - stored.length };
    });

    this.log.info(
      { orgId: caller.orgId, runId, stored: added.stored, repeats: added.repeats },
      'benchmark results added',
    );
    return added;
  }

  /** `POST /api/v1/benchmark/runs/:id/finish`: ends a running run with its summary. */
  async finish(caller: Caller, id: string, body: unknown): Promise<BenchmarkRunDetail> {
    this.allow(caller, 'edit');
    const runId = runIdOf(id);
    const input = finishBenchmarkRunBodySchema.parse(body ?? {});
    const failure = input.outcome === 'failed' ? (input.failure ?? null) : null;

    const ended = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [run] = await tx
        .select()
        .from(benchmarkRuns)
        .where(and(eq(benchmarkRuns.orgId, caller.orgId), eq(benchmarkRuns.id, runId)))
        .limit(1)
        .for('update');
      if (!run) throw benchmarkError('not_found');
      if (run.status !== 'running') throw benchmarkError('run_not_running');

      const items = await this.summarisable(tx, caller, runId);
      const summary = summariseBenchmark(items);
      const [updated] = await tx
        .update(benchmarkRuns)
        .set({
          status: input.outcome,
          summary,
          failureCode: failure,
          finishedAt: sql`now()`,
          lastActivityAt: sql`now()`,
        })
        .where(and(eq(benchmarkRuns.orgId, caller.orgId), eq(benchmarkRuns.id, runId)))
        .returning();
      if (!updated) throw new Error('benchmark: the run was not ended');

      const meta: BenchmarkRunFinishedMeta = {
        status: updated.status,
        failure: updated.failureCode,
        resultCount: items.length,
        skippedCount: items.filter((item) => item.outcome === 'skipped').length,
        headline: benchmarkHeadline(summary),
        label: updated.label,
      };
      await this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...actorOf(caller),
        action: BENCHMARK_AUDIT_ACTIONS.runFinished,
        targetType: BENCHMARK_RUN_TARGET_TYPE,
        targetId: updated.id,
        meta,
      });
      const people = await this.people(tx, caller, [updated.startedBy]);
      return { run: { ...updated, resultCount: items.length }, people };
    });

    this.log.info(
      {
        orgId: caller.orgId,
        runId,
        status: ended.run.status,
        failure: ended.run.failureCode,
        resultCount: ended.run.resultCount,
      },
      'benchmark run ended',
    );
    return this.detail(caller, ended.run, ended.people);
  }

  /** `GET /api/v1/benchmark/runs`: the org's runs, newest first. */
  async list(caller: Caller, query: unknown): Promise<BenchmarkRunsPage> {
    this.allow(caller, 'view');
    const q = benchmarkRunListQuerySchema.parse(query ?? {});
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const where = and(
        eq(benchmarkRuns.orgId, caller.orgId),
        q.status !== undefined ? eq(benchmarkRuns.status, q.status) : undefined,
        q.part !== undefined ? arrayContains(benchmarkRuns.parts, [q.part]) : undefined,
      );
      const [counted] = await tx.select({ total: count() }).from(benchmarkRuns).where(where);
      const runs = await tx
        .select({ ...getTableColumns(benchmarkRuns), resultCount: RESULT_COUNT })
        .from(benchmarkRuns)
        .where(where)
        .orderBy(desc(benchmarkRuns.startedAt), desc(benchmarkRuns.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const people = await this.people(
        tx,
        caller,
        runs.map((run) => run.startedBy),
      );
      return {
        items: runs.map((run) => runRow(run, people)),
        page: q.page,
        pageSize: q.pageSize,
        total: Number(counted?.total ?? 0),
      };
    });
  }

  /** `GET /api/v1/benchmark/runs/:id`: one run with its summary; its settings only at or above its label. */
  async get(caller: Caller, id: string): Promise<BenchmarkRunDetail> {
    this.allow(caller, 'view');
    const runId = runIdOf(id);
    const found = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [run] = await tx
        .select({ ...getTableColumns(benchmarkRuns), resultCount: RESULT_COUNT })
        .from(benchmarkRuns)
        .where(and(eq(benchmarkRuns.orgId, caller.orgId), eq(benchmarkRuns.id, runId)))
        .limit(1);
      if (!run) throw benchmarkError('not_found');
      return { run, people: await this.people(tx, caller, [run.startedBy]) };
    });
    return this.detail(caller, found.run, found.people);
  }

  /** `GET /api/v1/benchmark/runs/:id/results`: the run's results, in question order then mode. */
  async results(caller: Caller, id: string, query: unknown): Promise<BenchmarkResultsPage> {
    this.allow(caller, 'view');
    const runId = runIdOf(id);
    const q = benchmarkResultListQuerySchema.parse(query ?? {});
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [run] = await tx
        .select({ label: benchmarkRuns.label })
        .from(benchmarkRuns)
        .where(and(eq(benchmarkRuns.orgId, caller.orgId), eq(benchmarkRuns.id, runId)))
        .limit(1);
      if (!run) throw benchmarkError('not_found');
      if (!isVisible(caller.clearance, run.label)) {
        return { items: [], page: q.page, pageSize: q.pageSize, total: 0, hidden: true };
      }

      const where = and(
        eq(benchmarkResults.orgId, caller.orgId),
        eq(benchmarkResults.runId, runId),
        q.part !== undefined ? eq(benchmarkResults.part, q.part) : undefined,
        q.mode !== undefined ? eq(benchmarkResults.mode, q.mode) : undefined,
        q.kind !== undefined ? eq(benchmarkResults.kind, q.kind) : undefined,
        q.outcome !== undefined ? eq(benchmarkResults.outcome, q.outcome) : undefined,
      );
      const [counted] = await tx.select({ total: count() }).from(benchmarkResults).where(where);
      const rows = await tx
        .select({
          itemKey: benchmarkResults.itemKey,
          part: benchmarkResults.part,
          mode: benchmarkResults.mode,
          kind: benchmarkResults.kind,
          outcome: benchmarkResults.outcome,
          metrics: benchmarkResults.metrics,
          details: benchmarkResults.details,
          createdAt: benchmarkResults.createdAt,
        })
        .from(benchmarkResults)
        .where(where)
        .orderBy(asc(QUESTION_ORDER), asc(MODE_ORDER), asc(PART_ORDER), asc(benchmarkResults.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return {
        items: rows.map(
          (r) =>
            ({
              itemKey: r.itemKey,
              part: r.part,
              mode: r.mode,
              kind: r.kind,
              outcome: r.outcome,
              metrics: r.metrics,
              details: r.details,
              createdAt: iso(r.createdAt),
            }) as BenchmarkResultRow,
        ),
        page: q.page,
        pageSize: q.pageSize,
        total: Number(counted?.total ?? 0),
        hidden: false,
      };
    });
  }

  // ---- Helpers ----------------------------------------------------------------------------------

  // The `admin` cell again (D45.3): the guard already checked it.
  private allow(caller: Caller, action: 'view' | 'edit'): void {
    if (!can(caller.role, 'admin', action)) throw FORBIDDEN();
  }

  // Why a run can't take results: ended (409) or not this org's or missing (404).
  private async notRunning(tx: Tx, caller: Caller, runId: string): Promise<ApiError> {
    const [run] = await tx
      .select({ status: benchmarkRuns.status })
      .from(benchmarkRuns)
      .where(and(eq(benchmarkRuns.orgId, caller.orgId), eq(benchmarkRuns.id, runId)))
      .limit(1);
    return run ? benchmarkError('run_not_running') : benchmarkError('not_found');
  }

  // What `summariseBenchmark` reads from each stored result: its part, mode, kind, outcome and
  // metrics, its graph fallback and its link state. Only those two fields of the details are read.
  private async summarisable(tx: Tx, caller: Caller, runId: string): Promise<SummarisableItem[]> {
    const rows = await tx
      .select({
        part: benchmarkResults.part,
        mode: benchmarkResults.mode,
        kind: benchmarkResults.kind,
        outcome: benchmarkResults.outcome,
        metrics: benchmarkResults.metrics,
        fallback: sql<string | null>`${benchmarkResults.details} -> 'graph' ->> 'fallback'`,
        state: sql<string | null>`${benchmarkResults.details} ->> 'state'`,
      })
      .from(benchmarkResults)
      .where(and(eq(benchmarkResults.orgId, caller.orgId), eq(benchmarkResults.runId, runId)))
      .orderBy(asc(benchmarkResults.id));
    return rows.map((r) => ({
      part: r.part,
      mode: r.mode,
      kind: r.kind,
      outcome: r.outcome,
      metrics: r.metrics ?? {},
      details: {
        graph: { fallback: isGraphFallbackReason(r.fallback) ? r.fallback : null },
        ...(isExtractionLinkState(r.state) ? { state: r.state } : {}),
      },
    }));
  }

  // A run's detail: the row and summary for everyone with the `admin` cell, the settings only for a
  // reader at or above its label (D51).
  private detail(caller: Caller, run: RunWithCount, people: Map<string, string>): BenchmarkRunDetail {
    const row = runRow(run, people);
    const summary = run.summary ?? null;
    if (!isVisible(caller.clearance, run.label)) return { ...row, hidden: true, summary };
    return { ...row, hidden: false, settings: run.settings, summary };
  }

  // The display names of who started these runs: members of the caller's org by user ID, and the
  // org's API keys by `api_key:<id>`.
  private async people(tx: Tx, caller: Caller, startedBy: readonly string[]): Promise<Map<string, string>> {
    const ids = unique(startedBy);
    const out = new Map<string, string>();
    const userIds = ids.filter((id) => !id.startsWith(KEY_PRINCIPAL_PREFIX));
    const keyIds = ids
      .filter((id) => id.startsWith(KEY_PRINCIPAL_PREFIX))
      .map((id) => id.slice(KEY_PRINCIPAL_PREFIX.length))
      .filter((id) => UUID.test(id));
    if (userIds.length > 0) {
      const rows = await tx
        .select({ id: user.id, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, caller.orgId), inArray(user.id, userIds)));
      for (const r of rows) out.set(r.id, r.name);
    }
    if (keyIds.length > 0) {
      const rows = await tx
        .select({ id: apiKeys.id, name: apiKeys.name })
        .from(apiKeys)
        .where(and(eq(apiKeys.orgId, caller.orgId), inArray(apiKeys.id, keyIds)));
      for (const r of rows) out.set(`${KEY_PRINCIPAL_PREFIX}${r.id}`, r.name);
    }
    return out;
  }
}

/** A run as a list row. */
function runRow(run: RunWithCount, people: Map<string, string>): BenchmarkRunRow {
  return {
    id: run.id,
    startedAt: iso(run.startedAt),
    finishedAt: run.finishedAt !== null ? iso(run.finishedAt) : null,
    lastActivityAt: iso(run.lastActivityAt),
    status: run.status,
    failure: run.failureCode,
    parts: run.parts,
    modes: run.modes,
    dataVersion: run.settings.questionSet.source,
    questionCount: run.settings.questionCount,
    resultCount: Number.isFinite(run.resultCount) ? run.resultCount : 0,
    headline: benchmarkHeadline(run.summary),
    label: run.label,
    startedBy: { id: run.startedBy, name: people.get(run.startedBy) ?? null },
  };
}

/** Every item in one of the run's parts and modes; anything else is 400 `validation_failed`. */
function checkItemsFit(items: readonly BenchmarkResultItem[], run: { parts: string[]; modes: string[] }): void {
  const misfits = items.flatMap((item, i) =>
    run.parts.includes(item.part) && run.modes.includes(item.mode)
      ? []
      : [`items.${i}: this run does not measure part ${item.part} in mode ${item.mode}`],
  );
  if (misfits.length > 0) {
    throw new ApiError(BENCHMARK_ERRORS.validation_failed.status, 'validation_failed', misfits.join('; '));
  }
}
