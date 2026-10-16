// Merging two records that are clearly one (S4-007; D37, D43, D45.4, D68, D69; planner's reading
// S4-Q3): the older record (lower number) is kept and the other retired into it, in one Neo4j
// transaction with every audit entry, as the writer in the org's own database:
//   - the kept record gains the other's source IDs (they move, so an import from either source now
//     finds it) and goes up one version;
//   - every link of the other moves to the kept record, the same type and direction with the same
//     properties (its origin, its creator, an AI link's source): a link the kept record already has
//     isn't doubled, and one that would join it to itself is dropped. Each moved link is a
//     `link.removed` and a `link.created` entry, a dropped one a `link.removed`;
//   - the other is retired with `mergedInto` set to the kept record's ID, its source IDs emptied
//     and its version up one (D69: retired, never deleted);
//   - `record.merged` on the kept record (meta: the other's ID and number, and the step) and
//     `record.retired` on the other (meta: `mergedInto`), actor `system:processing`.
// Both records are write-locked first, in ID order, and read again: if either one's version moved
// since the check read it, or it is no longer active, nothing is written and the answer is
// `changed` (the caller runs the check again later). Nothing here logs a name or a value (D163).
//
// The Analyst's merge of a possible duplicate (S5-003, planner's reading S5-Q3) is
// `mergeReviewedRecords`: the same moves and entries in one Neo4j transaction, with these
// differences. The actor is the Analyst; the record kept is the one they chose (by default the
// older one, the lower number); the names may differ; the kept record takes the higher of the two
// labels (shown in its `record.merged` entry); and no version is expected. Both records are locked
// and read again inside the transaction: if either is no longer visible in the Analyst's view the
// answer is `hidden`, if either is gone or retired `not_active`, and nothing is written. The
// retired record carries `mergeFindingId`, the finding's ID, so a retry after a crash between the
// Neo4j and the Postgres steps finds the merge already made and writes nothing more (`already`).
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import {
  INTAKE_LINK_TYPES,
  LINK_TYPES,
  MAPPING_LINK_TYPES,
  NODE_LABELS,
  isLabel,
  normaliseName,
  type Label,
  type MatchStep,
  type RecordKind,
} from '@grc/shared';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../../audit/outbox.js';
import { linkRemovedAudit, type StoredLink } from '../../records/link-audit.js';
import { linkTargetId } from '../../records/links.service.js';
import { PROCESSING_ACTOR_ID } from '../queues.js';
import { byNumber, higherLabel } from './match-rules.js';

/** Every link type a record can have (D66, D67): the ontology's, Evidence's and Audit findings',
 * and the framework mappings'. Only these move; their names are the only ones put into Cypher. */
export const MERGED_LINK_TYPES: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...LINK_TYPES.map((row) => row.type),
    ...INTAKE_LINK_TYPES.map((row) => row.type),
    ...MAPPING_LINK_TYPES.map((row) => row.type),
  ]),
]);

/** The actor of every merge write. */
export const PROCESSING_ACTOR: AuditActor = Object.freeze({ actorType: 'system', actorId: PROCESSING_ACTOR_ID });

/** One record of the pair, as the duplicate check read it. */
export interface MergeSide {
  id: string;
  version: number;
}

export interface MergeRequest {
  orgId: string;
  kind: RecordKind;
  a: MergeSide;
  b: MergeSide;
  /** The step that found the pair (only `exact` merges, S4-Q3). */
  step: MatchStep;
}

export type MergeResult =
  | {
      status: 'merged';
      keptId: string;
      keptNumber: string;
      retiredId: string;
      retiredNumber: string;
      linksMoved: number;
      linksKept: number;
      linksDropped: number;
    }
  | { status: 'changed' };

export interface MergeDeps {
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>;
  now?: () => string;
}

interface Locked {
  id: string;
  number: string;
  name: string;
  label: Label;
  status: string;
  version: number;
  sourceIds: string[];
  owner: string;
  mergedInto: string;
  mergeFindingId: string;
}

