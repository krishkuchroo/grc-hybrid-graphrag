// The processing tables in Postgres (S4-002; D24, D38, D71, D73), created by the processing
// migration. Each is an org table (M0-009 rule): `org_id uuid not null`, RLS enabled and forced,
// the org-wall policy (src/db/rls.sql.ts), and a SELECT policy that also checks the role and the
// label (D73: "Documents, chunks and findings also check role and label").
//
// - `chunks`: each document's text in windows of at most 500 tokens, each starting 50 tokens before
//   the previous one ended (D71), with its vector (`vector(1024)`, null until embedded) and Gemma's
//   stored extraction answer. One per document and position. List-partitioned by org: one partition
//   per org, each with its own HNSW cosine index on the vector, made by `createChunkPartition`
//   (./chunk-partition.ts). SELECT needs `app_role_views(record_type)` and
//   `app_label_visible(label)` (src/db/role-visibility.sql.ts).
// - `chunk_records`: which records a chunk names, one row per chunk and record. The chunk's record
//   type and label come with it through a foreign key, so they always equal the chunk's. SELECT
//   needs the chunk checks plus `app_role_views(record_kind)`.
// - `review_findings`: one row per AI proposal (D24, D38). The key is unique per org, so a repeat
//   proposal adds nothing (insert with `onConflictDoNothing`). SELECT needs the role's D50 "Review
//   queue" cell (`app_review_queue_visible()`: Admin and Analyst) and `app_label_visible(label)`.
//   grc_app may insert and update, never delete: findings are kept (D24).
//
// The partitioning and the per-partition HNSW indexes live in the migration; Drizzle doesn't model
// them, and doesn't need to for queries on `chunks`.
import { LABELS, type Label } from '@grc/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organization } from '../identity/schema.js';
import { documents } from '../intake/intake.schema.js';

/** The vector size: bge-m3 makes 1024 numbers (D31, D71). */
export const CHUNK_EMBEDDING_DIMENSIONS = 1024;

/** At most 500 tokens in a chunk (D71). */
export const MAX_CHUNK_TOKENS = 500;

/** A chunk's stage (S4 shared notes, "Chunks"). */
export const CHUNK_STAGES = ['read', 'embedded', 'extracted', 'resolved', 'failed'] as const;
export type ChunkStage = (typeof CHUNK_STAGES)[number];

/** The record types a chunk carries: its document's (S3's document record types). */
export const CHUNK_RECORD_TYPES = ['asset', 'policy', 'incident', 'audit_finding', 'evidence'] as const;
export type ChunkRecordType = (typeof CHUNK_RECORD_TYPES)[number];

/** The kinds of record a chunk can name: the graph's record kinds that have a D50 row. */
export const CHUNK_RECORD_KINDS = [
  'asset',
  'risk',
  'control',
  'policy',
  'incident',
  'evidence',
  'audit_finding',
] as const;
export type ChunkRecordKind = (typeof CHUNK_RECORD_KINDS)[number];

/** A review finding's kind (S4 shared notes, "`review_findings`"). */
export const REVIEW_FINDING_KINDS = ['link', 'record', 'duplicate', 'mapping'] as const;
export type ReviewFindingKind = (typeof REVIEW_FINDING_KINDS)[number];

/** A review finding's status: `pending` and `live` are set by processing; the rest only by S5. */
export const REVIEW_FINDING_STATUSES = ['pending', 'live', 'approved', 'rejected', 'removed'] as const;
export type ReviewFindingStatus = (typeof REVIEW_FINDING_STATUSES)[number];

/** The three rule checks (D39) a link finding can list as failed. */
export const REVIEW_RULE_CHECKS = ['same_sentence', 'ontology_fit', 'both_ends_known'] as const;
export type ReviewRuleCheck = (typeof REVIEW_RULE_CHECKS)[number];

/** A finding key is 1 to 512 characters. */
export const MAX_FINDING_KEY_LENGTH = 512;

// `<column> IN ('a', 'b', …)` from a fixed list of lowercase names.
function inList(column: AnyPgColumn, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`processing.schema: unexpected list value '${v}'`);
  }
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

