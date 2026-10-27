// Path A, vector search (S6-003; D13, D23, D45.3, D48, D51, D52.1, D71, D73, D163): the passages
// closest in meaning to a question, among only what the asker may see.
//   1. The question is embedded with bge-m3 (EMBEDDER): one vector of exactly 1,024 numbers.
//   2. In one transaction in the asker's own org context (`withOrgContext`), with
//      `hnsw.iterative_scan` on for that transaction only (D71), one query finds the 20 chunks with
//      the smallest cosine distance, among chunks of the asker's org that have a vector and whose
//      document isn't `removed`, each with its document's name and kind. The org's partition is
//      picked by `org_id`, so its HNSW cosine index does the ordering; the iterative scan keeps
//      reading the index while row security hides chunks, so up to 20 visible ones come back
//      whenever that many exist. The index's relaxed order is put back in exact order by distance
//      (pgvector's materialized CTE). A second query reads the visible `chunk_records` rows of
//      those chunks: the records each one names.
//   3. Checked twice (D45.3): row security on `chunks`, `documents` and `chunk_records` filters
//      first (the org wall, the role's view of the record type, the label against the clearance),
//      then our code drops any row of another org, of a record type the role doesn't view, with a
//      label above the clearance, of a removed document, or whose distance isn't a number.
// The embedder failing rejects with its `AiFailure` (`unavailable`, `timed_out`, or
// `invalid_output` for a vector of the wrong size); the caller answers `assistant_unavailable`.
// Logs (D163): IDs, counts, times, the model and codes only. Never the question, a passage, a
// document name or a vector.
import { SEARCH_LIMITS, isDocumentKind, isLabel, isRecordVisible, type Viewer } from '@grc/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { AiFailure, AiInputError } from '../../ai/ai-failure.js';
import { EMBEDDING_DIMENSIONS, type Embedder } from '../../ai/embedder.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import { documents } from '../../intake/intake.schema.js';
import { CHUNK_RECORD_KINDS, CHUNK_RECORD_TYPES, chunkRecords, chunks } from '../../processing/processing.schema.js';
import type { SearchCaller, VectorPassage, VectorSearch, VectorSearchResult } from '../retrieval.js';

/** The iterative scan's mode for the transaction: relaxed order reads more of the index for better
 * recall, and the query puts the results back in exact order (D71). */
export const HNSW_ITERATIVE_SCAN = 'relaxed_order';

export interface PgVectorSearchDeps {
  db: Db;
  embedder: Pick<Embedder, 'embed'>;
  log?: Logger;
  /** The passages returned, closest first; SEARCH_LIMITS.vectorPassages by default. */
  limit?: number;
}

/** A row of the chunks query, as Postgres returns it. */
type NearestRow = {
  chunk_id: string;
  org_id: string;
  document_id: string;
  position: number;
  text: string;
  token_count: number | string;
  label: string;
  record_type: string;
  document_name: string;
  document_kind: string;
  document_status: string;
  document_label: string;
  document_record_type: string;
  distance: number | string | null;
};

/** A row of the records query. */
type ChunkRecordRow = {
  orgId: string;
  chunkId: string;
  recordId: string;
  recordKind: string;
  chunkRecordType: string;
  label: string;
};

