// A clear document's other chunks (D260, Q-ASK-4), in hybrid and vector mode: when one document
// clearly matches the question, the rest of it goes into the context too, so an answer that needs
// several of its passages (a policy's controls, an asset's incidents) sees them all.
// - The rule (`clearDocumentOf`, pure): the document that holds at least 3 of the first 5 kept
//   passages, in fused order, and more of them than any other document. A tie gives none.
// - The read (`readDocumentChunks`): the document's other chunks, in one query in the asker's own
//   org context, with Path A's checks (../vector/vector-search.service.ts): the asker's org, a record
//   type the role views and a label at or below the clearance (the chunk's and its document's), the
//   document not removed, then row security on top. Each comes with its visible `chunk_records`.
//   Our code checks every row again with the entity filter's passage check (./entity-filter.ts).
// - The adding (`addDocumentChunks`, pure): in position order, after the fused passages, while the
//   passages stay at or under 24 in all and within the token budget; the first that doesn't fit
//   ends it. They are numbered after the fused sources and count towards the label, but are not
//   search results.
// Logs: none here; the caller logs counts only (D163).
import { SEARCH_LIMITS, isDocumentKind, isLabel, isRecordVisible, type Label, type Role } from '@grc/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import { documents } from '../../intake/intake.schema.js';
import { CHUNK_RECORD_KINDS, CHUNK_RECORD_TYPES, chunkRecords, chunks } from '../../processing/processing.schema.js';
import type { SearchCaller, VectorPassage } from '../retrieval.js';
import { passageVisible, type DocumentFacts } from './entity-filter.js';
import { passageKey, type ContextLimits, type ContextSelection, type FusedEntry } from './fusion.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isChunkRecordType = (v: unknown): v is VectorPassage['recordType'] =>
  typeof v === 'string' && (CHUNK_RECORD_TYPES as readonly string[]).includes(v);
const isChunkRecordKind = (v: unknown): boolean =>
  typeof v === 'string' && (CHUNK_RECORD_KINDS as readonly string[]).includes(v);

/**
 * The clear document among the kept entries: the one holding at least `share` of the first `lead`
 * kept passages (in fused order) and more of them than any other. Null when there is none.
 */
export function clearDocumentOf(
  kept: readonly FusedEntry[],
  lead: number = SEARCH_LIMITS.clearDocumentLead,
  share: number = SEARCH_LIMITS.clearDocumentShare,
): string | null {
  const counts = new Map<string, number>();
  let seen = 0;
  for (const entry of kept) {
    if (seen >= lead) break;
    if (entry.item.type !== 'passage') continue;
    seen += 1;
    const id = entry.item.passage.documentId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      best = id;
      bestCount = n;
      tied = false;
    } else if (n === bestCount) {
      tied = true;
    }
  }
  return best !== null && !tied && bestCount >= share ? best : null;
}

/** A row of the document's chunks query, as Postgres returns it. */
type DocumentChunkRow = {
  chunk_id: string;
  org_id: string;
  document_id: string;
  position: number | string;
  text: string;
  token_count: number | string;
  label: string;
  record_type: string;
  document_name: string;
  document_kind: string;
  document_status: string;
  document_label: string;
  document_record_type: string;
  records: unknown;
};

interface ChunkRecordCell {
  orgId?: unknown;
  recordId?: unknown;
  recordKind?: unknown;
  chunkRecordType?: unknown;
  label?: unknown;
}

/** The records a chunk names, as the asker may see them (the API's own check of Path A). */
function visibleRecordIds(row: DocumentChunkRow, orgId: string, viewer: { role: Role; clearance: Label }): string[] {
  const cells = Array.isArray(row.records) ? (row.records as ChunkRecordCell[]) : [];
  const ids: string[] = [];
  for (const cell of cells) {
    if (typeof cell !== 'object' || cell === null) continue;
    const { orgId: cellOrg, recordId, recordKind, chunkRecordType, label } = cell;
    if (cellOrg !== orgId || typeof recordId !== 'string' || !UUID.test(recordId)) continue;
    if (!isChunkRecordKind(recordKind) || !isLabel(label) || typeof chunkRecordType !== 'string') continue;
    const visible =
      isRecordVisible(viewer, { recordType: chunkRecordType, label }) &&
      isRecordVisible(viewer, { recordType: recordKind as string, label });
    if (visible && !ids.includes(recordId)) ids.push(recordId);
  }
  return ids;
}

/**
 * The document's chunks other than `exclude`, in position order, at most `limit`, as the asker may
 * see them. Read in one query in the asker's org context; every row is checked again by our code.
 */
