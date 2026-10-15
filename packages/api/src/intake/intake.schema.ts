// The intake tables in Postgres (D13, D45.5, D73 "Documents" and "Intake"), created by the intake
// migration. Each is an org table (M0-009 rule): `org_id uuid not null`, RLS enabled and forced,
// the standard org-wall policy (src/db/rls.sql.ts). On `documents` and `imports` the SELECT policy
// also needs the context role to view the row's record type and the row's label to be at or below
// the context clearance (`app_role_views`, `app_label_visible`, src/db/role-visibility.sql.ts).
//
// - `documents`: every stored file, identified by its content (unique content hash per org).
// - `import_mappings`: the saved column mapping per source (D44).
// - `imports`: one asset-list import of a document, with what it read and what it did.
// - `push_batches`: the push API's batches, remembered so a repeat gets the first answer (D47).
import {
  DOCUMENT_KINDS,
  DOCUMENT_RECORD_TYPE,
  DOCUMENT_STATUSES,
  FILE_FORMATS,
  IMPORT_STATUSES,
  LABELS,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  type DocumentKind,
  type DocumentStatus,
  type FileFormat,
  type ImportMapping,
  type ImportStatus,
  type Label,
  type RecordType,
} from '@grc/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { apiKeys } from '../identity/api-keys.schema.js';
import { organization } from '../identity/schema.js';

/** Who stored a document: a person, a machine API key, or the system (S3-019's fast load). */
export const UPLOADER_TYPES = ['user', 'api_key', 'system'] as const;
export type UploaderType = (typeof UPLOADER_TYPES)[number];

/** The record type an import writes. */
export const IMPORT_RECORD_TYPES = ['asset'] as const;

/** At most 5 sample rows and 200 row errors are kept on an import. */
export const MAX_IMPORT_SAMPLE_ROWS = 5;
export const MAX_IMPORT_ERRORS = 200;

/** What an import run did. */
export interface ImportCounts {
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  linksAdded: number;
}

/** One refused row of an import: the row number, the field and a code, never the value (D163). */
export interface ImportRowError {
  row: number;
  field: string;
  code: string;
}

// `<column> IN ('a', 'b', …)` from a fixed list of lowercase names.
function inList(column: AnyPgColumn, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`intake.schema: unexpected list value '${v}'`);
  }
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

// `(kind, record_type) IN (('asset_list', 'asset'), …)`: a document carries its kind's record type (D71).
function kindRecordTypePairs(kind: AnyPgColumn, recordType: AnyPgColumn): SQL {
  const pairs = Object.entries(DOCUMENT_RECORD_TYPE).map(([k, type]) => {
    if (!/^[a-z_]+$/.test(k) || !/^[a-z_]+$/.test(type)) throw new Error('intake.schema: unexpected kind or type');
    return `('${k}', '${type}')`;
  });
  return sql`(${kind}, ${recordType}) IN (${sql.raw(pairs.join(', '))})`;
}

