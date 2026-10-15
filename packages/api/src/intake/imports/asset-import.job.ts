// The asset import run (S3-007, D26, D37, D40, D44, D45.4, D45.5, D48, D51, D68, D72, D213 (5)):
// the `INTAKE_QUEUES.assetImport` handler. It runs in the worker program only (D36), one import at
// a time, under the intake system context in Postgres (planner's reading R10) and as `grc_writer`
// in the org's own Neo4j database. For one queued import it:
//   1. reads the stored file again from the org's bucket, in the file sandbox, every row this time;
//   2. looks up the owners' emails among the org's members, the push batch that brought the file
//      (if any), and the assets the file names by its source's aliases;
//   3. plans the rows (`import-plan.ts`): create, update (changed fields only), unchanged, links,
//      and the row problems;
//   4. writes the rows in batches of 200, each batch in one Neo4j transaction with one audit entry
//      per change (`AuditOutbox.withAuditedWrites`): it locks the asset counter, reads the batch's
//      assets again with a write lock, decides each row again against them, takes the new numbers
//      in one go, then creates and updates. A batch that fails keeps none of its changes or entries;
//   5. draws the HOSTS and RUNS links in batches of 200 the same way (MERGE: an existing link is
//      left alone, a new one is `link.created`);
//   6. ends the import `done` with its counts and at most 200 row problems, with the
//      `import.finished` entry in the same Postgres transaction.
// Every asset it creates or changes and every link it adds stores `importId`; every entry it writes
// carries `meta.importId`, and `meta.pushBatchId` when a push batch brought the file (D213 (5)).
// Re-running the same file writes nothing (all rows unchanged, links already there), and a job
// retried after a crash part-way plans again from what the graph holds, so it adds no duplicates.
// A file that can't be read, a mapping that doesn't fit, or a runner who may no longer import end
// the import `failed` with that code. Anything else (the file store, Postgres, Neo4j) also marks it
// `failed` (`import_failed`) and throws, so pg-boss retries the same job (D72), which picks up from
// what the graph holds. Log lines hold only codes, counts and IDs, never a cell value, a column
// name, a file name or an email (D163, D164).
import { randomUUID } from 'node:crypto';
import type { OnApplicationBootstrap } from '@nestjs/common';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { canImportAssets, isLabel, LABELS, type ImportMapping, type Label } from '@grc/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuditOutbox, OutboxAudit } from '../../audit/outbox.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member, user } from '../../identity/schema.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import { linkTargetId } from '../../records/links.service.js';
import { NUMBER_CLASH_ATTEMPTS, isNumberClash } from '../../records/record-numbers.js';
import type { FileStore } from '../../storage/file-store.js';
import {
  MAX_IMPORT_ERRORS,
  documents,
  imports,
  pushBatches,
  type DocumentRow,
  type ImportCounts,
  type ImportRow,
  type ImportRowError,
} from '../intake.schema.js';
import { INTAKE_QUEUES, INTAKE_SYSTEM_CONTEXT } from '../queues.js';
import { ASSET_LIST_LIMITS, sandboxedTableReader, type TableReader } from './asset-list-reader.job.js';
import { SandboxError } from './file-sandbox.js';
import type { FlatValue } from './flat-json.js';
import {
  aliasesNamed,
  decideRow,
  ownerEmailsNamed,
  planImport,
  type ImportRowProblem,
  type ImportRunner,
  type PlannedCreate,
  type PlannedLink,
  type PlannedUpdate,
  type RowCandidate,
  type StoredAsset,
} from './import-plan.js';
import { lockAssetCounter, takeAssetNumbers } from './import-numbers.js';
import { assetImportJobSchema, runnerActor, type AssetImportJobData, type ImportRunnerRef } from './import-run.js';

/** Rows (and links) written per Neo4j transaction. */
export const ASSET_IMPORT_BATCH_SIZE = 200;

/** One import runs at a time in the worker. */
export const ASSET_IMPORT_CONCURRENCY = 1;

/** The codes an import fails with. */
export const ASSET_IMPORT_FAIL_CODES = [
  'mapping_missing',
  'mapping_mismatch',
  'not_allowed',
  'file_unreadable',
  'too_many_rows',
  'too_many_columns',
  'malformed',
  'timed_out',
  'too_much_memory',
  'import_failed',
] as const;
export type AssetImportFailCode = (typeof ASSET_IMPORT_FAIL_CODES)[number];

