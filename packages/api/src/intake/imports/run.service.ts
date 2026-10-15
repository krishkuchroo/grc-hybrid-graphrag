// Running an asset import (S3-007, D44, D47, D50, D51, D213 (5)): `POST /api/v1/imports/:id/run`.
// - The route needs the `uploads` cell (the guard), then `canImportAssets` (403); the import must be
//   one the caller can see (the role's asset view and the import's label at or below their
//   clearance, checked here and again by RLS in the caller's own org context): else 404, the same
//   as a missing one.
// - The import must have been read: `needs_mapping`, `done` (a re-run) or `failed` after a run (it
//   has its columns). `queued` or `importing` is 409 `import_busy`; still `reading`, or a file that
//   couldn't be read, is 409 `import_not_ready`.
// - Every column the mapping names must be one of the file's (400, naming our field, never the
//   column).
// - In one transaction: the source's mapping saved when `saveForSource` (created, or replaced at
//   version + 1, audited `import_mapping.saved` with field names only), then `startImportRunInTx`
//   (the job keyed `<importId>`, the import `queued` with the mapping snapshot, `import.started`).
//   Answers 202 `{ jobId }`.
import { ASSET_IMPORT_FIELDS, LABELS, canImportAssets, can, importMappingSchema, isVisible } from '@grc/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError } from '../../common/errors.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import type { Caller } from '../../records/records.service.js';
import { importMappings, imports, type ImportMappingRow } from '../intake.schema.js';
import { runnerActor, startImportRunInTx, type ImportRunnerRef } from './import-run.js';
import { mappedFieldNames } from './mappings.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `POST /api/v1/imports/:id/run`'s body: our field -> the file's column, and whether to save it
 * as the source's mapping. */
export const runImportBodySchema = z.strictObject({
  mapping: importMappingSchema.shape.fields,
  saveForSource: z.boolean(),
});
export type RunImportBody = z.infer<typeof runImportBodySchema>;

export const runStartedSchema = z.object({ jobId: z.string() });
export type RunStarted = z.infer<typeof runStartedSchema>;

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The import was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not import asset lists.');
const BUSY = (): ApiError =>
  new ApiError(409, 'import_busy', 'This import is already queued or running. Wait for it to finish.');
const NOT_READY = (reading: boolean): ApiError =>
  new ApiError(
    409,
    'import_not_ready',
    reading
      ? 'The file is still being read. Try again in a moment.'
      : 'This file could not be read, so it cannot be imported.',
  );

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

/** The caller as an import runner (an API key runs with its one role, D54). */
export function runnerOf(caller: Caller): ImportRunnerRef {
  return {
    userId: caller.userId,
    role: caller.role,
    clearance: caller.clearance,
    ...(caller.apiKeyId !== undefined ? { apiKeyId: caller.apiKeyId } : {}),
  };
}

export interface ImportRunServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  jobs: Pick<JobsService, 'sendInTx'>;
}

export class ImportRunService {
  private readonly db: Db;
  private readonly audit: Pick<AuditService, 'appendInTx'>;
  private readonly jobs: Pick<JobsService, 'sendInTx'>;

  constructor(deps: ImportRunServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.jobs = deps.jobs;
  }

  async run(caller: Caller, id: string, body: unknown): Promise<RunStarted> {
    if (typeof id !== 'string' || !UUID.test(id)) throw NOT_FOUND();
    if (!canImportAssets(caller.role)) throw FORBIDDEN();
    const labels = can(caller.role, 'asset', 'view') ? LABELS.filter((l) => isVisible(caller.clearance, l)) : [];
    if (labels.length === 0) throw NOT_FOUND();
    const input = runImportBodySchema.parse(body);
    const mapping = Object.fromEntries(
      ASSET_IMPORT_FIELDS.flatMap((f) => (input.mapping[f] !== undefined ? [[f, input.mapping[f]]] : [])),
    ) as ImportMappingRow['fields'];

    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [imp] = await tx
        .select()
        .from(imports)
        .where(and(eq(imports.orgId, caller.orgId), eq(imports.id, id), inArray(imports.label, labels)))
        .for('update')
        .limit(1);
      if (!imp) throw NOT_FOUND();
      if (imp.status === 'queued' || imp.status === 'importing') throw BUSY();
      const runnable =
        imp.status === 'needs_mapping' || imp.status === 'done' || (imp.status === 'failed' && imp.columns !== null);
      if (!runnable || imp.columns === null) throw NOT_READY(imp.status === 'reading');

      const columns = imp.columns;
      const missing = ASSET_IMPORT_FIELDS.filter((f) => mapping[f] !== undefined && !columns.includes(mapping[f]!));
      if (missing.length > 0) {
        throw new ApiError(
          400,
          'validation_failed',
          missing.map((f) => `mapping.${f}: the file has no such column.`).join(' '),
        );
      }

      if (input.saveForSource) await this.saveForSource(tx, caller, imp.source, mapping);
      const jobId = await startImportRunInTx(
        tx,
        { jobs: this.jobs, audit: this.audit },
        { imp, mapping, runner: runnerOf(caller) },
      );
      if (jobId === null) throw BUSY();
      return { jobId };
    });
  }

  /** Creates the source's mapping, or replaces it at version + 1; audited with field names only. */
  private async saveForSource(
    tx: Tx,
    caller: Caller,
    source: string,
    fields: ImportMappingRow['fields'],
  ): Promise<void> {
    const [existing] = await tx
      .select()
      .from(importMappings)
      .where(and(eq(importMappings.orgId, caller.orgId), eq(importMappings.source, source)))
      .for('update')
      .limit(1);
    let row: ImportMappingRow | undefined;
    if (existing) {
      [row] = await tx
        .update(importMappings)
        .set({ fields, version: existing.version + 1, updatedBy: caller.userId, updatedAt: new Date() })
        .where(and(eq(importMappings.orgId, caller.orgId), eq(importMappings.id, existing.id)))
        .returning();
    } else {
      [row] = await tx
        .insert(importMappings)
        .values({
          orgId: caller.orgId,
          source,
          fields,
          version: 1,
          createdBy: caller.userId,
          updatedBy: caller.userId,
        })
        .onConflictDoUpdate({
          target: [importMappings.orgId, importMappings.source],
          set: {
            fields,
            version: sql`${importMappings.version} + 1`,
            updatedBy: caller.userId,
            updatedAt: new Date(),
          },
        })
        .returning();
    }
    if (!row) return;
    await this.audit.appendInTx(tx, {
      orgId: caller.orgId,
      ...runnerActor(runnerOf(caller)),
      action: 'import_mapping.saved',
      targetType: 'import_mapping',
      targetId: row.id,
      ...(existing ? { before: { source: existing.source, fields: mappedFieldNames(existing.fields) } } : {}),
      after: { source: row.source, fields: mappedFieldNames(row.fields) },
      meta: { source: row.source },
    });
  }
}
