// The stored documents (S3-005, D47, D53, D56, D73): the paged list, one document, and its
// download through the API only.
// - Our code checks first (D45.3, D59): the route needs the `uploads` cell (the guard), then the
//   caller's role must view the document's record type (`can(role, type, 'view')`, so ownership
//   cells see nothing) and its label must be at or below the caller's clearance (D51). Every read
//   then runs in the caller's own org context (`withOrgContext`), so Postgres RLS checks the org
//   wall, the role and the label again (D73). A document that fails either check is 404, the same
//   as a missing one, and is missing from the list and its `total`.
// - Evidence documents never appear here, for anyone: they're reached only through the evidence
//   routes (S3-009, planner's reading R12).
// - A download reads the bytes from the org's own bucket first, then writes one
//   `document.downloaded` entry (`appendInTx`, `meta { kind, label }`, no contents), and only then
//   are the bytes sent. A file that can't be read writes no entry and answers 500 with a reference
//   ID.
// - Log lines hold only the error's type or code and the IDs, never a file name or contents
//   (D163, D164).
import {
  DOCUMENT_KINDS,
  DOCUMENT_RECORD_TYPE,
  DOCUMENT_STATUSES,
  FILE_FORMATS,
  FORMAT_CONTENT_TYPES,
  LABELS,
  RECORD_TYPES,
  UPLOAD_KINDS,
  can,
  isVisible,
  type Label,
  type UploadKind,
} from '@grc/shared';
import { and, asc, count, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError, errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import { pageQuerySchema, type Paged } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { Caller } from '../../records/records.service.js';
import type { FileStore } from '../../storage/file-store.js';
import { UPLOADER_TYPES, documents, imports, type DocumentRow } from '../intake.schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stored document as the API returns it (S3-004's `DocumentOut`). */
export const documentOutSchema = z.object({
  id: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  recordType: z.enum(RECORD_TYPES),
  format: z.enum(FILE_FORMATS),
  fileName: z.string(),
  sizeBytes: z.int(),
  contentHash: z.string(),
  label: z.enum(LABELS),
  uploader: z.object({ type: z.enum(UPLOADER_TYPES), id: z.string() }),
  source: z.string().nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  createdAt: z.string(),
});

export type DocumentOut = z.infer<typeof documentOutSchema>;

/** One document, plus the import of an asset list (`null` when it has none yet). */
export const documentDetailSchema = documentOutSchema.extend({ importId: z.string().nullable().optional() });

export type DocumentDetail = z.infer<typeof documentDetailSchema>;

