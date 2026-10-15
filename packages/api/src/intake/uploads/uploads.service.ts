// Uploading a file (S3-004, D21, D29, D45.4, D45.5, D47, D50, D51, D53, D56, D72).
// The form's text fields are `kind` (one of the upload kinds; evidence arrives only through
// `POST /api/v1/evidence`), `label` (optional, `internal` when not given) and `source` (required
// for an asset list, refused otherwise); a field sent empty counts as not sent, as a browser form
// sends every field. Anything else in the form is refused (400).
// Then `storeUpload` checks, hashes, stores and records the file, and for a new document queues the
// kind's next step in the same transaction (D29, D45.4), keyed on `<orgId>:<content hash>` (D72):
// - an asset list: its `imports` row (status `reading`) and `INTAKE_QUEUES.assetListRead`;
// - any other kind: `INTAKE_QUEUES.documentRead` (S4's processing handles it; planner's reading R1).
// A repeat of content the org already has is stored, recorded and queued nothing again (R5).
import { LABELS, UPLOAD_KINDS, sourceNameSchema } from '@grc/shared';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError } from '../../common/errors.js';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/org-context.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import type { Caller } from '../../records/records.service.js';
import type { FileStore } from '../../storage/file-store.js';
import { documentOutSchema } from '../documents/documents.service.js';
import { imports, type DocumentRow } from '../intake.schema.js';
import { INTAKE_QUEUES } from '../queues.js';
import type { MultipartForm } from './multipart.js';
import { storeUpload } from './store-upload.js';

/** The upload form's text fields. */
export const uploadFieldsSchema = z
  .strictObject({
    kind: z.enum(UPLOAD_KINDS),
    label: z.enum(LABELS).optional(),
    source: sourceNameSchema.optional(),
  })
  .superRefine((fields, ctx) => {
    if (fields.kind === 'asset_list' && fields.source === undefined) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'An asset list needs its source.' });
    }
    if (fields.kind !== 'asset_list' && fields.source !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'Only an asset list takes a source.' });
    }
  });

export type UploadFields = z.infer<typeof uploadFieldsSchema>;

/** 201: a new document, with its job (and, for an asset list, its import). */
export const uploadCreatedSchema = z.object({
  document: documentOutSchema,
  duplicate: z.literal(false),
  jobId: z.string().nullable(),
  importId: z.string().optional(),
});

/** 200: the org already had this content; nothing was stored or queued again. */
export const uploadDuplicateSchema = z.object({
  document: documentOutSchema,
  duplicate: z.literal(true),
});

export type UploadCreated = z.infer<typeof uploadCreatedSchema>;
export type UploadDuplicate = z.infer<typeof uploadDuplicateSchema>;
export type UploadAnswer = UploadCreated | UploadDuplicate;

export interface UploadsServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'put' | 'exists'>;
  jobs: Pick<JobsService, 'sendInTx'>;
  log?: Logger;
}

interface Queued {
  jobId: string | null;
  importId?: string;
}

/** The form's text fields, with empty ones dropped. A ZodError (400) for anything else. */
export function parseUploadFields(fields: Record<string, string>): UploadFields {
  const given = Object.fromEntries(
    Object.entries(fields)
      .map(([name, value]) => [name, value.trim()] as const)
      .filter(([, value]) => value !== ''),
  );
  return uploadFieldsSchema.parse(given);
}

export class UploadsService {
  constructor(private readonly deps: UploadsServiceDeps) {}

  async upload(caller: Caller, form: MultipartForm): Promise<UploadAnswer> {
    const fields = parseUploadFields(form.fields);
    if (!form.file) throw new ApiError(400, 'validation_failed', 'file: attach one file.');

    const stored = await storeUpload<Queued>(
      this.deps,
      caller,
      {
        kind: fields.kind,
        fileName: form.file.fileName,
        body: form.file.body,
        ...(fields.label !== undefined ? { label: fields.label } : {}),
        ...(fields.source !== undefined ? { source: fields.source } : {}),
      },
      { afterInsert: (tx, document) => this.queueNextStep(tx, caller, document) },
    );

    if (stored.duplicate) return { document: stored.document, duplicate: true };
    const queued = stored.after ?? { jobId: null };
    return {
      document: stored.document,
      duplicate: false,
      jobId: queued.jobId,
      ...(queued.importId !== undefined ? { importId: queued.importId } : {}),
    };
  }

  // The kind's next step, in the upload's own transaction.
  private async queueNextStep(tx: Tx, caller: Caller, document: DocumentRow): Promise<Queued> {
    const singletonKey = `${caller.orgId}:${document.contentHash}`;
    if (document.kind !== 'asset_list') {
      const jobId = await this.deps.jobs.sendInTx(
        tx,
        INTAKE_QUEUES.documentRead,
        { orgId: caller.orgId, documentId: document.id },
        { singletonKey },
      );
      return { jobId };
    }

    const [created] = await tx
      .insert(imports)
      .values({
        orgId: caller.orgId,
        documentId: document.id,
        source: document.source ?? '',
        status: 'reading',
        label: document.label,
        createdBy: caller.userId,
      })
      .returning({ id: imports.id });
    if (!created) throw new Error('uploads: the import row was not created');
    const jobId = await this.deps.jobs.sendInTx(
      tx,
      INTAKE_QUEUES.assetListRead,
      { orgId: caller.orgId, importId: created.id, documentId: document.id },
      { singletonKey },
    );
    if (jobId !== null) {
      await tx
        .update(imports)
        .set({ jobId })
        .where(and(eq(imports.orgId, caller.orgId), eq(imports.id, created.id)));
    }
    return { jobId, importId: created.id };
  }
}
