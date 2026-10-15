// Starting an asset import run (S3-007, D29, D44, D45.4, D213 (5)): the one step every way of
// running an import takes (the run route, the reader's automatic run for a source with a saved
// mapping, and S3-008's push API). In the caller's own Postgres transaction:
//   1. the run job is queued (`JobsService.sendInTx`, `singletonKey` `<importId>`, so one run per
//      import is queued or running at a time; null means one already is);
//   2. the import is set to `queued`, with the mapping snapshot and the job's ID, and its last
//      counts and errors cleared;
//   3. the `import.started` entry is appended (`AuditService.appendInTx`).
// They commit together or not at all. The job's data names the runner: who ran it, their role and
// clearance (an API key runs with its one role at `internal`, D54), which the worker uses for the
// label checks (D198) and the audit entries.
import { LABELS, ROLES, canImportAssets, type ImportMapping, type Label, type Role } from '@grc/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import type { Tx } from '../../db/org-context.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member } from '../../identity/schema.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import { imports, type DocumentRow, type ImportRow } from '../intake.schema.js';
import { INTAKE_QUEUES } from '../queues.js';
import { mappedFieldNames } from './mappings.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who runs an import: a person (`userId`) or an API key (`apiKeyId`, `userId` `api_key:<id>`). */
export const importRunnerSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ROLES),
  clearance: z.enum(LABELS),
  apiKeyId: z.string().regex(UUID).optional(),
});
export type ImportRunnerRef = z.infer<typeof importRunnerSchema>;

/** The run job's data. */
export const assetImportJobSchema = z.object({
  orgId: z.string().regex(UUID),
  importId: z.string().regex(UUID),
  runner: importRunnerSchema,
  automatic: z.boolean().optional(),
});
export type AssetImportJobData = z.infer<typeof assetImportJobSchema>;

/** The audit actor of a runner. */
export function runnerActor(runner: ImportRunnerRef): { actorType: 'user' | 'api_key'; actorId: string } {
  return runner.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: runner.apiKeyId }
    : { actorType: 'user', actorId: runner.userId };
}

export interface StartImportRunDeps {
  jobs: Pick<JobsService, 'sendInTx'>;
  audit: Pick<AuditService, 'appendInTx'>;
}

export interface StartImportRun {
  imp: Pick<ImportRow, 'id' | 'orgId' | 'source' | 'label'>;
  mapping: ImportMapping['fields'];
  runner: ImportRunnerRef;
  /** True when the reader started it for a source with a saved mapping. */
  automatic?: boolean;
}

/** Queues the run in `tx` (see the top of the file). Answers the job's ID, or null when a run of
 * this import is already queued or running (nothing is changed then). */
export async function startImportRunInTx(
  tx: Tx,
  deps: StartImportRunDeps,
  start: StartImportRun,
): Promise<string | null> {
  const { imp, mapping, runner } = start;
  const data: AssetImportJobData = {
    orgId: imp.orgId,
    importId: imp.id,
    runner,
    ...(start.automatic ? { automatic: true } : {}),
  };
  const jobId = await deps.jobs.sendInTx(tx, INTAKE_QUEUES.assetImport, data, { singletonKey: imp.id });
  if (jobId === null) return null;
  await tx
    .update(imports)
    .set({ status: 'queued', mapping, jobId, counts: null, errors: null, updatedAt: new Date() })
    .where(and(eq(imports.orgId, imp.orgId), eq(imports.id, imp.id)));
  await deps.audit.appendInTx(tx, {
    orgId: imp.orgId,
    ...runnerActor(runner),
    action: 'import.started',
    targetType: 'import',
    targetId: imp.id,
    after: { status: 'queued', fields: mappedFieldNames(mapping) },
    meta: { source: imp.source, label: imp.label, jobId, automatic: start.automatic === true },
  });
  return jobId;
}

/**
 * The person or API key that stored a document, as an import runner, when they may import assets
 * (`canImportAssets`): a person by their membership of the org (role and clearance), a key by its
 * one role at `internal` while it is neither revoked nor expired. Anything else is null (a system
 * upload, a member who left, a key that no longer works, or a role that can't import).
 */
export async function uploaderAsRunner(
  tx: Tx,
  doc: Pick<DocumentRow, 'orgId' | 'uploaderType' | 'uploaderId'>,
  now: Date = new Date(),
): Promise<ImportRunnerRef | null> {
  if (doc.uploaderType === 'user') {
    const [row] = await tx
      .select({ role: member.role, clearance: member.clearance })
      .from(member)
      .where(and(eq(member.organizationId, doc.orgId), eq(member.userId, doc.uploaderId)))
      .limit(1);
    if (!row || !canImportAssets(row.role) || !(LABELS as readonly string[]).includes(row.clearance)) return null;
    return { userId: doc.uploaderId, role: row.role as Role, clearance: row.clearance as Label };
  }
  if (doc.uploaderType === 'api_key' && UUID.test(doc.uploaderId)) {
    const [row] = await tx
      .select({ role: apiKeys.role, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, doc.orgId), eq(apiKeys.id, doc.uploaderId)))
      .limit(1);
    if (!row || row.revokedAt !== null || row.expiresAt <= now || !canImportAssets(row.role)) return null;
    return {
      userId: `api_key:${doc.uploaderId}`,
      role: row.role as Role,
      clearance: 'internal',
      apiKeyId: doc.uploaderId,
    };
  }
  return null;
}