const isChunkRecordType = (v: string): boolean => (CHUNK_RECORD_TYPES as readonly string[]).includes(v);
const isChunkRecordKind = (v: string): boolean => (CHUNK_RECORD_KINDS as readonly string[]).includes(v);

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** The vector as pgvector's text form, `[0.1,0.2,…]`, after checking its size and numbers. */
function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((n) => String(n)).join(',')}]`;
}

function rightSize(vector: unknown): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** 1 minus the cosine distance, kept within -1 to 1; null when the distance isn't a number (a
 * vector with no length has none). */
function similarityOf(distance: number | string | null): number | null {
  if (distance === null) return null;
  const d = typeof distance === 'number' ? distance : Number(distance);
  if (!Number.isFinite(d)) return null;
  return Math.min(1, Math.max(-1, 1 - d));
}

export class PgVectorSearch implements VectorSearch {
  private readonly db: Db;
  private readonly embedder: Pick<Embedder, 'embed'>;
  private readonly log: Logger;
  private readonly limit: number;

  constructor(deps: PgVectorSearchDeps) {
    this.db = deps.db;
    this.embedder = deps.embedder;
    this.log = (deps.log ?? createLogger()).child({ context: 'VectorSearch' });
    const limit = deps.limit ?? SEARCH_LIMITS.vectorPassages;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('PgVectorSearch: limit must be a whole number from 1');
    this.limit = limit;
  }

  async search(caller: SearchCaller, question: string): Promise<VectorSearchResult> {
    const words = typeof question === 'string' ? question.trim() : '';
    if (words.length < 1 || words.length > SEARCH_LIMITS.questionMaxLength) {
      throw new AiInputError(`The question must be 1 to ${SEARCH_LIMITS.questionMaxLength} characters.`);
    }
    const orgId = caller.orgId.toLowerCase();

    const embedStartedAt = performance.now();
    const vector = await this.embedQuestion(words);
    const embeddingMs = elapsed(embedStartedAt);

    const searchStartedAt = performance.now();
    const viewer: Viewer = { role: caller.role, clearance: caller.clearance };
    const found = await withOrgContext(
      this.db,
      { orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance },
      async (tx) => {
        await tx.execute(sql`SELECT set_config('hnsw.iterative_scan', ${HNSW_ITERATIVE_SCAN}, true)`);
        const nearest = await this.nearestChunks(tx, orgId, vector);
        const kept = nearest.filter((row) => this.visibleChunk(row, orgId, viewer));
        const records = kept.length === 0 ? [] : await this.chunkRecordsOf(tx, orgId, kept);
        return { nearest, kept, records };
      },
    );
    const searchMs = elapsed(searchStartedAt);

    const keptIds = new Set(found.kept.map((row) => row.chunk_id));
    const recordIds = new Map<string, string[]>();
    let droppedRecords = 0;
    for (const row of found.records) {
      if (!keptIds.has(row.chunkId) || !this.visibleChunkRecord(row, orgId, viewer)) {
        droppedRecords += 1;
        continue;
      }
      const list = recordIds.get(row.chunkId) ?? [];
      if (!list.includes(row.recordId)) list.push(row.recordId);
      recordIds.set(row.chunkId, list);
    }

    const passages: VectorPassage[] = [];
    for (const row of found.kept) {
      const similarity = similarityOf(row.distance);
      if (similarity === null || !isDocumentKind(row.document_kind) || !isLabel(row.label)) continue;
      if (!isChunkRecordType(row.record_type)) continue;
      const tokenCount = Number(row.token_count);
      if (!Number.isInteger(tokenCount) || tokenCount < 1) continue;
      passages.push({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        documentName: row.document_name,
        documentKind: row.document_kind,
        position: row.position,
        text: row.text,
        label: row.label,
        similarity,
        recordType: row.record_type as VectorPassage['recordType'],
        recordIds: recordIds.get(row.chunk_id) ?? [],
        tokenCount,
      });
      if (passages.length >= this.limit) break;
    }

    const droppedChunks = found.nearest.length - passages.length;
    if (droppedChunks > 0 || droppedRecords > 0) {
      // Row security already hides these; our own check disagreeing is worth a look (IDs only).
      this.log.warn(
        { orgId, code: 'api_check_dropped', droppedChunks, droppedRecords },
        'vector search dropped rows that row security returned',
      );
    }
    this.log.info(
      {
        orgId,
        callerKind: caller.kind,
        passages: passages.length,
        records: found.records.length - droppedRecords,
        embeddingMs,
        searchMs,
      },
      'vector search done',
    );
    return { passages, timings: { embeddingMs, searchMs } };
  }

  // One vector of 1,024 finite numbers for the question; anything else is `invalid_output`.
  private async embedQuestion(question: string): Promise<number[]> {
    const answer = await this.embedder.embed([question]);
    const vector = answer.vectors.length === 1 ? answer.vectors[0] : undefined;
    if (!rightSize(vector)) {
      this.log.warn(
        { model: answer.model, code: 'invalid_output', vectors: answer.vectors.length },
        'the question embedding was refused',
      );
      throw new AiFailure('invalid_output', { model: answer.model, elapsedMs: answer.elapsedMs });
    }
    return vector;
  }

  // The closest chunks of the org that have a vector and whose document isn't removed, with their
  // document, closest first (ties by chunk ID, so the same data gives the same order). The inner
  // query is the index's ordered scan; the outer one restores exact order (`+ 0` stops Postgres 17+
  // from trusting the inner order).
  private async nearestChunks(tx: Tx, orgId: string, vector: readonly number[]): Promise<NearestRow[]> {
    const literal = vectorLiteral(vector);
    const res = await tx.execute<NearestRow>(sql`
      WITH nearest AS MATERIALIZED (
        SELECT c.id AS chunk_id,
               c.org_id,
               c.document_id,
               c."position",
               c."text",
               c.token_count,
               c.label,
               c.record_type,
               d.file_name AS document_name,
               d.kind AS document_kind,
               d.status AS document_status,
               d.label AS document_label,
               d.record_type AS document_record_type,
               c.embedding <=> ${literal}::vector AS distance
          FROM ${chunks} AS c
          JOIN ${documents} AS d ON d.org_id = c.org_id AND d.id = c.document_id
         WHERE c.org_id = ${orgId}::uuid
           AND d.org_id = ${orgId}::uuid
           AND c.embedding IS NOT NULL
           AND d.status <> 'removed'
         ORDER BY distance
         LIMIT ${this.limit}
      )
      SELECT * FROM nearest ORDER BY distance + 0, chunk_id`);
    return res.rows;
  }

  // The visible `chunk_records` rows of the kept chunks, in chunk and record ID order.
  private async chunkRecordsOf(tx: Tx, orgId: string, kept: readonly NearestRow[]): Promise<ChunkRecordRow[]> {
    return tx
      .select({
        orgId: chunkRecords.orgId,
        chunkId: chunkRecords.chunkId,
        recordId: chunkRecords.recordId,
        recordKind: chunkRecords.recordKind,
        chunkRecordType: chunkRecords.chunkRecordType,
        label: chunkRecords.label,
      })
      .from(chunkRecords)
      .where(
        and(
          eq(chunkRecords.orgId, orgId),
          inArray(
            chunkRecords.chunkId,
            kept.map((row) => row.chunk_id),
          ),
        ),
      )
      .orderBy(asc(chunkRecords.chunkId), asc(chunkRecords.recordId));
  }

  // The API's own check of a chunk row (D45.3): the asker's org, a record type the role views and a
  // label at or below the clearance, for the chunk and its document, and a document not removed.
  private visibleChunk(row: NearestRow, orgId: string, viewer: Viewer): boolean {
    if (row.org_id !== orgId || row.document_status === 'removed') return false;
    if (!isChunkRecordType(row.record_type) || !isLabel(row.label)) return false;
    return (
      isRecordVisible(viewer, { recordType: row.record_type, label: row.label }) &&
      isRecordVisible(viewer, { recordType: row.document_record_type, label: row.document_label })
    );
  }

  // The API's own check of a chunk-to-record row: the asker's org, the chunk's type and label, and a
  // kind of record the role views.
  private visibleChunkRecord(row: ChunkRecordRow, orgId: string, viewer: Viewer): boolean {
    if (row.orgId !== orgId || !isChunkRecordKind(row.recordKind)) return false;
    return (
      isRecordVisible(viewer, { recordType: row.chunkRecordType, label: row.label }) &&
      isRecordVisible(viewer, { recordType: row.recordKind, label: row.label })
    );
  }
}
