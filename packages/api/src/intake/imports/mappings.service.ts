// The saved column mappings, one per source (S3-006, D44, D56): the org's list, one mapping, and
// saving one. The route needs the `uploads` cell (the guard); every read and write runs in the
// caller's own org context, so RLS keeps each org to its own mappings (D57). A mapping in another
// org is 404, the same as a missing one.
//
// Saving (`importMappingSchema` plus an optional `version`):
// - no saved mapping for the source and no `version`: it's created at version 1;
// - a saved mapping and the `version` it has: it's replaced, at version + 1;
// - anything else (a `version` that isn't the saved one's, a `version` with nothing saved, or no
//   `version` when one is saved): 409 `stale_version`, and nothing changes.
// The row and its `import_mapping.saved` entry commit in one transaction (D45.4). The entry holds
// the source and our field names mapped, never the file's column names (D163).
import { ASSET_IMPORT_FIELDS, importMappingSchema, type AssetImportField } from '@grc/shared';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError } from '../../common/errors.js';
import { pageQuerySchema, type Paged } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext } from '../../db/org-context.js';
import type { Caller } from '../../records/records.service.js';
import { importMappings, type ImportMappingRow } from '../intake.schema.js';
import { mappingFieldsSchema } from './imports.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `POST /api/v1/import-mappings`'s body. */
export const saveMappingBodySchema = importMappingSchema.extend({ version: z.int().min(1).optional() });
export type SaveMappingBody = z.infer<typeof saveMappingBodySchema>;

export const mappingOutSchema = z.object({
  id: z.string(),
  source: z.string(),
  fields: mappingFieldsSchema,
  version: z.int(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MappingOut = z.infer<typeof mappingOutSchema>;

export const pagedMappingsSchema = z.object({
  items: z.array(mappingOutSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

/** `GET /api/v1/import-mappings`'s query: paging and an optional `source`; sorted by source. */
export const mappingListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
  source: z.string().trim().min(1).max(100).optional(),
});

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The import mapping was not found.');
const STALE = (): ApiError =>
  new ApiError(
    409,
    'stale_version',
    'The saved mapping for this source changed since you opened it. Reload it and try again.',
  );

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

function actorOf(caller: Caller): { actorType: 'user' | 'api_key'; actorId: string } {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

/** Our field names a mapping fills, in our fields' order. */
export function mappedFieldNames(fields: Partial<Record<AssetImportField, string>>): AssetImportField[] {
  return ASSET_IMPORT_FIELDS.filter((f) => typeof fields[f] === 'string');
}

export function toMappingOut(row: ImportMappingRow): MappingOut {
  return {
    id: row.id,
    source: row.source,
    fields: { ...row.fields },
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface MappingsServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
}

export class MappingsService {
  private readonly db: Db;
  private readonly audit: Pick<AuditService, 'appendInTx'>;

  constructor(deps: MappingsServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
  }

  async list(caller: Caller, query: unknown): Promise<Paged<MappingOut>> {
    const q = mappingListQuerySchema.parse(query ?? {});
    const where = and(
      eq(importMappings.orgId, caller.orgId),
      q.source !== undefined ? eq(importMappings.source, q.source) : undefined,
    );
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [counted] = await tx.select({ total: count() }).from(importMappings).where(where);
      const rows = await tx
        .select()
        .from(importMappings)
        .where(where)
        .orderBy(asc(sql`lower(${importMappings.source}) COLLATE "C"`), asc(importMappings.source))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return { items: rows.map(toMappingOut), page: q.page, pageSize: q.pageSize, total: Number(counted?.total ?? 0) };
    });
  }

  async get(caller: Caller, id: string): Promise<MappingOut> {
    if (typeof id !== 'string' || !UUID.test(id)) throw NOT_FOUND();
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [row] = await tx
        .select()
        .from(importMappings)
        .where(and(eq(importMappings.orgId, caller.orgId), eq(importMappings.id, id)))
        .limit(1);
      if (!row) throw NOT_FOUND();
      return toMappingOut(row);
    });
  }

  /** Creates or replaces the source's mapping (see the top of the file); audited. */
  async save(caller: Caller, body: unknown): Promise<MappingOut> {
    const input = saveMappingBodySchema.parse(body);
    const fields = Object.fromEntries(
      ASSET_IMPORT_FIELDS.flatMap((f) => (input.fields[f] !== undefined ? [[f, input.fields[f]]] : [])),
    ) as ImportMappingRow['fields'];

    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [existing] = await tx
        .select()
        .from(importMappings)
        .where(and(eq(importMappings.orgId, caller.orgId), eq(importMappings.source, input.source)))
        .for('update')
        .limit(1);

      let row: ImportMappingRow | undefined;
      if (!existing) {
        if (input.version !== undefined) throw STALE();
        [row] = await tx
          .insert(importMappings)
          .values({
            orgId: caller.orgId,
            source: input.source,
            fields,
            version: 1,
            createdBy: caller.userId,
            updatedBy: caller.userId,
          })
          .onConflictDoNothing({ target: [importMappings.orgId, importMappings.source] })
          .returning();
        // Another save created it first.
        if (!row) throw STALE();
      } else {
        if (input.version !== existing.version) throw STALE();
        [row] = await tx
          .update(importMappings)
          .set({ fields, version: existing.version + 1, updatedBy: caller.userId, updatedAt: new Date() })
          .where(
            and(
              eq(importMappings.orgId, caller.orgId),
              eq(importMappings.id, existing.id),
              eq(importMappings.version, existing.version),
            ),
          )
          .returning();
        if (!row) throw STALE();
      }

      await this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...actorOf(caller),
        action: 'import_mapping.saved',
        targetType: 'import_mapping',
        targetId: row.id,
        ...(existing ? { before: { source: existing.source, fields: mappedFieldNames(existing.fields) } } : {}),
        after: { source: row.source, fields: mappedFieldNames(row.fields) },
        meta: { source: row.source },
      });
      return toMappingOut(row);
    });
  }
}
