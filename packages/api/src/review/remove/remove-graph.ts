// The graph side of taking AI facts back out (S5-004; D37, D38, D45.4, D45.5, D52.5, D69, D201,
// D207): the Neo4j reads and writes the removal service runs, all as the writer in the org's own
// database (the service checks the Analyst's own view first, D45.3). Every write commits with its
// audit entries in one Neo4j transaction (`AuditOutbox.withAuditedWrites`).
// - A record a finding names is found by its ID among the labels it can have, following
//   `mergedInto` when it was merged into another record since (S4-007, S5-003), so a link that moved
//   with a merge is still found on the kept record.
// - A finding's own AI link: the link of the finding's type between its two records, with origin
//   `ai` and either the finding's `findingId` (approved by the Analyst) or its `chunkId` (made live
//   by S4's rule checks). Nothing else is ever deleted here: a link from a person or an import, or
//   one another chunk or finding made, stays.
// - A whole upload's AI links: every link of the types that carry a source document whose
//   `sourceDocId` is the document and whose origin is `ai`, deleted in batches (each batch one
//   transaction with its entries), through the per-type `sourceDocId` indexes (S1-002).
// - `link.removed` holds a copy of the link (D201): S1's copy plus where an AI link came from (its
//   source document, chunk, model, prompt version, source label, and the finding and reviewer for
//   one the Analyst approved), never its sentence, which is the document's text (S5 shared notes,
//   "Audit"). Its meta is S1's: the type, the two numbers and the higher of the two ends' labels.
// - Retiring a record (D69: retired, never deleted) is S1's retire in shape: the status goes to
//   `retired`, the version up by one, with `record.retired` (only the changed status in
//   before/after; meta the number and label). Its links stay. A record already retired is left
//   alone and writes no entry.
// Nothing here logs; the service logs IDs and counts only (D163).
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import {
  INTAKE_LINK_TYPES,
  LINK_TYPES,
  MAPPING_LINK_TYPES,
  NODE_LABELS,
  isLabel,
  type Label,
  type RecordKind,
} from '@grc/shared';
import type { OutboxAudit } from '../../audit/outbox.js';
import { NODE_RECORD_TYPES } from '../../graph/privileges.js';
import { linkRemovedAudit } from '../../records/link-audit.js';

/** The five record node labels. */
export const RECORD_NODE_LABELS = Object.freeze(Object.values(NODE_LABELS)) as readonly NodeLabelOfRecord[];
type NodeLabelOfRecord = (typeof NODE_LABELS)[RecordKind];

/** The node labels a finding can name: the five records, and requirements (mappings). */
export const FINDING_NODE_LABELS = Object.freeze([...RECORD_NODE_LABELS, 'Requirement'] as const);
export type FindingNodeLabel = NodeLabelOfRecord | 'Requirement';

/** Each record node label's kind. */
const KIND_OF_LABEL: Readonly<Record<NodeLabelOfRecord, RecordKind>> = Object.freeze(
  Object.fromEntries(Object.entries(NODE_LABELS).map(([kind, label]) => [label, kind as RecordKind])) as Record<
    NodeLabelOfRecord,
    RecordKind
  >,
);

/** Every link type that can carry a source document (D66, D67): the ontology's, intake's and the
 * framework mappings'. Only these names are ever put into Cypher. */
export const SOURCED_LINK_TYPES: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...LINK_TYPES.map((row) => row.type),
    ...INTAKE_LINK_TYPES.map((row) => row.type),
    ...MAPPING_LINK_TYPES.map((row) => row.type),
  ]),
]);

/** How many `mergedInto` steps are followed at most (a chain longer than this is never made). */
const MAX_MERGE_HOPS = 16;

/** Links deleted per transaction when a whole upload is removed. */
export const DOCUMENT_LINK_BATCH = 200;

/** Records retired per transaction when a whole upload is removed. */
export const RECORD_RETIRE_BATCH = 50;

/** One record as stored. */
export interface GraphNode {
  id: string;
  nodeLabel: FindingNodeLabel;
  number: string;
  label: Label;
  status: string;
  owner: string | null;
  mergedInto: string | null;
}

