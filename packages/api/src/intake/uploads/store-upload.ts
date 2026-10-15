// The one "check, hash, store, record" step for every file that arrives (S3-004; S3-009's evidence
// reuses it). D21, D29, D45.4, D45.5, D50, D51, D53, D56, D72, D163, D164, D198.
//
// 1. The checks, in this order: a known kind; `canUpload(role, kind)` (403); the label, by default
//    `internal`, never above the caller's clearance (403, D198); the source, required for an asset
//    list and refused otherwise (400); the file name (400); an empty file (400) or one over
//    `MAX_UPLOAD_BYTES` (413); the format by content (`sniff.ts`, 415 with the reason in plain
//    words), and one the kind takes (415).
// 2. `sha256` of the bytes; the object key is `sha256/<hex>` in the org's own bucket, written only
//    when it isn't there yet, so the same file is stored once per org (D45.5).
// 3. One `withOrgContext` transaction in the caller's own context (or, with `context: 'system'`,
//    the intake system context: S3-009's evidence files, planner's reading R12): the `documents`
//    row (or, when the org already has that content, the existing row, which keeps its kind, label
//    and uploader), the `document.uploaded` entry (`appendInTx`, `meta { kind, format, label,
//    duplicate }`, never the file's contents or name), and, for a new document only, the caller's
//    `afterInsert` hook (the kind's job, `JobsService.sendInTx`). They commit together or not at all (D29, D45.4); the
//    stored object may stay after a rollback, and a retry reuses it.
// The same content already stored under a label above the caller's clearance is hidden from them
// by RLS: the repeat is still audited, and the answer is 409 `already_stored`, which names nothing
// about the hidden document.
// Log lines hold only error types or codes and IDs, never the file name or contents (D163, D164).
import { createHash } from 'node:crypto';
import {
  DOCUMENT_RECORD_TYPE,
  FORMAT_CONTENT_TYPES,
  KIND_FORMATS,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  canUpload,
  isDocumentKind,
  isLabel,
  isVisible,
  sourceNameSchema,
  type DocumentKind,
  type FileFormat,
  type Label,
} from '@grc/shared';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError, errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { Caller } from '../../records/records.service.js';
import type { FileStore } from '../../storage/file-store.js';
import { toDocumentOut, type DocumentOut } from '../documents/documents.service.js';
import { documents, type DocumentRow, type UploaderType } from '../intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../queues.js';
import { sniffFileFormat } from './sniff.js';

/** The label a document gets when the uploader names none (D51). */
export const DEFAULT_UPLOAD_LABEL: Label = 'internal';

export interface StoreUploadDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'put' | 'exists'>;
  log?: Logger;
}

export interface StoreUploadInput {
  kind: DocumentKind;
  fileName: string;
  body: Buffer;
  label?: Label;
  source?: string;
}

export interface StoreUploadOptions<T> {
  /** Runs in the same transaction right after a new document's row and entry, for the kind's job. */
  afterInsert?: (tx: Tx, document: DocumentRow) => Promise<T>;
  /**
   * Whose Postgres context the document row is written and found under: the caller's own
   * (`caller`, the default), or the intake system context (`system`, R12). Evidence uses `system`:
   * a Control Owner's own context can't see evidence rows, and the evidence rules have already
   * passed in the API by then. The org wall applies either way; the audit entry names the caller.
   */
  context?: 'caller' | 'system';
}

export interface StoredUpload<T = undefined> {
  document: DocumentOut;
  duplicate: boolean;
  /** What `afterInsert` returned (new documents only). */
  after?: T;
}