interface OtherLink {
  rid: string;
  type: string;
  out: boolean;
  otherEndId: string;
  otherEndElementId: string;
  otherEndNumber: string;
  otherEndLabel: Label;
  createdAt: string;
  createdBy: string;
  origin: string;
}

/** Integers go to Neo4j as integers, not floats. */
function int(n: number): ReturnType<typeof neo4j.int> {
  return neo4j.int(n);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A far end without a known label counts as Restricted, so its entries are shown to the fewest. */
function labelOf(v: unknown): Label {
  return isLabel(v) ? v : 'restricted';
}

/** Write-locks one record (a property set and removed again, so it is unchanged) and reads it. */
async function lockAndRead(tx: ManagedTransaction, kind: RecordKind, id: string): Promise<Locked | null> {
  const res = await tx.run(
    `MATCH (n:${NODE_LABELS[kind]} {id: $id})
     SET n.__lock = true REMOVE n.__lock
     RETURN n.id AS id, n.number AS number, n.name AS name, n.sensitivity AS label, n.status AS status,
            n.version AS version, n.sourceIds AS sourceIds, n.owner AS owner, n.mergedInto AS mergedInto,
            n.mergeFindingId AS mergeFindingId`,
    { id },
  );
  const row = res.records[0];
  if (!row) return null;
  const sourceIds = row.get('sourceIds');
  return {
    id: text(row.get('id')),
    number: text(row.get('number')),
    name: text(row.get('name')),
    label: labelOf(row.get('label')),
    status: text(row.get('status')),
    version: Number(row.get('version')),
    sourceIds: Array.isArray(sourceIds) ? sourceIds.filter((s): s is string => typeof s === 'string') : [],
    owner: text(row.get('owner')),
    mergedInto: text(row.get('mergedInto')),
    mergeFindingId: text(row.get('mergeFindingId')),
  };
}

/** Every link of the record, of the types that move, once each, in a fixed order. */
async function linksOf(tx: ManagedTransaction, kind: RecordKind, id: string): Promise<OtherLink[]> {
  const res = await tx.run(
    `MATCH (x:${NODE_LABELS[kind]} {id: $id})-[r]-(o)
     WHERE type(r) IN $types
     WITH DISTINCT r, o, startNode(r) = x AS out
     RETURN elementId(r) AS rid, type(r) AS type, out, o.id AS oid, elementId(o) AS oeid,
            o.number AS onumber, o.sensitivity AS olabel,
            r.createdAt AS createdAt, r.createdBy AS createdBy, r.origin AS origin
     ORDER BY type, oid, out`,
    { id, types: [...MERGED_LINK_TYPES] },
  );
  return res.records.map((r) => ({
    rid: text(r.get('rid')),
    type: text(r.get('type')),
    out: r.get('out') === true,
    otherEndId: text(r.get('oid')),
    otherEndElementId: text(r.get('oeid')),
    otherEndNumber: text(r.get('onumber')),
    otherEndLabel: labelOf(r.get('olabel')),
    createdAt: text(r.get('createdAt')),
    createdBy: text(r.get('createdBy')),
    origin: text(r.get('origin')),
  }));
}

/** Whether the kept record already has a `type` link to (out) or from (in) the far end. */
async function keptHas(tx: ManagedTransaction, kind: RecordKind, keptId: string, link: OtherLink): Promise<boolean> {
  const pattern = link.out ? `(k)-[e:${link.type}]->(o)` : `(o)-[e:${link.type}]->(k)`;
  const res = await tx.run(
    `MATCH (k:${NODE_LABELS[kind]} {id: $keptId})
     MATCH (o) WHERE elementId(o) = $oeid
     OPTIONAL MATCH ${pattern}
     RETURN count(e) AS n`,
    { keptId, oeid: link.otherEndElementId },
  );
  return Number(res.records[0]?.get('n') ?? 0) > 0;
}

/** Moves one link to the kept record: a new link of the same type and direction, with the same
 * properties, and the old one deleted. */
async function moveLink(tx: ManagedTransaction, kind: RecordKind, keptId: string, link: OtherLink): Promise<void> {
  const match = link.out ? '(x)-[r]->(o)' : '(o)-[r]->(x)';
  const create = link.out ? `(k)-[e:${link.type}]->(o)` : `(o)-[e:${link.type}]->(k)`;
  await tx.run(
    `MATCH ${match} WHERE elementId(r) = $rid
     MATCH (k:${NODE_LABELS[kind]} {id: $keptId})
     CREATE ${create}
     SET e = properties(r)
     DELETE r`,
    { rid: link.rid, keptId },
  );
}

async function deleteLink(tx: ManagedTransaction, rid: string): Promise<void> {
  await tx.run('MATCH ()-[r]->() WHERE elementId(r) = $rid DELETE r', { rid });
}

/** The link as stored, between `self` and its far end, in its direction. */
function stored(link: OtherLink, selfId: string): StoredLink {
  return {
    type: link.type,
    fromId: link.out ? selfId : link.otherEndId,
    toId: link.out ? link.otherEndId : selfId,
    createdAt: link.createdAt,
    createdBy: link.createdBy,
    origin: link.origin,
  };
}

function removedEntry(link: OtherLink, from: Locked, mergedFrom: string): OutboxAudit {
  const self = { number: from.number, label: from.label };
  const far = { number: link.otherEndNumber, label: link.otherEndLabel };
  const entry = linkRemovedAudit(stored(link, from.id), link.out ? self : far, link.out ? far : self);
  return { ...entry, meta: { ...(entry.meta as Record<string, unknown>), mergedFrom } };
}

function createdEntry(link: OtherLink, kept: Locked, keptLabel: Label, mergedFrom: string): OutboxAudit {
  const s = stored(link, kept.id);
  const fromNumber = link.out ? kept.number : link.otherEndNumber;
  const toNumber = link.out ? link.otherEndNumber : kept.number;
  return {
    action: 'link.created',
    targetType: 'link',
    targetId: linkTargetId(s.type, s.fromId, s.toId),
    before: null,
    after: {
      type: s.type,
      fromId: s.fromId,
      toId: s.toId,
      origin: s.origin,
      createdAt: s.createdAt,
      createdBy: s.createdBy,
    },
    meta: {
      type: s.type,
      fromNumber,
      toNumber,
      label: higherLabel(keptLabel, link.otherEndLabel),
      mergedFrom,
    },
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Merges the pair in one Neo4j transaction with its audit entries (see the file comment). The
 * answer is `changed` when either record moved on since the check read it; nothing is written then.
 */
export async function mergeRecords(deps: MergeDeps, req: MergeRequest): Promise<MergeResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const expected = new Map([
    [req.a.id, req.a.version],
    [req.b.id, req.b.version],
  ]);
  return deps.outbox.withAuditedWrites<MergeResult>(req.orgId, PROCESSING_ACTOR, async (tx) => {
    const unchanged = { result: { status: 'changed' } as MergeResult, audits: [] as OutboxAudit[] };
    if (req.a.id === req.b.id) return unchanged;

    // Lock both in ID order, so two merges of overlapping pairs wait for each other, never deadlock.
    const locked: Locked[] = [];
    for (const id of [req.a.id, req.b.id].sort()) {
      const row = await lockAndRead(tx, req.kind, id);
      if (!row || row.status !== 'active' || row.version !== expected.get(id)) return unchanged;
      locked.push(row);
    }
    const [first, second] = locked as [Locked, Locked];
    // The check decided on these names and labels; with the versions unchanged they still hold.
    const key = normaliseName(first.name);
    if (key === '' || key !== normaliseName(second.name) || first.label !== second.label) return unchanged;

    const [kept, other] = byNumber(first, second) <= 0 ? [first, second] : [second, first];
    const moved = await mergeLocked(tx, req.kind, kept, other, {
      actorId: PROCESSING_ACTOR_ID,
      at: now(),
      keptLabel: kept.label,
      step: req.step,
    });
    return { result: { status: 'merged', ...moved.result }, audits: moved.audits };
  });
}

/** How the shared merge writes: who, when, the kept record's label afterwards, the step, and for an
 * Analyst's merge the finding's ID (on the retired record and in the `record.merged` meta). */
interface MergeWrite {
  actorId: string;
  at: string;
  keptLabel: Label;
  step: MatchStep;
  findingId?: string;
}

interface MergedCounts {
  keptId: string;
  keptNumber: string;
  retiredId: string;
  retiredNumber: string;
  linksMoved: number;
  linksKept: number;
  linksDropped: number;
}

/**
 * The merge itself, on two records already locked and checked: the other's links move to the kept
 * record (never doubled, none joining it to itself), its source IDs go to the kept record, which
 * takes `write.keptLabel` and goes up one version, and the other is retired into it. Answers the
 * counts and every audit entry, in order. With the kept record's own label and no finding, it
 * writes exactly what S4-007's automatic merge always wrote.
 */
async function mergeLocked(
  tx: ManagedTransaction,
  kind: RecordKind,
  kept: Locked,
  other: Locked,
  write: MergeWrite,
): Promise<{ result: MergedCounts; audits: OutboxAudit[] }> {
  const audits: OutboxAudit[] = [];
  let linksMoved = 0;
  let linksKept = 0;
  let linksDropped = 0;

  for (const link of await linksOf(tx, kind, other.id)) {
    if (!(MERGED_LINK_TYPES as readonly string[]).includes(link.type)) continue;
    audits.push(removedEntry(link, other, other.id));
    if (link.otherEndId === kept.id || link.otherEndId === other.id) {
      await deleteLink(tx, link.rid);
      linksDropped += 1;
    } else if (await keptHas(tx, kind, kept.id, link)) {
      await deleteLink(tx, link.rid);
      linksKept += 1;
    } else {
      await moveLink(tx, kind, kept.id, link);
      audits.push(createdEntry(link, kept, write.keptLabel, other.id));
      linksMoved += 1;
    }
  }

  const keptIds = [...kept.sourceIds, ...other.sourceIds.filter((s) => !kept.sourceIds.includes(s))];
  const relabel = write.keptLabel !== kept.label;
  await tx.run(
    `MATCH (n:${NODE_LABELS[kind]} {id: $id})
     SET n.sourceIds = $sourceIds, n.version = $version, n.updatedAt = $now, n.updatedBy = $actor${relabel ? ', n.sensitivity = $label' : ''}`,
    {
      id: kept.id,
      sourceIds: keptIds,
      version: int(kept.version + 1),
      now: write.at,
      actor: write.actorId,
      ...(relabel ? { label: write.keptLabel } : {}),
    },
  );
  const byFinding = write.findingId !== undefined;
  await tx.run(
    `MATCH (n:${NODE_LABELS[kind]} {id: $id})
     SET n.status = 'retired', n.mergedInto = $keptId, n.sourceIds = [], n.version = $version,
         n.updatedAt = $now, n.updatedBy = $actor${byFinding ? ', n.mergeFindingId = $findingId' : ''}`,
    {
      id: other.id,
      keptId: kept.id,
      version: int(other.version + 1),
      now: write.at,
      actor: write.actorId,
      ...(byFinding ? { findingId: write.findingId } : {}),
    },
  );

  const idsChanged = !sameIds(kept.sourceIds, keptIds);
  const before: Record<string, unknown> = idsChanged ? { sourceIds: kept.sourceIds } : {};
  const after: Record<string, unknown> = idsChanged ? { sourceIds: keptIds } : {};
  if (relabel) {
    before['label'] = kept.label;
    after['label'] = write.keptLabel;
  }
  audits.push({
    action: 'record.merged',
    targetType: kind,
    targetId: kept.id,
    before,
    after,
    meta: {
      number: kept.number,
      label: write.keptLabel,
      otherId: other.id,
      otherNumber: other.number,
      step: write.step,
      ...(byFinding ? { findingId: write.findingId } : {}),
    },
  });
  audits.push({
    action: 'record.retired',
    targetType: kind,
    targetId: other.id,
    before: { status: 'active', ...(other.sourceIds.length > 0 ? { sourceIds: other.sourceIds } : {}) },
    after: { status: 'retired', mergedInto: kept.id, ...(other.sourceIds.length > 0 ? { sourceIds: [] } : {}) },
    meta: { number: other.number, label: other.label, mergedInto: kept.id },
  });

  return {
    result: {
      keptId: kept.id,
      keptNumber: kept.number,
      retiredId: other.id,
      retiredNumber: other.number,
      linksMoved,
      linksKept,
      linksDropped,
    },
    audits,
  };
}

/** The Analyst's merge of a possible duplicate (see the file comment). */
export interface ReviewedMergeRequest {
  orgId: string;
  kind: RecordKind;
  /** The finding's ID: kept on the retired record, so a retry finds the merge already made. */
  findingId: string;
  /** The two records of the finding. */
  a: string;
  b: string;
  /** The record to keep, one of the two; by default the older one (the lower number). */
  keepId?: string;
  /** The step that found the pair. */
  step: MatchStep;
  /** The Analyst, who makes the merge. */
  actor: AuditActor;
  /** Whether the Analyst may see a stored record of this kind now (their role, clearance and
   * ownership, D50, D51). */
  visible: (record: { label: Label; owner: string }) => boolean;
}

export type ReviewedMergeResult =
  | ({
      status: 'merged';
      /** True when this finding's merge was already made (a retry): nothing was written now. */
      already: boolean;
    } & MergedCounts)
  | { status: 'hidden' }
  | { status: 'not_active' };

/**
 * The Analyst's merge (see the file comment), in one Neo4j transaction with its audit entries, as
 * the Analyst. Nothing is written unless the answer is `merged` with `already` false.
 */
export async function mergeReviewedRecords(deps: MergeDeps, req: ReviewedMergeRequest): Promise<ReviewedMergeResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  return deps.outbox.withAuditedWrites<ReviewedMergeResult>(req.orgId, req.actor, async (tx) => {
    const none = (result: ReviewedMergeResult): { result: ReviewedMergeResult; audits: OutboxAudit[] } => ({
      result,
      audits: [],
    });
    if (req.a === req.b) return none({ status: 'not_active' });
    if (req.keepId !== undefined && req.keepId !== req.a && req.keepId !== req.b) return none({ status: 'hidden' });

    // Lock both in ID order, so two merges of overlapping pairs wait for each other, never deadlock.
    const locked = new Map<string, Locked>();
    for (const id of [req.a, req.b].sort()) {
      const row = await lockAndRead(tx, req.kind, id);
      if (!row) return none({ status: 'not_active' });
      if (!req.visible({ label: row.label, owner: row.owner })) return none({ status: 'hidden' });
      locked.set(id, row);
    }
    const a = locked.get(req.a);
    const b = locked.get(req.b);
    if (!a || !b) return none({ status: 'not_active' });

    // A retry: this finding's merge is already made, so nothing more is written.
    const pairs: [Locked, Locked][] = [
      [a, b],
      [b, a],
    ];
    for (const [retired, kept] of pairs) {
      if (retired.status === 'retired' && retired.mergeFindingId === req.findingId && retired.mergedInto === kept.id) {
        return none({
          status: 'merged',
          already: true,
          keptId: kept.id,
          keptNumber: kept.number,
          retiredId: retired.id,
          retiredNumber: retired.number,
          linksMoved: 0,
          linksKept: 0,
          linksDropped: 0,
        });
      }
    }
    if (a.status !== 'active' || b.status !== 'active') return none({ status: 'not_active' });

    const keepId = req.keepId ?? (byNumber(a, b) <= 0 ? a.id : b.id);
    const [kept, other] = keepId === a.id ? [a, b] : [b, a];
    const moved = await mergeLocked(tx, req.kind, kept, other, {
      actorId: req.actor.actorId,
      at: now(),
      keptLabel: higherLabel(kept.label, other.label),
      step: req.step,
      findingId: req.findingId,
    });
    return { result: { status: 'merged', already: false, ...moved.result }, audits: moved.audits };
  });
}
