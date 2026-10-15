// The push API for machines (S3-008, D11, D18, D45.5, D47, D54, D56, D59, D64, D73, D163, D164,
// D213 (5); planner's reading R2: asset rows only, documents go through `POST /api/v1/uploads`).
//
// Pushing a batch (`push`), for an API key only (the controller's guard answers a person 403
// `api_key_required`; the service checks again):
// 1. The key's role must pass `canImportAssets` (403), then the body `pushBatchSchema` (400), and
//    the rows' columns (the union of their keys, first seen first, as the worker's flat JSON reader
//    reads them) must be non-blank and at most the reader's 200 (400).
// 2. A batch the org already has (the same `source` and `batchId`): 200 with the first answer and
//    `duplicate: true`. Nothing is stored, queued or imported again, even when the rows differ (D47).
// 3. The source needs a saved mapping (409 `mapping_required`), and every column it names must be
//    one of the rows' columns (400, naming our field, never the column).
// 4. The rows are written as a JSON asset list through `storeUpload` (kind `asset_list`, the key as
//    uploader, label `internal` unless the key's clearance is lower). For a new document, in the
//    same transaction as its row and its `document.uploaded` entry: the `push_batches` row (the
//    claim, ON CONFLICT DO NOTHING on the org, source and batch ID), the `push.received` entry
//    (`meta { source, batchId, rowCount }` only), the `imports` row (status `queued`, the saved
//    mapping, the rows' columns, row count and 5 sample rows) and the S3-007 run job
//    (`startImportRunInTx`, which appends `import.started`). 202 `{ batchId, importId, jobId,
//    duplicate: false }`.
// 5. Rows identical to an earlier batch's (the same content hash): `storeUpload` makes no second
//    document; the batch is recorded against the existing one (and its import), with its
//    `push.received` entry, and nothing is queued: 200 with `duplicate: true` and no job.
// Two requests with the same batch at the same moment give one batch: the second one's claim waits
// on the first's row, finds it, rolls its own work back, and answers the first answer (200).
//
// Listing batches (`list`), for people and keys with the `uploads` cell: the org's batches, newest
// first, paged, with `source` and `batchId` filters, each with its import's status and counts. A
// batch shows only when its document does: the role views the document's record type and its label
// is at or below the caller's clearance (checked here, and again by RLS on `documents`, D73).
// Log lines hold only codes and IDs, never a row value, a column name or a file name (D163, D164).
import {
  ASSET_IMPORT_FIELDS,
  DOCUMENT_RECORD_TYPE,
  IMPORT_STATUSES,
  LABELS,
  can,
  canImportAssets,
  isVisible,
  pushBatchSchema,
  type ImportMapping,
  type Label,
  type PushBatch,
} from '@grc/shared';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import { pageQuerySchema, type Paged } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import type { Caller } from '../../records/records.service.js';
import type { FileStore } from '../../storage/file-store.js';
import { ASSET_LIST_LIMITS } from '../imports/asset-list-reader.job.js';
import { startImportRunInTx } from '../imports/import-run.js';
import { runnerOf } from '../imports/run.service.js';
import {
  MAX_IMPORT_SAMPLE_ROWS,
  documents,
  importMappings,
  imports,
  pushBatches,
  type DocumentRow,
  type PushBatchRow,
} from '../intake.schema.js';
import { actorOf, storeUpload } from '../uploads/store-upload.js';

/** A push's answer: 202 for a new batch, 200 (`duplicate: true`) for one the org already had. */
export const pushAnswerSchema = z.object({
  batchId: z.string(),
  importId: z.string().nullable(),
  jobId: z.string().nullable(),
  duplicate: z.boolean(),
});
export type PushAnswer = z.infer<typeof pushAnswerSchema>;

export interface PushResult {
  status: 200 | 202;
  answer: PushAnswer;
}

const countsSchema = z.object({
  added: z.int(),
  updated: z.int(),
  unchanged: z.int(),
  failed: z.int(),
  linksAdded: z.int(),
});

/** One batch in `GET /api/v1/push/batches`. */
export const pushBatchOutSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  source: z.string(),
  rowCount: z.int(),
  label: z.enum(LABELS),
  apiKeyId: z.string(),
  documentId: z.string(),
  importId: z.string().nullable(),
  jobId: z.string().nullable(),
  importStatus: z.enum(IMPORT_STATUSES).nullable(),
  counts: countsSchema.nullable(),
  errorCount: z.int().nullable(),
  duplicate: z.boolean(),
  createdAt: z.string(),
});
export type PushBatchOut = z.infer<typeof pushBatchOutSchema>;