/** Who did it, for the audit entry and the document's uploader. */
export function actorOf(caller: Caller): { actorType: Exclude<UploaderType, 'system'>; actorId: string } {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

const FORMAT_NAMES: Readonly<Record<FileFormat, string>> = {
  pdf: 'PDF',
  docx: 'DOCX',
  csv: 'CSV',
  json: 'JSON',
  txt: 'TXT',
};

const KIND_NAMES: Readonly<Record<DocumentKind, string>> = {
  asset_list: 'An asset list',
  policy_document: 'A policy document',
  soc_ticket: 'A SOC ticket file',
  audit_report: 'An audit report',
  evidence: 'An evidence file',
};

function orList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

const invalid = (message: string): ApiError => new ApiError(400, 'validation_failed', message);
const forbidden = (message = 'You do not have permission to do this.'): ApiError =>
  new ApiError(403, 'forbidden', message);

/** 413 for a file over 25 MB, in the one error format. */
export function fileTooLarge(): ApiError {
  return new ApiError(413, 'file_too_large', 'Files are limited to 25 MB.');
}

/** 415 with the reason in plain words. */
export function unsupportedFileType(reason: 'zip' | 'unknown_type' | 'extension_mismatch'): ApiError {
  const messages = {
    zip: 'Zip files are not accepted, other than Word documents (.docx).',
    unknown_type: 'This type of file is not accepted: only PDF, DOCX, CSV, JSON and TXT files are.',
    extension_mismatch: "The file's contents don't match its extension.",
  } as const;
  return new ApiError(415, 'unsupported_file_type', messages[reason]);
}

/** The file name as stored: its last path segment, without control characters, trimmed; null when
 * nothing is left. */
export function cleanFileName(fileName: string): string | null {
  const base = (fileName.split(/[/\\]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  return base === '' || base === '.' || base === '..' ? null : base;
}

/** The lowercase hex SHA-256 of the bytes. */
export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The object key of a file in its org's bucket (D45.5). */
export function storageKeyFor(contentHash: string): string {
  return `sha256/${contentHash}`;
}

interface Checked {
  kind: DocumentKind;
  fileName: string;
  format: FileFormat;
  label: Label;
  source: string | null;
}

function check(caller: Caller, input: StoreUploadInput): Checked {
  const { kind } = input;
  if (!isDocumentKind(kind)) throw invalid('kind: unknown kind of upload.');
  if (!canUpload(caller.role, kind)) throw forbidden();

  const label = input.label ?? DEFAULT_UPLOAD_LABEL;
  if (!isLabel(label)) throw invalid('label: unknown label.');
  if (!isVisible(caller.clearance, label)) {
    throw forbidden('You cannot label a document above your own clearance.');
  }

  let source: string | null = null;
  if (kind === 'asset_list') {
    const parsed = sourceNameSchema.safeParse(input.source);
    if (!parsed.success) {
      throw invalid('source: an asset list needs its source: 1-100 letters, digits, spaces, _, - and .');
    }
    source = parsed.data;
  } else if (input.source !== undefined) {
    throw invalid('source: only an asset list takes a source.');
  }

  const fileName = typeof input.fileName === 'string' ? cleanFileName(input.fileName) : null;
  if (fileName === null) throw invalid('file: the file needs a name.');
  if ([...fileName].length > MAX_FILE_NAME_LENGTH) {
    throw invalid(`file: the file name is longer than ${MAX_FILE_NAME_LENGTH} characters.`);
  }

  const body = input.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw invalid('file: the file is empty.');
  if (body.length > MAX_UPLOAD_BYTES) throw fileTooLarge();

  const detected = sniffFileFormat(fileName, body);
  if (!detected.ok) {
    if (detected.reason === 'empty') throw invalid('file: the file is empty.');
    throw unsupportedFileType(detected.reason);
  }
  const allowed = KIND_FORMATS[kind];
  if (!allowed.includes(detected.format)) {
    throw new ApiError(
      415,
      'unsupported_file_type',
      `${KIND_NAMES[kind]} takes ${orList(allowed.map((f) => FORMAT_NAMES[f]))} files, not ${FORMAT_NAMES[detected.format]}.`,
    );
  }
  return { kind, fileName, format: detected.format, label, source };
}

type Outcome<T> =
  | { status: 'new'; row: DocumentRow; after: T | undefined }
  | { status: 'duplicate'; row: DocumentRow }
  | { status: 'hidden' };

/**
 * Checks, hashes, stores and records one file for the caller's org. Throws an `ApiError` for a
 * refusal (400, 403, 409, 413, 415); anything else is unexpected (500).
 */
export async function storeUpload<T = undefined>(
  deps: StoreUploadDeps,
  caller: Caller,
  input: StoreUploadInput,
  opts: StoreUploadOptions<T> = {},
): Promise<StoredUpload<T>> {
  const log = deps.log ?? createLogger().child({ context: 'storeUpload' });
  const checked = check(caller, input);
  const body = input.body;
  const contentHash = sha256Hex(body);
  const storageKey = storageKeyFor(contentHash);
  const ids = { orgId: caller.orgId, kind: checked.kind };

  try {
    if (!(await deps.files.exists(caller.orgId, storageKey))) {
      await deps.files.put(caller.orgId, storageKey, body, FORMAT_CONTENT_TYPES[checked.format]);
    }
  } catch (err) {
    log.error({ ...ids, ...errorKind(err) }, 'an uploaded file could not be stored');
    throw err;
  }

  const actor = actorOf(caller);
  const audit = (tx: Tx, row: Pick<DocumentRow, 'id' | 'kind' | 'format' | 'label'>, duplicate: boolean) =>
    deps.audit.appendInTx(tx, {
      orgId: caller.orgId,
      ...actor,
      action: 'document.uploaded',
      targetType: 'document',
      targetId: row.id,
      meta: { kind: row.kind, format: row.format, label: row.label, duplicate },
    });
  const byHash = and(eq(documents.orgId, caller.orgId), eq(documents.contentHash, contentHash));

  const context = opts.context === 'system' ? INTAKE_SYSTEM_CONTEXT(caller.orgId) : contextOf(caller);
  const outcome = await withOrgContext<Outcome<T>>(deps.db, context, async (tx) => {
    const [inserted] = await tx
      .insert(documents)
      .values({
        orgId: caller.orgId,
        kind: checked.kind,
        recordType: DOCUMENT_RECORD_TYPE[checked.kind],
        format: checked.format,
        fileName: checked.fileName,
        contentType: FORMAT_CONTENT_TYPES[checked.format],
        sizeBytes: body.length,
        contentHash,
        storageKey,
        label: checked.label,
        uploaderType: actor.actorType,
        uploaderId: actor.actorId,
        source: checked.source,
        status: 'stored',
      })
      .onConflictDoNothing({ target: [documents.orgId, documents.contentHash] })
      .returning();
    if (inserted) {
      await audit(tx, inserted, false);
      const after = opts.afterInsert ? await opts.afterInsert(tx, inserted) : undefined;
      return { status: 'new', row: inserted, after };
    }
    const [existing] = await tx.select().from(documents).where(byHash).limit(1);
    if (existing) {
      await audit(tx, existing, true);
      return { status: 'duplicate', row: existing };
    }
    return { status: 'hidden' };
  });

  if (outcome.status === 'new') return { document: toDocumentOut(outcome.row), duplicate: false, after: outcome.after };
  if (outcome.status === 'duplicate') return { document: toDocumentOut(outcome.row), duplicate: true };

  // The org has this content in a document the caller can't see: audit the repeat against it.
  const hidden = await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(caller.orgId), async (tx) => {
    const [row] = await tx
      .select({ id: documents.id, kind: documents.kind, format: documents.format, label: documents.label })
      .from(documents)
      .where(byHash)
      .limit(1);
    return row;
  });
  if (hidden) await withOrgContext(deps.db, context, (tx) => audit(tx, hidden, true));
  log.warn({ ...ids, documentId: hidden?.id, code: 'already_stored' }, 'an upload repeats a hidden document');
  throw new ApiError(409, 'already_stored', 'This file is already stored in your organisation.');
}