/** What one run did. `skipped`: nothing to do (bad job data, no such import, or not this job's run). */
export type AssetImportOutcome =
  | { status: 'done'; importId: string; counts: ImportCounts; errorCount: number }
  | { status: 'failed'; importId: string; code: AssetImportFailCode }
  | { status: 'skipped'; importId?: string; reason: 'bad_job_data' | 'import_not_found' | 'not_this_run' };

export interface AssetImportDeps {
  db: Db;
  graph: Pick<GraphService, 'read'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'get'>;
  readTable?: TableReader;
  log?: Logger;
  /** Rows (and links) per Neo4j transaction; 200 by default. */
  batchSize?: number;
  /** Called after each row batch commits (its number from 1); tests use it to stop part-way. */
  afterBatch?: (batch: number) => Promise<void> | void;
}

/** A run that can't go on, with its code; the import ends `failed` and the job isn't retried. */
class ImportStopped extends Error {
  constructor(readonly code: AssetImportFailCode) {
    super(`The import stopped (${code}).`);
    this.name = 'ImportStopped';
  }
}

const STORED_FIELDS = `n {.id, .number, .sourceIds, .name, .assetType, .criticality, .dataClassification,
  .sensitivity, .owner, .version, .status, .importId} AS a`;

function toStored(a: Record<string, unknown>): StoredAsset {
  return {
    id: a['id'] as string,
    number: a['number'] as string,
    sourceIds: Array.isArray(a['sourceIds']) ? (a['sourceIds'] as string[]) : [],
    name: (a['name'] as string | null) ?? '',
    assetType: (a['assetType'] as string | null) ?? null,
    criticality: (a['criticality'] as string | null) ?? null,
    dataClassification: (a['dataClassification'] as string | null) ?? null,
    sensitivity: (a['sensitivity'] as string | null) ?? 'restricted',
    owner: (a['owner'] as string | null) ?? '',
    version: Number(a['version'] ?? 1),
    status: (a['status'] as string | null) ?? 'active',
    importId: (a['importId'] as string | null) ?? null,
  };
}

/** Keyed by every alias of the source the asset carries (the first asset wins a clash). */
function byAlias(rows: StoredAsset[], prefix: string): Map<string, StoredAsset> {
  const map = new Map<string, StoredAsset>();
  for (const asset of rows) {
    for (const alias of asset.sourceIds) {
      if (alias.startsWith(prefix) && !map.has(alias)) map.set(alias, asset);
    }
  }
  return map;
}

/** Every asset carrying an alias of `source`, by alias. */
async function readStoredBySource(
  graph: AssetImportDeps['graph'],
  orgId: string,
  source: string,
): Promise<Map<string, StoredAsset>> {
  const prefix = `${source}:`;
  const rows = await graph.read(orgId, async (tx) => {
    const res = await tx.run(
      `MATCH (n:Asset) WHERE any(s IN n.sourceIds WHERE s STARTS WITH $prefix) RETURN ${STORED_FIELDS}`,
      { prefix },
    );
    return res.records.map((r) => toStored(r.get('a') as Record<string, unknown>));
  });
  return byAlias(rows, prefix);
}

/** The assets carrying any of `aliases`, write-locked for the rest of the transaction. */
async function readStoredLocked(
  tx: ManagedTransaction,
  aliases: string[],
  prefix: string,
): Promise<Map<string, StoredAsset>> {
  if (aliases.length === 0) return new Map();
  const res = await tx.run(
    `MATCH (n:Asset) WHERE any(s IN n.sourceIds WHERE s IN $aliases)
     SET n.__lock = true REMOVE n.__lock
     RETURN ${STORED_FIELDS}`,
    { aliases },
  );
  return byAlias(
    res.records.map((r) => toStored(r.get('a') as Record<string, unknown>)),
    prefix,
  );
}

/** Integers go to Neo4j as integers, not floats. */
function int(n: number): ReturnType<typeof neo4j.int> {
  return neo4j.int(n);
}

function higher(a: string, b: string): Label {
  const l = LABELS.indexOf(a as Label) >= LABELS.indexOf(b as Label) ? a : b;
  return isLabel(l) ? l : 'restricted';
}

interface RunContext {
  orgId: string;
  importId: string;
  source: string;
  runner: ImportRunnerRef;
  planRunner: ImportRunner;
  pushBatchId: string | null;
  now: () => string;
}

function metaOf(ctx: RunContext, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, importId: ctx.importId, ...(ctx.pushBatchId !== null ? { pushBatchId: ctx.pushBatchId } : {}) };
}