export async function readDocumentChunks(
  db: Db,
  caller: SearchCaller,
  documentId: string,
  exclude: readonly string[],
  limit: number,
): Promise<VectorPassage[]> {
  if (!UUID.test(documentId) || !Number.isInteger(limit) || limit < 1) return [];
  const orgId = caller.orgId.toLowerCase();
  const skip = exclude.filter((id) => UUID.test(id));
  const ctx = { orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
  const rows = await withOrgContext(db, ctx, async (tx) => {
    const res = await tx.execute<DocumentChunkRow>(sql`
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
             (SELECT coalesce(json_agg(json_build_object(
                       'orgId', cr.org_id,
                       'recordId', cr.record_id,
                       'recordKind', cr.record_kind,
                       'chunkRecordType', cr.chunk_record_type,
                       'label', cr.label) ORDER BY cr.record_id), '[]'::json)
                FROM ${chunkRecords} AS cr
               WHERE cr.org_id = c.org_id AND cr.chunk_id = c.id) AS records
        FROM ${chunks} AS c
        JOIN ${documents} AS d ON d.org_id = c.org_id AND d.id = c.document_id
       WHERE c.org_id = ${orgId}::uuid
         AND d.org_id = ${orgId}::uuid
         AND c.document_id = ${documentId}::uuid
         AND d.status <> 'removed'
         ${
           skip.length > 0
             ? sql`AND c.id NOT IN (${sql.join(
                 skip.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`
             : sql``
         }
       ORDER BY c."position", c.id
       LIMIT ${limit}`);
    return res.rows;
  });

  const viewer = { role: caller.role, clearance: caller.clearance };
  const out: VectorPassage[] = [];
  for (const row of rows) {
    const position = Number(row.position);
    const tokenCount = Number(row.token_count);
    if (!Number.isInteger(position) || position < 0 || !Number.isInteger(tokenCount) || tokenCount < 1) continue;
    if (!isDocumentKind(row.document_kind) || !isLabel(row.label) || !isLabel(row.document_label)) continue;
    if (!isChunkRecordType(row.record_type) || !isChunkRecordType(row.document_record_type)) continue;
    const passage: VectorPassage = {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentName: row.document_name,
      documentKind: row.document_kind,
      position,
      text: row.text,
      label: row.label,
      // Not found by meaning: it is in the context only as part of its document.
      similarity: 0,
      recordType: row.record_type,
      recordIds: visibleRecordIds(row, orgId, viewer),
      tokenCount,
    };
    const facts: DocumentFacts = {
      id: row.document_id,
      orgId: row.org_id,
      recordType: row.document_record_type,
      label: row.document_label,
      status: row.document_status as DocumentFacts['status'],
    };
    if (passageVisible(viewer, orgId, passage, facts)) out.push(passage);
  }
  return out;
}

/** The selection with the document's chunks added (see the top of the file), and how many were. */
export function addDocumentChunks(
  selection: ContextSelection,
  chunksOfDocument: readonly VectorPassage[],
  limits: Pick<ContextLimits, 'passageTokens'>,
  maxPassages: number = SEARCH_LIMITS.contextPassagesMax,
): { selection: ContextSelection; added: number } {
  const keptChunkIds = new Set(
    selection.kept.flatMap((entry) => (entry.item.type === 'passage' ? [entry.item.passage.chunkId] : [])),
  );
  let passages = keptChunkIds.size;
  let tokens = selection.passageTokens;
  const added: FusedEntry[] = [];
  const ordered = [...chunksOfDocument].sort((a, b) => a.position - b.position);
  for (const passage of ordered) {
    if (keptChunkIds.has(passage.chunkId)) continue;
    if (passages >= maxPassages || tokens + passage.tokenCount > limits.passageTokens) break;
    keptChunkIds.add(passage.chunkId);
    passages += 1;
    tokens += passage.tokenCount;
    const rank = selection.entries.length + added.length + 1;
    added.push({
      key: passageKey(passage.chunkId),
      item: { key: passageKey(passage.chunkId), type: 'passage', passage },
      score: 0,
      rank,
      bestRank: rank,
      foundBy: [],
      ranks: {},
    });
  }
  if (added.length === 0) return { selection, added: 0 };

  // A chunk the fused list holds but didn't keep is in the context now: its result says so.
  const addedKeys = new Set(added.map((entry) => entry.key));
  return {
    selection: {
      entries: selection.entries.map(({ entry, inContext }) => ({
        entry,
        inContext: inContext || addedKeys.has(entry.key),
      })),
      kept: [...selection.kept, ...added],
      links: selection.links,
      passageTokens: tokens,
    },
    added: added.length,
  };
}