export const pagedPushBatchesSchema = z.object({
  items: z.array(pushBatchOutSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

/** `GET /api/v1/push/batches`'s query: paging, `source` and `batchId`; newest first. Unknown
 * filters are refused (400). */
export const pushListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  source: z.string().min(1).max(100).optional(),
  batchId: z.string().min(1).max(200).optional(),
});
export type PushListQuery = z.infer<typeof pushListQuerySchema>;

/** The label a pushed batch's document gets: `internal`, or the key's clearance when lower (D51). */
export function pushLabel(clearance: Label): Label {
  return isVisible(clearance, 'internal') ? 'internal' : clearance;
}

/** The rows' columns as the worker's flat JSON reader reads them: the union of their keys, first
 * seen first. 400 for a blank key or more columns than the reader takes. */
export function pushColumns(rows: PushBatch['rows']): string[] {
  const columns: string[] = [];
  const known = new Set<string>();
  const blank: number[] = [];
  rows.forEach((row, i) => {
    for (const key of Object.keys(row)) {
      if (key.trim() === '') {
        if (blank.length < 20 && blank[blank.length - 1] !== i) blank.push(i);
        continue;
      }
      if (known.has(key)) continue;
      known.add(key);
      columns.push(key);
    }
  });
  if (blank.length > 0) {
    throw new ApiError(400, 'validation_failed', blank.map((i) => `rows.${i}: a column name is blank.`).join(' '));
  }
  if (columns.length > ASSET_LIST_LIMITS.maxColumns) {
    throw new ApiError(400, 'validation_failed', `rows: more than ${ASSET_LIST_LIMITS.maxColumns} columns.`);
  }
  return columns;
}

/** The fields of a saved mapping whose column none of the rows has. */
export function unmappedFields(fields: ImportMapping['fields'], columns: readonly string[]): string[] {
  const have = new Set(columns);
  return ASSET_IMPORT_FIELDS.filter((f) => {
    const column = (fields as Partial<Record<string, string>>)[f];
    return typeof column === 'string' && !have.has(column);
  });
}

/**
 * The push body, checked by `pushBatchSchema`. A refusal is 400 `validation_failed` whose message
 * names a row by its number only, never one of its columns or values (D163, D164: the message is
 * logged with the refusal).
 */
export function parsePushBatch(body: unknown): PushBatch {
  const parsed = pushBatchSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const messages = [
    ...new Set(
      parsed.error.issues.map((issue) => {
        const [top, row] = issue.path;
        if (top === 'rows' && typeof row === 'number' && issue.path.length > 2) {
          return `rows.${row}: every value must be a string, a number, true, false or null.`;
        }
        if (top === 'rows' && typeof row === 'number') return `rows.${row}: each row must be an object.`;
        return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
      }),
    ),
  ].slice(0, 20);
  throw new ApiError(400, 'validation_failed', messages.join('; ') || 'The batch is not valid.');
}

/** The stored document's file name for a batch (the batch ID's characters are all file-name safe). */
export function pushFileName(batchId: string): string {
  return `push-${batchId}.json`;
}

const API_KEY_REQUIRED = (): ApiError =>
  new ApiError(403, 'api_key_required', 'Only an API key can push batches. Ask an Admin for one.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', "This API key's role may not import asset lists.");
const MAPPING_REQUIRED = (): ApiError =>
  new ApiError(
    409,
    'mapping_required',
    'This source has no saved column mapping yet. Upload one of its asset lists and save its mapping first.',
  );

/** Thrown inside a transaction when another request has already claimed the batch: rolls back. */
class BatchTaken extends Error {
  constructor() {
    super('push: the batch was already received');
    this.name = 'BatchTaken';
  }
}

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

/** The first answer of a batch the org already has, marked as a repeat. */
function repeatOf(row: PushBatchRow): PushResult {
  const saved = pushAnswerSchema.safeParse(row.answer);
  const first = saved.success ? saved.data : { batchId: row.batchId, importId: row.importId, jobId: null };
  return {
    status: 200,
    answer: { batchId: first.batchId, importId: first.importId, jobId: first.jobId, duplicate: true },
  };
}

export interface PushServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'put' | 'exists'>;
  jobs: Pick<JobsService, 'sendInTx'>;
  log?: Logger;
}

export class PushService {
  private readonly log: Logger;

  constructor(private readonly deps: PushServiceDeps) {
    this.log = deps.log ?? createLogger().child({ context: 'PushService' });
  }