interface BatchResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Rows that turned out to be refused when decided again inside the batch. */
  refused: ImportRowProblem[];
  refusedRows: number[];
}

/** Writes one batch of read rows in one transaction, with its audit entries. */
async function writeRowBatch(deps: AssetImportDeps, ctx: RunContext, batch: RowCandidate[]): Promise<BatchResult> {
  const prefix = `${ctx.source}:`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.outbox.withAuditedWrites(ctx.orgId, runnerActor(ctx.runner), async (tx) => {
        await lockAssetCounter(tx);
        const fresh = await readStoredLocked(
          tx,
          batch.map((c) => c.alias),
          prefix,
        );
        const creates: PlannedCreate[] = [];
        const updates: PlannedUpdate[] = [];
        const result: BatchResult = { added: 0, updated: 0, unchanged: 0, refused: [], refusedRows: [] };
        const order: Array<{ kind: 'create'; i: number } | { kind: 'update'; i: number }> = [];
        for (const candidate of batch) {
          const decision = decideRow(candidate, fresh.get(candidate.alias), ctx.planRunner);
          if (decision.kind === 'create') {
            order.push({ kind: 'create', i: creates.length });
            creates.push(decision.create);
          } else if (decision.kind === 'update') {
            order.push({ kind: 'update', i: updates.length });
            updates.push(decision.update);
          } else if (decision.kind === 'unchanged') {
            result.unchanged += 1;
          } else {
            result.refused.push(...decision.errors);
            result.refusedRows.push(candidate.row);
          }
        }

        const numbers = await takeAssetNumbers(tx, creates.length);
        const now = ctx.now();
        const userId = ctx.runner.userId;
        const created = creates.map((c, i) => ({
          id: randomUUID(),
          number: numbers[i]!,
          sourceIds: [c.alias],
          name: c.values.name,
          assetType: c.values.assetType,
          criticality: c.values.criticality,
          dataClassification: c.values.dataClassification,
          sensitivity: c.values.sensitivity,
          status: 'active',
          owner: c.values.owner,
          version: int(1),
          createdAt: now,
          createdBy: userId,
          updatedAt: now,
          updatedBy: userId,
          origin: 'import',
          importId: ctx.importId,
        }));
        if (created.length > 0) {
          await tx.run('UNWIND $rows AS row CREATE (n:Asset) SET n = row', { rows: created });
        }
        if (updates.length > 0) {
          const rows = updates.map((u) => ({
            id: u.stored.id,
            props: {
              ...u.changes,
              version: int(u.stored.version + 1),
              updatedAt: now,
              updatedBy: userId,
              importId: ctx.importId,
            },
          }));
          await tx.run('UNWIND $rows AS row MATCH (n:Asset {id: row.id}) SET n += row.props', { rows });
        }

        const audits: OutboxAudit[] = order.map((o) => {
          if (o.kind === 'create') {
            const c = creates[o.i]!;
            const node = created[o.i]!;
            return {
              action: 'record.created',
              targetType: 'asset',
              targetId: node.id,
              before: null,
              after: {
                name: c.values.name,
                assetType: c.values.assetType,
                criticality: c.values.criticality,
                dataClassification: c.values.dataClassification,
                label: c.values.sensitivity,
                owner: c.values.owner,
                status: 'active',
                sourceIds: [c.alias],
                origin: 'import',
              },
              meta: metaOf(ctx, { number: node.number, label: c.values.sensitivity }),
            };
          }
          const u = updates[o.i]!;
          return {
            action: 'record.updated',
            targetType: 'asset',
            targetId: u.stored.id,
            before: u.before,
            after: u.after,
            meta: metaOf(ctx, { number: u.stored.number, label: u.label }),
          };
        });
        result.added = creates.length;
        result.updated = updates.length;
        return { result, audits };
      });
    } catch (err) {
      if (isNumberClash(err) && attempt < NUMBER_CLASH_ATTEMPTS) continue;
      throw err;
    }
  }
}

interface ResolvedLink {
  link: PlannedLink;
  parentId: string;
  childId: string;
}