const documentRecordTypes = [...new Set(Object.values(DOCUMENT_RECORD_TYPE))];

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    kind: text('kind').$type<DocumentKind>().notNull(),
    recordType: text('record_type').$type<RecordType>().notNull(),
    format: text('format').$type<FileFormat>().notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentHash: text('content_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    label: text('label').$type<Label>().notNull(),
    uploaderType: text('uploader_type').$type<UploaderType>().notNull(),
    uploaderId: text('uploader_id').notNull(),
    source: text('source'),
    status: text('status').$type<DocumentStatus>().notNull().default('stored'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('documents_org_content_hash_unique').on(t.orgId, t.contentHash),
    unique('documents_org_id_id_unique').on(t.orgId, t.id),
    index('documents_org_created_idx').on(t.orgId, t.createdAt),
    check('documents_kind_check', inList(t.kind, DOCUMENT_KINDS)),
    check('documents_record_type_check', inList(t.recordType, documentRecordTypes)),
    check('documents_kind_record_type_check', kindRecordTypePairs(t.kind, t.recordType)),
    check('documents_format_check', inList(t.format, FILE_FORMATS)),
    check('documents_label_check', inList(t.label, LABELS)),
    check('documents_uploader_type_check', inList(t.uploaderType, UPLOADER_TYPES)),
    check('documents_status_check', inList(t.status, DOCUMENT_STATUSES)),
    check('documents_content_hash_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'documents_file_name_check',
      sql`char_length(${t.fileName}) BETWEEN 1 AND ${sql.raw(String(MAX_FILE_NAME_LENGTH))}`,
    ),
    check(
      'documents_size_bytes_check',
      sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= ${sql.raw(String(MAX_UPLOAD_BYTES))}`,
    ),
    check(
      'documents_source_check',
      sql`(${t.kind} = 'asset_list' AND ${t.source} IS NOT NULL) OR (${t.kind} <> 'asset_list' AND ${t.source} IS NULL)`,
    ),
  ],
);

export const importMappings = pgTable(
  'import_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    source: text('source').notNull(),
    fields: jsonb('fields').$type<ImportMapping['fields']>().notNull(),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('import_mappings_org_source_unique').on(t.orgId, t.source),
    check('import_mappings_version_check', sql`${t.version} >= 1`),
    check('import_mappings_fields_check', sql`jsonb_typeof(${t.fields}) = 'object'`),
  ],
);

export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    documentId: uuid('document_id').notNull(),
    source: text('source').notNull(),
    status: text('status').$type<ImportStatus>().notNull().default('reading'),
    label: text('label').$type<Label>().notNull(),
    recordType: text('record_type').$type<'asset'>().notNull().default('asset'),
    columns: jsonb('columns').$type<string[]>(),
    sample: jsonb('sample').$type<Array<Record<string, unknown>>>(),
    rowCount: integer('row_count'),
    mapping: jsonb('mapping').$type<ImportMapping['fields']>(),
    counts: jsonb('counts').$type<ImportCounts>(),
    errors: jsonb('errors').$type<ImportRowError[]>(),
    jobId: uuid('job_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The document must be in the same org (a foreign key check doesn't pass through RLS).
    foreignKey({
      name: 'imports_document_fk',
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    unique('imports_org_id_id_unique').on(t.orgId, t.id),
    index('imports_org_created_idx').on(t.orgId, t.createdAt),
    index('imports_org_document_idx').on(t.orgId, t.documentId),
    check('imports_status_check', inList(t.status, IMPORT_STATUSES)),
    check('imports_label_check', inList(t.label, LABELS)),
    check('imports_record_type_check', inList(t.recordType, IMPORT_RECORD_TYPES)),
    check('imports_row_count_check', sql`${t.rowCount} IS NULL OR ${t.rowCount} >= 0`),
    check('imports_columns_check', sql`${t.columns} IS NULL OR jsonb_typeof(${t.columns}) = 'array'`),
    check(
      'imports_sample_check',
      sql`${t.sample} IS NULL OR (jsonb_typeof(${t.sample}) = 'array' AND jsonb_array_length(${t.sample}) <= ${sql.raw(String(MAX_IMPORT_SAMPLE_ROWS))})`,
    ),
    check(
      'imports_errors_check',
      sql`${t.errors} IS NULL OR (jsonb_typeof(${t.errors}) = 'array' AND jsonb_array_length(${t.errors}) <= ${sql.raw(String(MAX_IMPORT_ERRORS))})`,
    ),
    check('imports_mapping_check', sql`${t.mapping} IS NULL OR jsonb_typeof(${t.mapping}) = 'object'`),
    check('imports_counts_check', sql`${t.counts} IS NULL OR jsonb_typeof(${t.counts}) = 'object'`),
  ],
);

export const pushBatches = pgTable(
  'push_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    source: text('source').notNull(),
    batchId: text('batch_id').notNull(),
    documentId: uuid('document_id'),
    importId: uuid('import_id'),
    rowCount: integer('row_count').notNull(),
    answer: jsonb('answer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('push_batches_org_source_batch_unique').on(t.orgId, t.source, t.batchId),
    // The document and import must be in the same org.
    foreignKey({
      name: 'push_batches_document_fk',
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: 'push_batches_import_fk',
      columns: [t.orgId, t.importId],
      foreignColumns: [imports.orgId, imports.id],
    }),
    index('push_batches_org_created_idx').on(t.orgId, t.createdAt),
    index('push_batches_org_import_idx').on(t.orgId, t.importId),
    check('push_batches_row_count_check', sql`${t.rowCount} >= 0`),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type ImportMappingRow = typeof importMappings.$inferSelect;
export type ImportRow = typeof imports.$inferSelect;
export type NewImportRow = typeof imports.$inferInsert;
export type PushBatchRow = typeof pushBatches.$inferSelect;