  async push(caller: Caller, body: unknown): Promise<PushResult> {
    const apiKeyId = caller.apiKeyId;
    if (apiKeyId === undefined) throw API_KEY_REQUIRED();
    if (!canImportAssets(caller.role)) throw FORBIDDEN();
    const batch = parsePushBatch(body);
    const columns = pushColumns(batch.rows);

    const seen = await this.findBatch(caller, batch.source, batch.batchId);
    if (seen) return repeatOf(seen);

    const mapping = await this.savedMapping(caller, batch.source);
    if (!mapping) throw MAPPING_REQUIRED();
    const missing = unmappedFields(mapping, columns);
    if (missing.length > 0) {
      throw new ApiError(
        400,
        'validation_failed',
        missing.map((f) => `rows: no row has the column the saved mapping uses for ${f}.`).join(' '),
      );
    }

    const ids = { orgId: caller.orgId, apiKeyId };
    try {
      const stored = await storeUpload<PushAnswer>(
        this.deps,
        caller,
        {
          kind: 'asset_list',
          fileName: pushFileName(batch.batchId),
          body: Buffer.from(JSON.stringify(batch.rows), 'utf8'),
          label: pushLabel(caller.clearance),
          source: batch.source,
        },
        { afterInsert: (tx, document) => this.recordNew(tx, caller, apiKeyId, batch, columns, mapping, document) },
      );
      if (!stored.duplicate) {
        if (!stored.after) throw new Error('push: the new batch was not recorded');
        this.log.info(
          { ...ids, importId: stored.after.importId, jobId: stored.after.jobId },
          'a push batch was received',
        );
        return { status: 202, answer: stored.after };
      }
      const result = await this.recordAgainst(caller, apiKeyId, batch, stored.document.id);
      this.log.info({ ...ids, documentId: stored.document.id }, 'a push batch repeated stored rows');
      return result;
    } catch (err) {
      if (!(err instanceof BatchTaken)) throw err;
      const first = await this.findBatch(caller, batch.source, batch.batchId);
      if (!first) throw new Error('push: a claimed batch could not be found', { cause: err });
      this.log.info({ ...ids, code: 'batch_repeated' }, 'a push batch arrived twice at once');
      return repeatOf(first);
    }
  }

  async list(caller: Caller, query: unknown): Promise<Paged<PushBatchOut>> {
    const q = pushListQuerySchema.parse(query ?? {});
    const labels = LABELS.filter((l) => isVisible(caller.clearance, l));
    const types = [...new Set(Object.values(DOCUMENT_RECORD_TYPE))].filter((t) => can(caller.role, t, 'view'));
    if (labels.length === 0 || types.length === 0) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };

    const where = and(
      eq(pushBatches.orgId, caller.orgId),
      inArray(documents.label, labels),
      inArray(documents.recordType, types),
      q.source !== undefined ? eq(pushBatches.source, q.source) : undefined,
      q.batchId !== undefined ? eq(pushBatches.batchId, q.batchId) : undefined,
    )!;
    const docJoin = and(eq(documents.orgId, pushBatches.orgId), eq(documents.id, pushBatches.documentId));
    const impJoin = and(eq(imports.orgId, pushBatches.orgId), eq(imports.id, pushBatches.importId));

