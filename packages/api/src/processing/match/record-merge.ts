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
            n.version AS version, n.sourceIds AS sourceIds`,
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

function createdEntry(link: OtherLink, kept: Locked, mergedFrom: string): OutboxAudit {
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
      label: higherLabel(kept.label, link.otherEndLabel),
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
    const audits: OutboxAudit[] = [];
    let linksMoved = 0;
    let linksKept = 0;
    let linksDropped = 0;

    for (const link of await linksOf(tx, req.kind, other.id)) {
      if (!(MERGED_LINK_TYPES as readonly string[]).includes(link.type)) continue;
      audits.push(removedEntry(link, other, other.id));
      if (link.otherEndId === kept.id || link.otherEndId === other.id) {
        await deleteLink(tx, link.rid);
        linksDropped += 1;
      } else if (await keptHas(tx, req.kind, kept.id, link)) {
        await deleteLink(tx, link.rid);
        linksKept += 1;
      } else {
        await moveLink(tx, req.kind, kept.id, link);
        audits.push(createdEntry(link, kept, other.id));
        linksMoved += 1;
      }
    }

    const at = now();
    const keptIds = [...kept.sourceIds, ...other.sourceIds.filter((s) => !kept.sourceIds.includes(s))];
    await tx.run(
      `MATCH (n:${NODE_LABELS[req.kind]} {id: $id})
       SET n.sourceIds = $sourceIds, n.version = $version, n.updatedAt = $now, n.updatedBy = $actor`,
      { id: kept.id, sourceIds: keptIds, version: int(kept.version + 1), now: at, actor: PROCESSING_ACTOR_ID },
    );
    await tx.run(
      `MATCH (n:${NODE_LABELS[req.kind]} {id: $id})
       SET n.status = 'retired', n.mergedInto = $keptId, n.sourceIds = [], n.version = $version,
           n.updatedAt = $now, n.updatedBy = $actor`,
      { id: other.id, keptId: kept.id, version: int(other.version + 1), now: at, actor: PROCESSING_ACTOR_ID },
    );

    const keptChanged = !sameIds(kept.sourceIds, keptIds);
    audits.push({
      action: 'record.merged',
      targetType: req.kind,
      targetId: kept.id,
      before: keptChanged ? { sourceIds: kept.sourceIds } : {},
      after: keptChanged ? { sourceIds: keptIds } : {},
      meta: { number: kept.number, label: kept.label, otherId: other.id, otherNumber: other.number, step: req.step },
    });
    audits.push({
      action: 'record.retired',
      targetType: req.kind,
      targetId: other.id,
      before: { status: 'active', ...(other.sourceIds.length > 0 ? { sourceIds: other.sourceIds } : {}) },
      after: { status: 'retired', mergedInto: kept.id, ...(other.sourceIds.length > 0 ? { sourceIds: [] } : {}) },
      meta: { number: other.number, label: other.label, mergedInto: kept.id },
    });

    return {
      result: {
        status: 'merged',
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
  });
}
