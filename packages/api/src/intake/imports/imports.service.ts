// The asset-list imports (S3-006, D44, D51, D73): the paged list and one import, with what the
// worker read (columns, row count, 5 sample rows) and the mapping to start from.
// - Our code checks first (D45.3, D59): the route needs the `uploads` cell (the guard), then the
//   caller's role must view assets (the record type an import writes) and the import's label (the
//   document's) must be at or below the caller's clearance (D51). Every read then runs in the
//   caller's own org context, so Postgres RLS checks the org wall, the role and the label again
//   (D73). An import that fails either check is 404, the same as a missing one, and is missing from
//   the list and its `total`.
// - `mapping`: the source's saved mapping when every column it names is in this file's columns
//   (`mappingFrom: 'saved'`), else `suggestMapping(columns)` (`mappingFrom: 'suggested'`).
//   `savedMapping` names the source's saved mapping (its ID and version) whether it fits or not, so
//   a person can replace it.
import {
  ASSET_IMPORT_FIELDS,
  FILE_FORMATS,
  IMPORT_STATUSES,
  LABELS,
  can,
  isVisible,
  suggestMapping,
  type AssetImportField,
  type Label,
} from '@grc/shared';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { pageQuerySchema, type Paged } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { Caller } from '../../records/records.service.js';
import { documents, importMappings, imports, type ImportMappingRow, type ImportRow } from '../intake.schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A mapping's fields: our field -> the file's column. */
export const mappingFieldsSchema = z.object(
  Object.fromEntries(ASSET_IMPORT_FIELDS.map((f) => [f, z.string().optional()])) as Record<
    AssetImportField,
    z.ZodOptional<z.ZodString>
  >,
);
export type MappingFields = Partial<Record<AssetImportField, string>>;

const flatValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const importOutSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  fileName: z.string().nullable(),
  format: z.enum(FILE_FORMATS).nullable(),
  source: z.string(),
  status: z.enum(IMPORT_STATUSES),
  label: z.enum(LABELS),
  recordType: z.literal('asset'),
  columns: z.array(z.string()).nullable(),
  sample: z.array(z.record(z.string(), flatValueSchema)).nullable(),
  rowCount: z.int().nullable(),
  counts: z
    .object({ added: z.int(), updated: z.int(), unchanged: z.int(), failed: z.int(), linksAdded: z.int() })
    .nullable(),
  errors: z.array(z.object({ row: z.int(), field: z.string().nullable(), code: z.string() })).nullable(),
  mapping: mappingFieldsSchema,
  mappingFrom: z.enum(['saved', 'suggested']),
  savedMapping: z.object({ id: z.string(), version: z.int() }).nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImportOut = z.infer<typeof importOutSchema>;

export const pagedImportsSchema = z.object({
  items: z.array(importOutSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

/** `GET /api/v1/imports`'s query: paging, `status` and `source`; newest first. Unknown filters are
 * refused (400). */
export const importListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  status: z.enum(IMPORT_STATUSES).optional(),
  source: z.string().trim().min(1).max(100).optional(),
});
export type ImportListQuery = z.infer<typeof importListQuerySchema>;

/** The mapping to start from: the saved one when every column it names is in `columns`. */
export function mappingFor(
  columns: readonly string[] | null,
  saved: Pick<ImportMappingRow, 'fields'> | undefined,
): { mapping: MappingFields; mappingFrom: 'saved' | 'suggested' } {
  const have = columns ?? [];
  if (saved && columns !== null) {
    const named = Object.values(saved.fields).filter((c): c is string => typeof c === 'string');
    if (named.every((c) => have.includes(c))) return { mapping: { ...saved.fields }, mappingFrom: 'saved' };
  }
  return { mapping: suggestMapping(have), mappingFrom: 'suggested' };
}

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The import was not found.');

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

interface JoinedRow {
  imp: ImportRow;
  fileName: string | null;
  format: ImportOut['format'];
}

export class ImportsService {
  constructor(private readonly db: Db) {}

  /** The labels at or below the caller's clearance (D51); none when the role can't view assets. */
  visibleLabels(caller: Caller): Label[] {
    if (!can(caller.role, 'asset', 'view')) return [];
    return LABELS.filter((label) => isVisible(caller.clearance, label));
  }

  async list(caller: Caller, query: unknown): Promise<Paged<ImportOut>> {
    const q = importListQuerySchema.parse(query ?? {});
    const labels = this.visibleLabels(caller);
    if (labels.length === 0) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
    const where = and(
      this.visibility(caller, labels),
      q.status !== undefined ? eq(imports.status, q.status) : undefined,
      q.source !== undefined ? eq(imports.source, q.source) : undefined,
    )!;
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [counted] = await tx.select({ total: count() }).from(imports).where(where);
      const rows = await this.select(tx, caller, where)
        .orderBy(desc(imports.createdAt), desc(imports.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const saved = await this.savedMappings(
        tx,
        caller,
        rows.map((r) => r.imp.source),
      );
      return {
        items: rows.map((r) => toImportOut(r, saved.get(r.imp.source))),
        page: q.page,
        pageSize: q.pageSize,
        total: Number(counted?.total ?? 0),
      };
    });
  }

  async get(caller: Caller, id: string): Promise<ImportOut> {
    if (typeof id !== 'string' || !UUID.test(id)) throw NOT_FOUND();
    const labels = this.visibleLabels(caller);
    if (labels.length === 0) throw NOT_FOUND();
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [row] = await this.select(tx, caller, and(eq(imports.id, id), this.visibility(caller, labels))!).limit(1);
      if (!row) throw NOT_FOUND();
      const saved = await this.savedMappings(tx, caller, [row.imp.source]);
      return toImportOut(row, saved.get(row.imp.source));
    });
  }

  // The caller's org and the service's label check (RLS checks both again).
  private visibility(caller: Caller, labels: readonly Label[]): SQL {
    return and(eq(imports.orgId, caller.orgId), inArray(imports.label, [...labels]))!;
  }

  private select(tx: Tx, caller: Caller, where: SQL) {
    return tx
      .select({ imp: imports, fileName: documents.fileName, format: documents.format })
      .from(imports)
      .leftJoin(
        documents,
        and(
          eq(documents.orgId, caller.orgId),
          eq(documents.orgId, imports.orgId),
          eq(documents.id, imports.documentId),
        ),
      )
      .where(where)
      .$dynamic();
  }

  private async savedMappings(tx: Tx, caller: Caller, sources: string[]): Promise<Map<string, ImportMappingRow>> {
    const unique = [...new Set(sources)];
    if (unique.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(importMappings)
      .where(and(eq(importMappings.orgId, caller.orgId), inArray(importMappings.source, unique)));
    return new Map(rows.map((r) => [r.source, r]));
  }
}

function toImportOut(row: JoinedRow, saved: ImportMappingRow | undefined): ImportOut {
  const imp = row.imp;
  const { mapping, mappingFrom } = mappingFor(imp.columns, saved);
  return {
    id: imp.id,
    documentId: imp.documentId,
    fileName: row.fileName,
    format: row.format,
    source: imp.source,
    status: imp.status,
    label: imp.label,
    recordType: 'asset',
    columns: imp.columns,
    sample: (imp.sample as ImportOut['sample']) ?? null,
    rowCount: imp.rowCount,
    counts: imp.counts,
    errors: imp.errors,
    mapping,
    mappingFrom,
    savedMapping: saved ? { id: saved.id, version: saved.version } : null,
    createdBy: imp.createdBy,
    createdAt: imp.createdAt.toISOString(),
    updatedAt: imp.updatedAt.toISOString(),
  };
}