    return withOrgContext(this.deps.db, contextOf(caller), async (tx) => {
      const [counted] = await tx
        .select({ total: count() })
        .from(pushBatches)
        .innerJoin(documents, docJoin)
        .where(where);
      const rows = await tx
        .select({
          batch: pushBatches,
          label: documents.label,
          importStatus: imports.status,
          counts: imports.counts,
          errors: imports.errors,
        })
        .from(pushBatches)
        .innerJoin(documents, docJoin)
        .leftJoin(imports, impJoin)
        .where(where)
        .orderBy(desc(pushBatches.createdAt), desc(pushBatches.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return {
        items: rows.map((r) => {
          const answer = pushAnswerSchema.safeParse(r.batch.answer);
          return {
            id: r.batch.id,
            batchId: r.batch.batchId,
            source: r.batch.source,
            rowCount: r.batch.rowCount,
            label: r.label,
            apiKeyId: r.batch.apiKeyId,
            documentId: r.batch.documentId ?? '',
            importId: r.batch.importId,
            jobId: answer.success ? answer.data.jobId : null,
            importStatus: r.importStatus ?? null,
            counts: r.counts ?? null,
            errorCount: r.errors ? r.errors.length : null,
            duplicate: answer.success ? answer.data.duplicate : false,
            createdAt: r.batch.createdAt.toISOString(),
          };
        }),
        page: q.page,
        pageSize: q.pageSize,
        total: counted?.total ?? 0,
      };
    });
  }

  /** The org's batch with this source and batch ID, if it has one. */
  private findBatch(caller: Caller, source: string, batchId: string): Promise<PushBatchRow | undefined> {
    return withOrgContext(this.deps.db, contextOf(caller), async (tx) => {
      const [row] = await tx
        .select()
        .from(pushBatches)
        .where(
          and(eq(pushBatches.orgId, caller.orgId), eq(pushBatches.source, source), eq(pushBatches.batchId, batchId)),
        )
        .limit(1);
      return row;
    });
  }

  /** The source's saved mapping fields, if it has one. */
  private savedMapping(caller: Caller, source: string): Promise<ImportMapping['fields'] | undefined> {
    return withOrgContext(this.deps.db, contextOf(caller), async (tx) => {
      const [row] = await tx
        .select({ fields: importMappings.fields })
        .from(importMappings)
        .where(and(eq(importMappings.orgId, caller.orgId), eq(importMappings.source, source)))
        .limit(1);
      return row?.fields;
    });
  }

  /** Claims the batch, or throws `BatchTaken` (which rolls the transaction back). */
  private async claim(
    tx: Tx,
    caller: Caller,
    apiKeyId: string,
    batch: PushBatch,
    documentId: string,
    importId: string | null,
    answer: PushAnswer | null,
  ): Promise<string> {
    const [claimed] = await tx
      .insert(pushBatches)
      .values({
        orgId: caller.orgId,
        apiKeyId,
        source: batch.source,
        batchId: batch.batchId,
        documentId,
        importId,
        rowCount: batch.rows.length,
        answer,
      })
      .onConflictDoNothing({ target: [pushBatches.orgId, pushBatches.source, pushBatches.batchId] })
      .returning({ id: pushBatches.id });
    if (!claimed) throw new BatchTaken();
    await this.deps.audit.appendInTx(tx, {
      orgId: caller.orgId,
      ...actorOf(caller),
      action: 'push.received',
      targetType: 'push_batch',
      targetId: claimed.id,
      meta: { source: batch.source, batchId: batch.batchId, rowCount: batch.rows.length },
    });
    return claimed.id;
  }

  // A new document: the batch, its import and the run job, in the document's own transaction.
  private async recordNew(
    tx: Tx,
    caller: Caller,
    apiKeyId: string,
    batch: PushBatch,
    columns: string[],
    mapping: ImportMapping['fields'],
    document: DocumentRow,
  ): Promise<PushAnswer> {
    const pushId = await this.claim(tx, caller, apiKeyId, batch, document.id, null, null);
    const [imp] = await tx
      .insert(imports)
      .values({
        orgId: caller.orgId,
        documentId: document.id,
        source: batch.source,
        status: 'queued',
        label: document.label,
        columns,
        sample: batch.rows.slice(0, MAX_IMPORT_SAMPLE_ROWS),
        rowCount: batch.rows.length,
        mapping,
        createdBy: caller.userId,
      })
      .returning();
    if (!imp) throw new Error('push: the import row was not created');
    const jobId = await startImportRunInTx(
      tx,
      { jobs: this.deps.jobs, audit: this.deps.audit },
      { imp, mapping, runner: runnerOf(caller) },
    );
    if (jobId === null) throw new Error('push: the import run was not queued');
    const answer: PushAnswer = { batchId: batch.batchId, importId: imp.id, jobId, duplicate: false };
    await tx
      .update(pushBatches)
      .set({ importId: imp.id, answer, updatedAt: new Date() })
      .where(and(eq(pushBatches.orgId, caller.orgId), eq(pushBatches.id, pushId)));
    return answer;
  }

  // Rows the org already has: the batch is recorded against that document and its import; nothing
  // is queued.
  private recordAgainst(caller: Caller, apiKeyId: string, batch: PushBatch, documentId: string): Promise<PushResult> {
    return withOrgContext(this.deps.db, contextOf(caller), async (tx) => {
      const [imp] = await tx
        .select({ id: imports.id })
        .from(imports)
        .where(and(eq(imports.orgId, caller.orgId), eq(imports.documentId, documentId)))
        .orderBy(asc(imports.createdAt), asc(imports.id))
        .limit(1);
      const answer: PushAnswer = { batchId: batch.batchId, importId: imp?.id ?? null, jobId: null, duplicate: true };
      await this.claim(tx, caller, apiKeyId, batch, documentId, answer.importId, answer);
      return { status: 200 as const, answer };
    });
  }
}