/** Draws one batch of HOSTS and RUNS links in one transaction; answers how many were new. */
async function writeLinkBatch(deps: AssetImportDeps, ctx: RunContext, batch: ResolvedLink[]): Promise<number> {
  return deps.outbox.withAuditedWrites(ctx.orgId, runnerActor(ctx.runner), async (tx) => {
    const audits: OutboxAudit[] = [];
    let added = 0;
    const now = ctx.now();
    for (const type of ['HOSTS', 'RUNS'] as const) {
      const links = batch
        .map((l, i) => ({ i, parentId: l.parentId, childId: l.childId, type: l.link.type }))
        .filter((l) => l.type === type);
      if (links.length === 0) continue;
      const token = randomUUID();
      const res = await tx.run(
        `UNWIND $links AS l
         MATCH (p:Asset {id: l.parentId})
         MATCH (c:Asset {id: l.childId})
         MERGE (p)-[r:${type}]->(c)
         ON CREATE SET r.createdAt = $now, r.createdBy = $userId, r.origin = 'import', r.importId = $importId,
                       r.__created = $token
         WITH l, p, c, r, coalesce(r.__created = $token, false) AS created
         REMOVE r.__created
         RETURN l.i AS i, created, p.number AS fromNumber, p.sensitivity AS fromLabel,
                c.number AS toNumber, c.sensitivity AS toLabel`,
        { links, now, userId: ctx.runner.userId, importId: ctx.importId, token },
      );
      for (const record of res.records) {
        if (record.get('created') !== true) continue;
        const l = batch[Number(record.get('i'))]!;
        added += 1;
        audits.push({
          action: 'link.created',
          targetType: 'link',
          targetId: linkTargetId(type, l.parentId, l.childId),
          before: null,
          after: {
            type,
            fromId: l.parentId,
            toId: l.childId,
            origin: 'import',
            createdAt: now,
            createdBy: ctx.runner.userId,
          },
          meta: metaOf(ctx, {
            type,
            fromNumber: record.get('fromNumber') as string,
            toNumber: record.get('toNumber') as string,
            label: higher(String(record.get('fromLabel')), String(record.get('toLabel'))),
          }),
        });
      }
    }
    return { result: added, audits };
  });
}

/** Org members by lowercase email. */
async function ownersByEmail(tx: Tx, orgId: string, emails: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 1000) {
    const chunk = emails.slice(i, i + 1000);
    const rows = await tx
      .select({ userId: member.userId, email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, orgId), inArray(sql`lower(${user.email})`, chunk)));
    for (const r of rows) owners.set(r.email.toLowerCase(), r.userId);
  }
  return owners;
}

/** The owner of new assets with no known owner: the person who ran it, or the person behind the key. */
async function fallbackOwner(tx: Tx, orgId: string, runner: ImportRunnerRef): Promise<string | null> {
  if (runner.apiKeyId === undefined) return runner.userId;
  const [row] = await tx
    .select({ createdBy: apiKeys.createdBy })
    .from(apiKeys)
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, runner.apiKeyId)))
    .limit(1);
  return row?.createdBy ?? null;
}

function mappingFits(mapping: ImportMapping['fields'], columns: readonly string[] | null): boolean {
  if (columns === null) return false;
  return Object.values(mapping).every((c) => typeof c !== 'string' || columns.includes(c));
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One run of the job. Throws only for what a retry may fix (the file store, Postgres, Neo4j). */
export async function runAssetImport(
  deps: AssetImportDeps,
  job: { id: string; data: unknown },
): Promise<AssetImportOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'AssetImport' });
  const parsed = assetImportJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.warn({ jobId: job.id, code: 'bad_job_data' }, 'an asset import job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const data: AssetImportJobData = parsed.data;
  const sys = INTAKE_SYSTEM_CONTEXT(data.orgId);

  // Take the run: only this job's run of a queued (or retried) import.
  const taken = await withOrgContext(deps.db, sys, async (tx) => {
    const [row] = await tx
      .select({ imp: imports, doc: documents })
      .from(imports)
      .innerJoin(documents, and(eq(documents.orgId, imports.orgId), eq(documents.id, imports.documentId)))
      .where(and(eq(imports.orgId, data.orgId), eq(imports.id, data.importId)))
      .for('update', { of: imports })
      .limit(1);
    if (!row) return { found: false as const };
    const { imp } = row;
    if (imp.jobId !== job.id || !['queued', 'importing', 'failed'].includes(imp.status)) {
      return { found: true as const, mine: false as const, imp };
    }
    await tx
      .update(imports)
      .set({ status: 'importing', updatedAt: new Date() })
      .where(and(eq(imports.orgId, data.orgId), eq(imports.id, imp.id)));
    return { found: true as const, mine: true as const, imp, doc: row.doc };
  });
  const ids = { orgId: data.orgId, importId: data.importId, jobId: job.id };
  if (!taken.found) {
    log.warn({ ...ids, code: 'import_not_found' }, 'an asset import job named no import');
    return { status: 'skipped', reason: 'import_not_found' };
  }
  if (!taken.mine) return { status: 'skipped', importId: data.importId, reason: 'not_this_run' };

  try {
    const outcome = await importRows(deps, log, data, taken.imp, taken.doc);
    await finishDone(deps, data, job.id, outcome.counts, outcome.errors);
    log.info({ ...ids, ...outcome.counts, errorCount: outcome.errors.length }, 'an asset import finished');
    return { status: 'done', importId: data.importId, counts: outcome.counts, errorCount: outcome.errors.length };
  } catch (err) {
    const code: AssetImportFailCode = err instanceof ImportStopped ? err.code : 'import_failed';
    try {
      await finishFailed(deps, data, job.id, code);
    } catch (saveErr) {
      log.error({ ...ids, ...errorKind(saveErr) }, 'a failed asset import could not be marked failed');
    }
    if (err instanceof ImportStopped) {
      log.warn({ ...ids, code }, 'an asset import could not run');
      return { status: 'failed', importId: data.importId, code };
    }
    log.error({ ...ids, ...errorKind(err) }, 'an asset import broke; it will be retried');
    throw err;
  }
}