/** An AI link as it was deleted: its ends and where it came from (never its sentence). */
export interface DeletedLink {
  type: string;
  fromId: string;
  fromNumber: string;
  fromLabel: Label;
  toId: string;
  toNumber: string;
  toLabel: Label;
  createdAt: string;
  createdBy: string;
  sourceDocId: string | null;
  chunkId: string | null;
  findingId: string | null;
  model: string | null;
  promptVersion: string | null;
  sourceLabel: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/** Which AI link is a finding's own: the one the Analyst approved (`findingId`), or the one S4's
 * rule checks made live from the finding's chunk (`chunkId`, with no other finding's ID on it). */
export type FindingLinkMatch =
  { by: 'finding'; findingId: string } | { by: 'chunk'; chunkId: string; findingId: string };

/** A record retired, or found already retired (or gone). */
export type RetireResult =
  | { result: 'retired'; id: string; number: string; label: Label; audit: OutboxAudit }
  | { result: 'already_retired'; id: string };

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** A label we can't read counts as Restricted, so the entry is shown to the fewest (D186). */
function labelOf(v: unknown): Label {
  return isLabel(v) ? v : 'restricted';
}

function isFindingNodeLabel(v: unknown): v is FindingNodeLabel {
  return typeof v === 'string' && (FINDING_NODE_LABELS as readonly string[]).includes(v);
}

/** The D50 record type of a node label (a requirement is a framework mapping's). */
export function recordTypeOfLabel(nodeLabel: FindingNodeLabel): string {
  return NODE_RECORD_TYPES[nodeLabel] ?? 'unknown';
}

/** The record kind of a record node label; null for a requirement. */
export function kindOfLabel(nodeLabel: FindingNodeLabel): RecordKind | null {
  return nodeLabel === 'Requirement' ? null : KIND_OF_LABEL[nodeLabel];
}

function checkedLabels(labels: readonly FindingNodeLabel[]): FindingNodeLabel[] {
  const out = labels.filter(isFindingNodeLabel);
  if (out.length === 0) throw new Error('review removal: no node label to look in');
  return [...new Set(out)];
}

function checkedType(type: string): string {
  if (!SOURCED_LINK_TYPES.includes(type)) throw new Error('review removal: unknown link type');
  return type;
}

/** One record by ID among `labels`, as stored; null when there is none. */
export async function readNode(
  tx: ManagedTransaction,
  id: string,
  labels: readonly FindingNodeLabel[],
): Promise<GraphNode | null> {
  const branches = checkedLabels(labels).map(
    (label) => `MATCH (n:${label} {id: $id}) RETURN n, '${label}' AS nodeLabel`,
  );
  const res = await tx.run(
    `CALL () { ${branches.join(' UNION ')} }
     RETURN nodeLabel, n.id AS id, n.number AS number, n.sensitivity AS label, n.status AS status,
            n.owner AS owner, n.mergedInto AS mergedInto
     LIMIT 1`,
    { id },
  );
  const row = res.records[0];
  if (!row) return null;
  const nodeLabel = row.get('nodeLabel');
  if (!isFindingNodeLabel(nodeLabel)) return null;
  return {
    id: text(row.get('id')),
    nodeLabel,
    number: text(row.get('number')),
    label: labelOf(row.get('label')),
    status: text(row.get('status')),
    owner: textOrNull(row.get('owner')),
    mergedInto: textOrNull(row.get('mergedInto')),
  };
}

/** The record by ID among `labels`, or the record it was merged into (followed to the end of the
 * chain); null when there is none. */
export async function currentNode(
  tx: ManagedTransaction,
  id: string,
  labels: readonly FindingNodeLabel[],
): Promise<GraphNode | null> {
  let node = await readNode(tx, id, labels);
  const seen = new Set<string>([id]);
  for (let hop = 0; node && hop < MAX_MERGE_HOPS; hop += 1) {
    const next = node.status === 'retired' ? node.mergedInto : null;
    if (next === null || seen.has(next)) break;
    seen.add(next);
    const merged = await readNode(tx, next, [node.nodeLabel]);
    if (!merged) break;
    node = merged;
  }
  return node;
}

/** Where each of `ids` stands now: its own ID, or the record it was merged into. One read per
 * step of the chains, for all of them at once. IDs with no record map to themselves. */
export async function currentIds(
  tx: ManagedTransaction,
  ids: readonly string[],
  labels: readonly FindingNodeLabel[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>(ids.map((id) => [id, id]));
  const branches = checkedLabels(labels).map((label) => `MATCH (n:${label} {id: wanted}) RETURN n`);
  let frontier = [...new Set(ids)];
  const seen = new Set<string>(frontier);
  for (let hop = 0; frontier.length > 0 && hop < MAX_MERGE_HOPS; hop += 1) {
    const res = await tx.run(
      `UNWIND $ids AS wanted
       CALL (wanted) { ${branches.join(' UNION ')} }
       RETURN wanted AS id, n.status AS status, n.mergedInto AS mergedInto`,
      { ids: frontier },
    );
    const moved = new Map<string, string>();
    for (const row of res.records) {
      const next = textOrNull(row.get('mergedInto'));
      if (row.get('status') === 'retired' && next !== null && !seen.has(next)) moved.set(text(row.get('id')), next);
    }
    if (moved.size === 0) break;
    for (const [original, now] of out) {
      const next = moved.get(now);
      if (next !== undefined) out.set(original, next);
    }
    frontier = [...new Set(moved.values())];
    for (const id of frontier) seen.add(id);
  }
  return out;
}

const LINK_COPY = `r.createdAt AS createdAt, r.createdBy AS createdBy, r.sourceDocId AS sourceDocId,
  r.chunkId AS chunkId, r.findingId AS findingId, r.model AS model, r.promptVersion AS promptVersion,
  r.sourceLabel AS sourceLabel, r.reviewedBy AS reviewedBy, r.reviewedAt AS reviewedAt`;

const LINK_COPY_OUT = `createdAt, createdBy, sourceDocId, chunkId, findingId, model, promptVersion,
  sourceLabel, reviewedBy, reviewedAt`;

function deletedLink(
  row: { get(key: string): unknown },
  type: string,
  ends: Pick<DeletedLink, 'fromId' | 'fromNumber' | 'fromLabel' | 'toId' | 'toNumber' | 'toLabel'>,
): DeletedLink {
  return {
    type,
    ...ends,
    createdAt: text(row.get('createdAt')),
    createdBy: text(row.get('createdBy')),
    sourceDocId: textOrNull(row.get('sourceDocId')),
    chunkId: textOrNull(row.get('chunkId')),
    findingId: textOrNull(row.get('findingId')),
    model: textOrNull(row.get('model')),
    promptVersion: textOrNull(row.get('promptVersion')),
    sourceLabel: textOrNull(row.get('sourceLabel')),
    reviewedBy: textOrNull(row.get('reviewedBy')),
    reviewedAt: textOrNull(row.get('reviewedAt')),
  };
}

/**
 * Deletes the finding's own AI link between `from` and `to` (both as stored now), if it is there,
 * and answers its copy; null when there is no such link. The `from` record is write-locked first
 * (a property set and removed again, so it is unchanged), so two removals of one link run one after
 * the other and the second finds nothing.
 */
export async function deleteFindingLink(
  tx: ManagedTransaction,
  type: string,
  from: GraphNode,
  to: GraphNode,
  match: FindingLinkMatch,
): Promise<DeletedLink | null> {
  const linkType = checkedType(type);
  if (!isFindingNodeLabel(from.nodeLabel) || !isFindingNodeLabel(to.nodeLabel)) {
    throw new Error('review removal: unknown node label');
  }
  const fromLabel = from.nodeLabel;
  const toLabel = to.nodeLabel;
  await tx.run(`MATCH (a:${fromLabel} {id: $id}) SET a.__lock = true REMOVE a.__lock`, { id: from.id });
  const which =
    match.by === 'finding'
      ? 'r.findingId = $findingId'
      : 'r.chunkId = $chunkId AND (r.findingId IS NULL OR r.findingId = $findingId)';
  const res = await tx.run(
    `MATCH (a:${fromLabel} {id: $fromId})-[r:${linkType}]->(b:${toLabel} {id: $toId})
     WHERE r.origin = 'ai' AND ${which}
     WITH r ORDER BY r.createdAt LIMIT 1
     WITH r, ${LINK_COPY}
     DELETE r
     RETURN ${LINK_COPY_OUT}`,
    {
      fromId: from.id,
      toId: to.id,
      findingId: match.findingId,
      chunkId: match.by === 'chunk' ? match.chunkId : null,
    },
  );
  const row = res.records[0];
  if (!row) return null;
  return deletedLink(row, linkType, {
    fromId: from.id,
    fromNumber: from.number,
    fromLabel: from.label,
    toId: to.id,
    toNumber: to.number,
    toLabel: to.label,
  });
}

/**
 * Deletes up to `limit` AI links of `type` whose source is the document, and answers their copies.
 * Run again until it answers fewer than `limit`.
 */
export async function deleteDocumentLinks(
  tx: ManagedTransaction,
  type: string,
  documentId: string,
  limit: number = DOCUMENT_LINK_BATCH,
): Promise<DeletedLink[]> {
  const linkType = checkedType(type);
  const res = await tx.run(
    `MATCH (a)-[r:${linkType}]->(b)
     WHERE r.sourceDocId = $documentId AND r.origin = 'ai'
     WITH a, r, b LIMIT $limit
     WITH r, a.id AS fromId, a.number AS fromNumber, a.sensitivity AS fromLabel,
          b.id AS toId, b.number AS toNumber, b.sensitivity AS toLabel, ${LINK_COPY}
     DELETE r
     RETURN fromId, fromNumber, fromLabel, toId, toNumber, toLabel, ${LINK_COPY_OUT}`,
    { documentId, limit: neo4j.int(limit) },
  );
  return res.records.map((row) =>
    deletedLink(row, linkType, {
      fromId: text(row.get('fromId')),
      fromNumber: text(row.get('fromNumber')),
      fromLabel: labelOf(row.get('fromLabel')),
      toId: text(row.get('toId')),
      toNumber: text(row.get('toNumber')),
      toLabel: labelOf(row.get('toLabel')),
    }),
  );
}

/** How many AI links in the org's graph have the document as their source. */
export async function countDocumentLinks(tx: ManagedTransaction, documentId: string): Promise<number> {
  let total = 0;
  for (const type of SOURCED_LINK_TYPES) {
    const res = await tx.run(
      `MATCH ()-[r:${checkedType(type)}]->()
       WHERE r.sourceDocId = $documentId AND r.origin = 'ai'
       RETURN count(r) AS n`,
      { documentId },
    );
    total += Number(res.records[0]?.get('n') ?? 0);
  }
  return total;
}

/** The `link.removed` entry of a deleted AI link: S1's copy, plus where it came from (D201). */
export function aiLinkRemovedAudit(link: DeletedLink): OutboxAudit {
  const entry = linkRemovedAudit(
    {
      type: link.type,
      fromId: link.fromId,
      toId: link.toId,
      createdAt: link.createdAt,
      createdBy: link.createdBy,
      origin: 'ai',
    },
    { number: link.fromNumber, label: link.fromLabel },
    { number: link.toNumber, label: link.toLabel },
  );
  const source: Record<string, string> = {};
  for (const key of [
    'sourceDocId',
    'chunkId',
    'findingId',
    'model',
    'promptVersion',
    'sourceLabel',
    'reviewedBy',
    'reviewedAt',
  ] as const) {
    const value = link[key];
    if (value !== null) source[key] = value;
  }
  return { ...entry, before: { ...(entry.before as Record<string, unknown>), ...source } };
}

/**
 * Retires one record (S1's retire in shape, D69): write-locks and reads it, and if it is active
 * sets `retired`, the version up by one, `updatedAt` and `updatedBy`, answering its
 * `record.retired` entry. A record already retired, or gone, is left alone.
 */
export async function retireRecord(
  tx: ManagedTransaction,
  id: string,
  labels: readonly FindingNodeLabel[],
  actorId: string,
  at: string,
): Promise<RetireResult> {
  const node = await readNode(tx, id, labels);
  const kind = node ? kindOfLabel(node.nodeLabel) : null;
  if (!node || !kind) return { result: 'already_retired', id };
  const locked = await tx.run(
    `MATCH (n:${node.nodeLabel} {id: $id})
     SET n.__lock = true REMOVE n.__lock
     RETURN n.status AS status, n.version AS version, n.number AS number, n.sensitivity AS label`,
    { id },
  );
  const row = locked.records[0];
  if (!row || row.get('status') !== 'active') return { result: 'already_retired', id };
  const version = Number(row.get('version'));
  const next = Number.isInteger(version) && version >= 1 ? version + 1 : 1;
  await tx.run(
    `MATCH (n:${node.nodeLabel} {id: $id})
     SET n.status = 'retired', n.version = $version, n.updatedAt = $now, n.updatedBy = $actor`,
    { id, version: neo4j.int(next), now: at, actor: actorId },
  );
  const number = text(row.get('number'));
  const label = labelOf(row.get('label'));
  return {
    result: 'retired',
    id,
    number,
    label,
    audit: {
      action: 'record.retired',
      targetType: kind,
      targetId: id,
      before: { status: 'active' },
      after: { status: 'retired' },
      meta: { number, label },
    },
  };
}