// `ARRAY['a', 'b', …]::text[]` from a fixed list of lowercase names.
function textArray(values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`processing.schema: unexpected list value '${v}'`);
  }
  return sql.raw(`ARRAY[${values.map((v) => `'${v}'`).join(', ')}]::text[]`);
}

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').notNull().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    documentId: uuid('document_id').notNull(),
    /** The chunk's place in its document, from 0. */
    position: integer('position').notNull(),
    /** An exact slice of the document's text: `text.slice(startOffset, endOffset)`. */
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    /** The document's record type and label (D51: what comes from a document inherits its label). */
    recordType: text('record_type').$type<ChunkRecordType>().notNull(),
    label: text('label').$type<Label>().notNull(),
    /** bge-m3's vector of the text; null until embedded. Never logged or shown (D163). */
    embedding: vector('embedding', { dimensions: CHUNK_EMBEDDING_DIMENSIONS }),
    stage: text('stage').$type<ChunkStage>().notNull().default('read'),
    /** Gemma's answer for the chunk as kept by the lenient reader (S4-001); null until extracted. */
    extraction: jsonb('extraction').$type<Record<string, unknown>>(),
    extractionModel: text('extraction_model'),
    extractionPromptVersion: text('extraction_prompt_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'chunks_org_id_id_pk', columns: [t.orgId, t.id] }),
    unique('chunks_org_document_position_unique').on(t.orgId, t.documentId, t.position),
    unique('chunks_org_id_type_label_unique').on(t.orgId, t.id, t.recordType, t.label),
    // The document must be in the same org (a foreign key check doesn't pass through RLS).
    foreignKey({
      name: 'chunks_document_fk',
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    check('chunks_position_check', sql`${t.position} >= 0`),
    check('chunks_text_check', sql`char_length(${t.text}) >= 1`),
    check('chunks_token_count_check', sql`${t.tokenCount} BETWEEN 1 AND ${sql.raw(String(MAX_CHUNK_TOKENS))}`),
    check('chunks_offsets_check', sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset}`),
    check('chunks_record_type_check', inList(t.recordType, CHUNK_RECORD_TYPES)),
    check('chunks_label_check', inList(t.label, LABELS)),
    check('chunks_stage_check', inList(t.stage, CHUNK_STAGES)),
    check('chunks_embedded_check', sql`${t.stage} IN ('read', 'failed') OR ${t.embedding} IS NOT NULL`),
    check('chunks_extracted_check', sql`${t.stage} <> 'extracted' OR ${t.extraction} IS NOT NULL`),
    check(
      'chunks_extraction_check',
      sql`${t.extraction} IS NULL OR (jsonb_typeof(${t.extraction}) = 'object' AND ${t.extractionModel} IS NOT NULL AND ${t.extractionPromptVersion} IS NOT NULL)`,
    ),
  ],
);

export const chunkRecords = pgTable(
  'chunk_records',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    chunkId: uuid('chunk_id').notNull(),
    /** The named record's internal ID (the same in Neo4j). */
    recordId: uuid('record_id').notNull(),
    recordKind: text('record_kind').$type<ChunkRecordKind>().notNull(),
    /** The chunk's record type and label, the same as the chunk's (foreign key). */
    chunkRecordType: text('chunk_record_type').$type<ChunkRecordType>().notNull(),
    label: text('label').$type<Label>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'chunk_records_pk', columns: [t.orgId, t.chunkId, t.recordId] }),
    foreignKey({
      name: 'chunk_records_chunk_fk',
      columns: [t.orgId, t.chunkId, t.chunkRecordType, t.label],
      foreignColumns: [chunks.orgId, chunks.id, chunks.recordType, chunks.label],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('chunk_records_org_record_idx').on(t.orgId, t.recordId),
    check('chunk_records_record_kind_check', inList(t.recordKind, CHUNK_RECORD_KINDS)),
  ],
);

export const reviewFindings = pgTable(
  'review_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    kind: text('kind').$type<ReviewFindingKind>().notNull(),
    status: text('status').$type<ReviewFindingStatus>().notNull().default('pending'),
    /** Unique per org: a repeat proposal finds the first one and adds nothing. */
    findingKey: text('finding_key').notNull(),
    /** The proposal itself, in the kind's shape (S4-001's finding schemas). */
    proposal: jsonb('proposal').$type<Record<string, unknown>>().notNull(),
    /** The source, for `link` (document, chunk, sentence) and `record` (document) findings. */
    documentId: uuid('document_id'),
    chunkId: uuid('chunk_id'),
    sentence: text('sentence'),
    failedChecks: text('failed_checks')
      .array()
      .$type<ReviewRuleCheck[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The document's label; for `duplicate` and `mapping`, the higher of the two records'. */
    label: text('label').$type<Label>().notNull(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    /** The Analyst's decision (S5): who, when and a note. */
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('review_findings_org_key_unique').on(t.orgId, t.findingKey),
    unique('review_findings_org_id_id_unique').on(t.orgId, t.id),
    // The document and the chunk must be in the same org.
    foreignKey({
      name: 'review_findings_document_fk',
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: 'review_findings_chunk_fk',
      columns: [t.orgId, t.chunkId],
      foreignColumns: [chunks.orgId, chunks.id],
    }),
    index('review_findings_org_status_created_idx').on(t.orgId, t.status, t.createdAt),
    index('review_findings_org_document_idx').on(t.orgId, t.documentId),
    index('review_findings_org_chunk_idx').on(t.orgId, t.chunkId),
    check('review_findings_kind_check', inList(t.kind, REVIEW_FINDING_KINDS)),
    check('review_findings_status_check', inList(t.status, REVIEW_FINDING_STATUSES)),
    check(
      'review_findings_key_check',
      sql`char_length(${t.findingKey}) BETWEEN 1 AND ${sql.raw(String(MAX_FINDING_KEY_LENGTH))}`,
    ),
    check('review_findings_proposal_check', sql`jsonb_typeof(${t.proposal}) = 'object'`),
    check('review_findings_failed_checks_check', sql`${t.failedChecks} <@ ${textArray(REVIEW_RULE_CHECKS)}`),
    check('review_findings_label_check', inList(t.label, LABELS)),
    check(
      'review_findings_source_check',
      sql`(${t.kind} = 'link' AND ${t.documentId} IS NOT NULL AND ${t.chunkId} IS NOT NULL AND ${t.sentence} IS NOT NULL)
        OR (${t.kind} = 'record' AND ${t.documentId} IS NOT NULL)
        OR (${t.kind} IN ('duplicate', 'mapping') AND ${t.documentId} IS NULL AND ${t.chunkId} IS NULL AND ${t.sentence} IS NULL)`,
    ),
    check(
      'review_findings_model_check',
      sql`${t.kind} = 'duplicate' OR (${t.model} IS NOT NULL AND ${t.promptVersion} IS NOT NULL)`,
    ),
    check('review_findings_decision_check', sql`(${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`),
  ],
);

export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;
export type ChunkRecordRow = typeof chunkRecords.$inferSelect;
export type NewChunkRecordRow = typeof chunkRecords.$inferInsert;
export type ReviewFindingRow = typeof reviewFindings.$inferSelect;
export type NewReviewFindingRow = typeof reviewFindings.$inferInsert;