async function importRows(
  deps: AssetImportDeps,
  log: Logger,
  data: AssetImportJobData,
  imp: ImportRow,
  doc: DocumentRow,
): Promise<{ counts: ImportCounts; errors: ImportRowError[] }> {
  const mapping = imp.mapping;
  if (!mapping) throw new ImportStopped('mapping_missing');
  if (!mappingFits(mapping, imp.columns)) throw new ImportStopped('mapping_mismatch');
  if (!canImportAssets(data.runner.role)) throw new ImportStopped('not_allowed');
  if (doc.format !== 'csv' && doc.format !== 'json') throw new ImportStopped('file_unreadable');

  const ids = { orgId: data.orgId, importId: imp.id, documentId: doc.id };
  const bytes = await deps.files.get(data.orgId, doc.storageKey);
  const readTable =
    deps.readTable ?? sandboxedTableReader({ ...ASSET_LIST_LIMITS, keepRows: ASSET_LIST_LIMITS.maxRows });
  let rows: Array<Record<string, FlatValue>>;
  try {
    const table = await readTable(doc.format, bytes);
    rows = table.rows;
    if (table.rowCount !== rows.length) throw new ImportStopped('too_many_rows');
  } catch (err) {
    if (err instanceof ImportStopped) throw err;
    if (err instanceof SandboxError) {
      const known = (ASSET_IMPORT_FAIL_CODES as readonly string[]).includes(err.code);
      log.warn({ ...ids, code: err.code }, 'an asset list could not be read for its import');
      throw new ImportStopped(known ? (err.code as AssetImportFailCode) : 'file_unreadable');
    }
    throw err;
  }

  const sys = INTAKE_SYSTEM_CONTEXT(data.orgId);
  const lookups = await withOrgContext(deps.db, sys, async (tx) => {
    const owners = await ownersByEmail(tx, data.orgId, ownerEmailsNamed({ mapping, rows }));
    const ownerId = await fallbackOwner(tx, data.orgId, data.runner);
    const [batch] = await tx
      .select({ batchId: pushBatches.batchId })
      .from(pushBatches)
      .where(and(eq(pushBatches.orgId, data.orgId), eq(pushBatches.importId, imp.id)))
      .limit(1);
    return { owners, ownerId, pushBatchId: batch?.batchId ?? null };
  });
  if (lookups.ownerId === null) throw new ImportStopped('not_allowed');

  const ctx: RunContext = {
    orgId: data.orgId,
    importId: imp.id,
    source: imp.source,
    runner: data.runner,
    planRunner: { role: data.runner.role, clearance: data.runner.clearance, ownerId: lookups.ownerId },
    pushBatchId: lookups.pushBatchId,
    now: () => new Date().toISOString(),
  };

  // Plan the whole file against what the graph holds now (aliasesNamed lists what it may touch).
  const named = new Set(aliasesNamed({ source: imp.source, mapping, rows }));
  const storedAll = await readStoredBySource(deps.graph, data.orgId, imp.source);
  const stored = new Map([...storedAll].filter(([alias]) => named.has(alias)));
  const plan = planImport({
    source: imp.source,
    mapping,
    rows,
    stored,
    owners: lookups.owners,
    runner: ctx.planRunner,
  });

  const counts: ImportCounts = { added: 0, updated: 0, unchanged: 0, failed: plan.failed.length, linksAdded: 0 };
  const problems: ImportRowProblem[] = [...plan.errors];
  const refusedRows = new Set<number>();
  const size = deps.batchSize ?? ASSET_IMPORT_BATCH_SIZE;
  let batchNo = 0;
  for (const batch of chunks(plan.accepted, size)) {
    const result = await writeRowBatch(deps, ctx, batch);
    counts.added += result.added;
    counts.updated += result.updated;
    counts.unchanged += result.unchanged;
    counts.failed += result.refusedRows.length;
    problems.push(...result.refused);
    for (const row of result.refusedRows) refusedRows.add(row);
    batchNo += 1;
    if (deps.afterBatch) await deps.afterBatch(batchNo);
  }

  // The links of the rows imported, their ends found by alias in what the graph holds now.
  const links = plan.links.filter((l) => !refusedRows.has(l.row));
  if (links.length > 0) {
    const now = await readStoredBySource(deps.graph, data.orgId, imp.source);
    const resolved: ResolvedLink[] = [];
    const noted = new Set(problems.filter((p) => p.code === 'unknown_parent').map((p) => `${p.row}:${p.field ?? ''}`));
    for (const link of links) {
      const parent = now.get(link.parentAlias);
      const child = now.get(link.childAlias);
      if (parent && child) {
        // Two aliases of one asset never link it to itself.
        if (parent.id !== child.id) resolved.push({ link, parentId: parent.id, childId: child.id });
        continue;
      }
      const key = `${link.row}:${link.field}`;
      if (!noted.has(key)) {
        noted.add(key);
        problems.push({ row: link.row, field: link.field, code: 'unknown_parent' });
      }
    }
    for (const batch of chunks(resolved, size)) counts.linksAdded += await writeLinkBatch(deps, ctx, batch);
  }

  const errors: ImportRowError[] = problems
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.row - b.p.row || a.i - b.i)
    .slice(0, MAX_IMPORT_ERRORS)
    .map(({ p }) => ({ row: p.row, field: p.field, code: p.code }));
  return { counts, errors };
}