export const pagedDocumentsSchema = z.object({
  items: z.array(documentOutSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

/** The list's sort fields, each ascending or descending (`-`). */
export const DOCUMENT_SORT_FIELDS = ['createdAt', 'fileName'] as const;
const SORT_VALUES = DOCUMENT_SORT_FIELDS.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];

/** `GET /api/v1/documents`'s query. Unknown filters and sort values are refused (400). Evidence is
 * never listed here, so `kind` takes the upload kinds only. */
export const documentListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  sort: z.enum(SORT_VALUES).default('-createdAt'),
  kind: z.enum(UPLOAD_KINDS).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  source: z.string().trim().min(1).max(200).optional(),
  label: z.enum(LABELS).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

/** Checks a list query (a ZodError, answered as 400, for anything unknown or malformed). */
export function parseDocumentListQuery(query: unknown): DocumentListQuery {
  return documentListQuerySchema.parse(query ?? {});
}

/** `LIKE` wildcards in a search are matched as themselves. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// RFC 5987 `attr-char`s are left as they are; everything else is percent-encoded as UTF-8.
function encodeRfc5987(text: string): string {
  return encodeURIComponent(text).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `Content-Disposition: attachment` with a safe file name: the name's last path segment with
 * control characters removed, an ASCII fallback (`filename`) holding only letters, digits, space
 * and `._-()`, and the full name percent-encoded (`filename*`). Nothing in it can end the header
 * or point outside the download folder.
 */
export function attachmentDisposition(fileName: string): string {
  const base = (fileName.split(/[/\\]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  const name = base === '' || base === '.' || base === '..' ? 'download' : base;
  const ascii = name.replace(/[^A-Za-z0-9 ._()-]/g, '_').replace(/^\.+/, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** A document row as the API returns it. */
export function toDocumentOut(row: DocumentRow): DocumentOut {
  return {
    id: row.id,
    kind: row.kind,
    recordType: row.recordType,
    format: row.format,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    label: row.label,
    uploader: { type: row.uploaderType, id: row.uploaderId },
    source: row.source,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What a download sends: the stored bytes and the headers that go with them. */
export interface DocumentFile {
  document: DocumentOut;
  body: Buffer;
  contentType: string;
  disposition: string;
}

/** The stored file of a visible document couldn't be read (a 500 with a reference ID). */
export class DocumentFileUnreadable extends Error {
  readonly code = 'document_file_unreadable';

  constructor() {
    super('The stored file could not be read.');
    this.name = 'DocumentFileUnreadable';
  }
}

export interface DocumentsServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'get'>;
  log?: Logger;
}

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The document was not found.');

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

function actorOf(caller: Caller): { actorType: 'user' | 'api_key'; actorId: string } {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

export class DocumentsService {
  private readonly db: Db;
  private readonly audit: Pick<AuditService, 'appendInTx'>;
  private readonly files: Pick<FileStore, 'get'>;
  private readonly log: Logger;

  constructor(deps: DocumentsServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.files = deps.files;
    this.log = deps.log ?? createLogger().child({ context: 'DocumentsService' });
  }

  /** The kinds whose record type the caller's role may view (D50; ownership cells never). The
   * service's own check, run before RLS's. */
  visibleKinds(caller: Caller): UploadKind[] {
    return UPLOAD_KINDS.filter((kind) => can(caller.role, DOCUMENT_RECORD_TYPE[kind], 'view'));
  }

  /** The labels at or below the caller's clearance (D51). The service's own check, run before RLS's. */
  visibleLabels(caller: Caller): Label[] {
    return LABELS.filter((label) => isVisible(caller.clearance, label));
  }

  async list(caller: Caller, query: unknown): Promise<Paged<DocumentOut>> {
    const q = parseDocumentListQuery(query);
    const kinds = this.visibleKinds(caller);
    const labels = this.visibleLabels(caller);
    if (kinds.length === 0 || labels.length === 0) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };

    const where = and(
      this.visibility(caller, kinds, labels),
      q.kind !== undefined ? eq(documents.kind, q.kind) : undefined,
      q.status !== undefined ? eq(documents.status, q.status) : undefined,
      q.source !== undefined ? eq(documents.source, q.source) : undefined,
      q.label !== undefined ? eq(documents.label, q.label) : undefined,
      q.q !== undefined ? ilike(documents.fileName, `%${escapeLike(q.q)}%`) : undefined,
    );
    const descending = q.sort.startsWith('-');
    const field = descending ? q.sort.slice(1) : q.sort;
    const dir = descending ? desc : asc;
    const order: SQL[] =
      field === 'fileName'
        ? [dir(sql`lower(${documents.fileName}) COLLATE "C"`), dir(documents.fileName), dir(documents.id)]
        : [dir(documents.createdAt), dir(documents.id)];

    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [counted] = await tx.select({ total: count() }).from(documents).where(where);
      const rows = await tx
        .select()
        .from(documents)
        .where(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return { items: rows.map(toDocumentOut), page: q.page, pageSize: q.pageSize, total: Number(counted?.total ?? 0) };
    });
  }

  async get(caller: Caller, id: string): Promise<DocumentDetail> {
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const row = await this.findVisible(tx, caller, id);
      if (!row) throw NOT_FOUND();
      const out: DocumentDetail = toDocumentOut(row);
      if (row.kind === 'asset_list') {
        const [latest] = await tx
          .select({ id: imports.id })
          .from(imports)
          .where(and(eq(imports.orgId, caller.orgId), eq(imports.documentId, row.id)))
          .orderBy(desc(imports.createdAt), desc(imports.id))
          .limit(1);
        out.importId = latest?.id ?? null;
      }
      return out;
    });
  }

  /** The file of a visible document, after its `document.downloaded` entry is written. */
  async download(caller: Caller, id: string): Promise<DocumentFile> {
    const row = await withOrgContext(this.db, contextOf(caller), (tx) => this.findVisible(tx, caller, id));
    if (!row) throw NOT_FOUND();

    let body: Buffer;
    try {
      body = await this.files.get(caller.orgId, row.storageKey);
    } catch (err) {
      this.log.error(
        { ...errorKind(err), orgId: caller.orgId, documentId: row.id },
        'the stored file of a document could not be read',
      );
      throw new DocumentFileUnreadable();
    }

    await withOrgContext(this.db, contextOf(caller), (tx) =>
      this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...actorOf(caller),
        action: 'document.downloaded',
        targetType: 'document',
        targetId: row.id,
        meta: { kind: row.kind, label: row.label },
      }),
    );

    return {
      document: toDocumentOut(row),
      body,
      contentType: FORMAT_CONTENT_TYPES[row.format],
      disposition: attachmentDisposition(row.fileName),
    };
  }

  // The caller's org, the upload kinds (never evidence), and the service's role and label check.
  private visibility(caller: Caller, kinds: readonly UploadKind[], labels: readonly Label[]): SQL {
    return and(
      eq(documents.orgId, caller.orgId),
      inArray(documents.kind, [...kinds]),
      inArray(documents.label, [...labels]),
    )!;
  }

  // One document the caller may see, or undefined. A malformed ID is the same as a missing one.
  private async findVisible(tx: Tx, caller: Caller, id: string): Promise<DocumentRow | undefined> {
    if (typeof id !== 'string' || !UUID.test(id)) return undefined;
    const kinds = this.visibleKinds(caller);
    const labels = this.visibleLabels(caller);
    if (kinds.length === 0 || labels.length === 0) return undefined;
    const [row] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), this.visibility(caller, kinds, labels)))
      .limit(1);
    return row;
  }
}