async function finishDone(
  deps: AssetImportDeps,
  data: AssetImportJobData,
  jobId: string,
  counts: ImportCounts,
  errors: ImportRowError[],
): Promise<void> {
  await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(data.orgId), async (tx) => {
    const updated = await tx
      .update(imports)
      .set({ status: 'done', counts, errors, updatedAt: new Date() })
      .where(and(eq(imports.orgId, data.orgId), eq(imports.id, data.importId), eq(imports.jobId, jobId)))
      .returning({ id: imports.id });
    if (updated.length === 0) return;
    await deps.audit.appendInTx(tx, {
      orgId: data.orgId,
      ...runnerActor(data.runner),
      action: 'import.finished',
      targetType: 'import',
      targetId: data.importId,
      after: { status: 'done' },
      meta: { ...counts },
    });
  });
}

async function finishFailed(
  deps: AssetImportDeps,
  data: AssetImportJobData,
  jobId: string,
  code: AssetImportFailCode,
): Promise<void> {
  await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(data.orgId), async (tx) => {
    const updated = await tx
      .update(imports)
      .set({ status: 'failed', errors: [{ row: 0, field: null, code }], updatedAt: new Date() })
      .where(and(eq(imports.orgId, data.orgId), eq(imports.id, data.importId), eq(imports.jobId, jobId)))
      .returning({ id: imports.id });
    if (updated.length === 0) return;
    await deps.audit.appendInTx(tx, {
      orgId: data.orgId,
      ...runnerActor(data.runner),
      action: 'import.finished',
      targetType: 'import',
      targetId: data.importId,
      after: { status: 'failed' },
      meta: { code },
    });
  });
}

/** Registers the run in the worker program only; the API program only queues it. */
export class AssetImportJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'AssetImport' });

  constructor(
    private readonly jobs: JobsService,
    private readonly deps: Omit<AssetImportDeps, 'log'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: AssetImportDeps = { ...this.deps, log: this.log };
    await this.jobs.work(
      INTAKE_QUEUES.assetImport,
      async (job) => {
        await runAssetImport(deps, job);
      },
      { concurrency: ASSET_IMPORT_CONCURRENCY },
    );
  }
}
