// The graph side of an Analyst's decision (S5-003; D15, D37, D45.3, D45.4, D45.5, D50, D51, D57,
// D67, D69, D73, D198, D207; S5 shared notes, "Who", "AI links the Analyst approves", "Labels").
//
// - Reads in the Analyst's own view: the records a finding names are read through the Analyst's
//   own role x clearance read-only account (`readAs`, D57), with a time limit, in the org's own
//   database, and our code checks the role table and the label again (D45.3). A record they can't
//   see is treated as missing (404), whatever the reason.
// - An approved link or mapping is written by the writer, as the Analyst, in one Neo4j transaction
//   with its `link.created` entry (`AuditOutbox.withAuditedWrites`). Both ends are write-locked in
//   ID order and read again inside it, and every check runs again on what is stored. The link is
//   never doubled, whatever its origin: MERGE finds one of the same type between the same two
//   records in the same direction (outcome `exists`, nothing written).
// - On an approved AI link: origin `ai`, `createdAt`, `createdBy` (the Analyst), the source as S4's
//   live links carry it (`sourceDocId`, `chunkId`, `sentence`, `model`, `promptVersion`,
//   `sourceLabel`, the document's label), plus `findingId`, `reviewedBy` and `reviewedAt`. On an
//   approved mapping: origin `ai`, `createdAt`, `createdBy`, `findingId`, `model`,
//   `promptVersion`, `reviewedBy` and `reviewedAt`.
// - What a finding's approval already made is found by the finding's ID (`madeByFinding`), so a
//   retry after a crash between the Neo4j and the Postgres steps writes nothing more, and a
//   rejection never hides an approval that already reached the graph.
// - Audit entries hold IDs, numbers, the type, origin and source IDs, never the sentence (it is the
//   document's text, and the entry is labelled by the link's ends, D186). Nothing is logged here.
// Every name put into Cypher text comes from the fixed tables below; every value is a parameter.
import { randomUUID } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import {
  LINK_TYPES,
  MAPPING_LINK_TYPES,
  NODE_LABELS,
  can,
  isAllowedLink,
  isLabel,
  isRecordVisible,
  isVisible,
  type Label,
  type LinkType,
  type MappingLinkType,
  type RecordKind,
  type Role,
} from '@grc/shared';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../../audit/outbox.js';
import type { GraphService } from '../../graph/graph.service.js';
import { endsCoverSource } from '../../processing/decide/decide-rules.js';
import { higherLabel } from '../../processing/match/match-rules.js';
import { linkTargetId } from '../../records/links.service.js';
import { visibleLabels } from '../../records/record-queries.js';
import { RECORD_NOT_FOUND, reviewError } from './decide-errors.js';

/** Neo4j stops each of the Analyst's reads after this long (D15, D48). */
export const REVIEW_READ_TIMEOUT_MS = 5000;

/** The person deciding: always a person, in their own org, role and clearance. */
export interface Reviewer {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
}

/** The kinds of record a finding names: the five record kinds, and catalog requirements. */
export type EndKind = RecordKind | 'requirement';

const END_NODE_LABELS: Readonly<Record<EndKind, string>> = Object.freeze({
  ...NODE_LABELS,
  requirement: 'Requirement',
});

const ONTOLOGY_TYPES: readonly string[] = Object.freeze(LINK_TYPES.map((row) => row.type));
const MAPPING_TYPES: readonly string[] = Object.freeze(MAPPING_LINK_TYPES.map((row) => row.type));

/** One record a finding names, as stored. */
export interface StoredEnd {
  kind: EndKind;
  id: string;
  number: string;
  label: Label;
  status: string;
  owner: string;
}

export interface EndRef {
  kind: EndKind;
  id: string;
}

function endKey(ref: EndRef): string {
  return `${ref.kind}:${ref.id}`;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Whether the reviewer may see this stored record now (D50, D51): the role views its type (with
 * ownership for an "own" cell) and the label is at or below their clearance. A requirement needs
 * the Framework-mappings `view` cell. */
export function endVisibleTo(reviewer: Reviewer, kind: EndKind, end: { label: Label; owner: string }): boolean {
  if (kind === 'requirement') {
    return can(reviewer.role, 'framework_mapping', 'view') && isVisible(reviewer.clearance, end.label);
  }
  const isOwner = end.owner !== '' && end.owner === reviewer.userId;
  return isRecordVisible(
    { role: reviewer.role, clearance: reviewer.clearance },
    { recordType: kind, label: end.label, isOwner },
  );
}

function storedEnd(kind: EndKind, row: { get: (key: string) => unknown }): StoredEnd | null {
  const label = row.get('label');
  const number = row.get('number');
  const id = row.get('id');
  if (!isLabel(label) || typeof number !== 'string' || typeof id !== 'string') return null;
  return { kind, id, number, label, status: text(row.get('status')), owner: text(row.get('owner')) };
}

/**
 * The records, read through the reviewer's own role x clearance account (D57), one query per kind;
 * a record the reviewer can't see (by Neo4j's account or by our own check) is left out. The answer
 * is keyed by `<kind>:<id>`; use `endIn` to look one up.
 */
export async function readReviewerEnds(
  graph: Pick<GraphService, 'readAs'>,
  reviewer: Reviewer,
  refs: readonly EndRef[],
): Promise<Map<string, StoredEnd>> {
  const byKind = new Map<EndKind, Set<string>>();
  for (const ref of refs) {
    const ids = byKind.get(ref.kind) ?? new Set<string>();
    ids.add(ref.id);
    byKind.set(ref.kind, ids);
  }
  const found = new Map<string, StoredEnd>();
  if (byKind.size === 0) return found;
  await graph.readAs(
    reviewer.orgId,
    reviewer.role,
    reviewer.clearance,
    async (tx) => {
      for (const [kind, ids] of byKind) {
        const res = await tx.run(
          `MATCH (n:${END_NODE_LABELS[kind]}) WHERE n.id IN $ids AND n.sensitivity IN $visible
           RETURN n.id AS id, n.number AS number, n.sensitivity AS label, n.status AS status, n.owner AS owner`,
          { ids: [...ids], visible: visibleLabels(reviewer.clearance) },
        );
        for (const row of res.records) {
          const end = storedEnd(kind, row);
          if (end && endVisibleTo(reviewer, kind, end)) found.set(endKey(end), end);
        }
      }
    },
    { timeoutMs: REVIEW_READ_TIMEOUT_MS },
  );
  return found;
}

/** One record of `readReviewerEnds`' answer. */
export function endIn(ends: ReadonlyMap<string, StoredEnd>, ref: EndRef): StoredEnd | undefined {
  return ends.get(endKey(ref));
}

/** The document a link was read from: the record type its chunks carry and its label. */
export interface LinkSource {
  documentId: string;
  chunkId: string;
  sentence: string;
  model: string;
  promptVersion: string;
  /** The document's label (D51). */
  label: Label;
  /** The document's record type (its D50 row). */
  recordType: string;
}

/**
 * The checks of an approved link on its two ends, in the brief's order: both exist and are visible
 * to the reviewer (404), both are active (409 `record_not_active`), they are two records and the
 * type and direction fit the ontology for their kinds (400 `link_not_allowed`), and everyone who
 * can see both ends may see the document (409 `source_above_ends`, `endsCoverSource`).
 */
export function checkLinkEnds(
  reviewer: Reviewer,
  type: string,
  from: StoredEnd | null | undefined,
  to: StoredEnd | null | undefined,
  source: Pick<LinkSource, 'label' | 'recordType'>,
): asserts from is StoredEnd & { kind: RecordKind } {
  if (!from || !to || from.kind === 'requirement' || to.kind === 'requirement') throw RECORD_NOT_FOUND();
  if (!endVisibleTo(reviewer, from.kind, from) || !endVisibleTo(reviewer, to.kind, to)) throw RECORD_NOT_FOUND();
  if (from.status !== 'active' || to.status !== 'active') throw reviewError('record_not_active');
  if (from.id === to.id || !isAllowedLink(type, from.kind, to.kind)) throw reviewError('link_not_allowed');
  const document = { recordType: source.recordType, label: source.label };
  if (!endsCoverSource(document, { kind: from.kind, label: from.label }, { kind: to.kind, label: to.label })) {
    throw reviewError('source_above_ends');
  }
}

/** The checks of an approved mapping on its two ends: both exist, are active and are visible to the
 * reviewer (404 otherwise), and they are two records (400 `link_not_allowed`). */
export function checkMappingEnds(
  reviewer: Reviewer,
  from: StoredEnd | null | undefined,
  to: StoredEnd | null | undefined,
): void {
  if (!from || !to) throw RECORD_NOT_FOUND();
  if (!endVisibleTo(reviewer, from.kind, from) || !endVisibleTo(reviewer, to.kind, to)) throw RECORD_NOT_FOUND();
  if (from.status !== 'active' || to.status !== 'active') throw RECORD_NOT_FOUND();
  if (from.id === to.id) throw reviewError('link_not_allowed');
}

/** Write-locks one record (a property set and removed again, so it is unchanged) and reads it. */
async function lockAndReadEnd(tx: ManagedTransaction, ref: EndRef): Promise<StoredEnd | null> {
  const res = await tx.run(
    `MATCH (n:${END_NODE_LABELS[ref.kind]} {id: $id})
     SET n.__lock = true REMOVE n.__lock
     RETURN n.id AS id, n.number AS number, n.sensitivity AS label, n.status AS status, n.owner AS owner
     LIMIT 1`,
    { id: ref.id },
  );
  const row = res.records[0];
  return row ? storedEnd(ref.kind, row) : null;
}

/** Both ends, locked in ID order (so two writers on the same records never deadlock) and read. */
async function lockEnds(
  tx: ManagedTransaction,
  from: EndRef,
  to: EndRef,
): Promise<[StoredEnd | null, StoredEnd | null]> {
  const read = new Map<string, StoredEnd | null>();
  for (const ref of [from, to].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!read.has(endKey(ref))) read.set(endKey(ref), await lockAndReadEnd(tx, ref));
  }
  return [read.get(endKey(from)) ?? null, read.get(endKey(to)) ?? null];
}

/** Whether approving wrote the link, or found one of the same type already there. */
export type WrittenResult = 'created' | 'exists';

export interface WrittenLink {
  result: WrittenResult;
  fromNumber: string;
  toNumber: string;
}

function actorOf(reviewer: Reviewer): AuditActor {
  return { actorType: 'user', actorId: reviewer.userId };
}

/** Runs the MERGE of an approved link or mapping; answers whether it was made now, and whether the
 * link found was made by this very finding before (a retry). */
async function mergeLink(
  tx: ManagedTransaction,
  from: EndRef,
  to: EndRef,
  type: string,
  props: Record<string, unknown>,
  findingId: string,
): Promise<{ created: boolean; ours: boolean }> {
  const token = randomUUID();
  const sets = Object.keys(props)
    .map((key) => `r.${key} = $props.${key}`)
    .join(', ');
  const res = await tx.run(
    `MATCH (a:${END_NODE_LABELS[from.kind]} {id: $fromId}), (b:${END_NODE_LABELS[to.kind]} {id: $toId})
     MERGE (a)-[r:${type}]->(b)
     ON CREATE SET ${sets}, r.__created = $token
     WITH r, coalesce(r.__created = $token, false) AS created
     REMOVE r.__created
     RETURN created, coalesce(r.findingId = $findingId, false) AS ours
     ORDER BY created DESC, ours DESC
     LIMIT 1`,
    { fromId: from.id, toId: to.id, props, token, findingId },
  );
  const row = res.records[0];
  if (!row) throw RECORD_NOT_FOUND();
  return { created: row.get('created') === true, ours: row.get('ours') === true };
}

/** An approved AI link to write. */
export interface ApprovedLinkWrite {
  findingId: string;
  type: LinkType;
  from: { kind: RecordKind; id: string };
  to: { kind: RecordKind; id: string };
  source: LinkSource;
}

/**
 * Writes an approved AI link in one Neo4j transaction with its `link.created` entry (see the file
 * comment). The ends are locked and every check of `checkLinkEnds` runs again on what is stored;
 * a failed check throws its ApiError and nothing is written.
 */
export async function writeApprovedLink(
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>,
  reviewer: Reviewer,
  write: ApprovedLinkWrite,
  now: () => string = () => new Date().toISOString(),
): Promise<WrittenLink> {
  if (!ONTOLOGY_TYPES.includes(write.type)) throw reviewError('link_not_allowed');
  return outbox.withAuditedWrites<WrittenLink>(reviewer.orgId, actorOf(reviewer), async (tx) => {
    const [from, to] = await lockEnds(tx, write.from, write.to);
    checkLinkEnds(reviewer, write.type, from, to, write.source);
    const stored = to as StoredEnd;
    const at = now();
    // What the link carries besides the sentence; the entry holds these, never the sentence.
    const traced = {
      createdAt: at,
      createdBy: reviewer.userId,
      origin: 'ai',
      sourceDocId: write.source.documentId,
      chunkId: write.source.chunkId,
      model: write.source.model,
      promptVersion: write.source.promptVersion,
      sourceLabel: write.source.label,
      findingId: write.findingId,
      reviewedBy: reviewer.userId,
      reviewedAt: at,
    };
    const props = { ...traced, sentence: write.source.sentence };
    const merged = await mergeLink(tx, write.from, write.to, write.type, props, write.findingId);
    const written = { fromNumber: from.number, toNumber: stored.number };
    if (!merged.created) return { result: { result: merged.ours ? 'created' : 'exists', ...written }, audits: [] };
    const audit: OutboxAudit = {
      action: 'link.created',
      targetType: 'link',
      targetId: linkTargetId(write.type, write.from.id, write.to.id),
      before: null,
      after: { type: write.type, fromId: write.from.id, toId: write.to.id, ...traced },
      meta: {
        type: write.type,
        fromNumber: from.number,
        toNumber: stored.number,
        label: higherLabel(from.label, stored.label),
      },
    };
    return { result: { result: 'created', ...written }, audits: [audit] };
  });
}

/** An approved mapping to write: `SATISFIES` from a control to a requirement, or `MAPS_TO` from one
 * requirement to another. */
export interface ApprovedMappingWrite {
  findingId: string;
  type: MappingLinkType;
  fromId: string;
  toId: string;
  model: string;
  promptVersion: string;
}

/** The kind of a mapping's `from` end. */
export function mappingFromKind(type: MappingLinkType): EndKind {
  return type === 'SATISFIES' ? 'control' : 'requirement';
}

/**
 * Writes an approved mapping in one Neo4j transaction with its `link.created` entry (see the file
 * comment). Both ends are locked and checked again (`checkMappingEnds`); nothing is written when a
 * check fails.
 */
export async function writeApprovedMapping(
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>,
  reviewer: Reviewer,
  write: ApprovedMappingWrite,
  now: () => string = () => new Date().toISOString(),
): Promise<WrittenLink> {
  if (!MAPPING_TYPES.includes(write.type)) throw reviewError('link_not_allowed');
  const fromRef: EndRef = { kind: mappingFromKind(write.type), id: write.fromId };
  const toRef: EndRef = { kind: 'requirement', id: write.toId };
  return outbox.withAuditedWrites<WrittenLink>(reviewer.orgId, actorOf(reviewer), async (tx) => {
    const [from, to] = await lockEnds(tx, fromRef, toRef);
    checkMappingEnds(reviewer, from, to);
    const ends = { from: from as StoredEnd, to: to as StoredEnd };
    const at = now();
    const props = {
      createdAt: at,
      createdBy: reviewer.userId,
      origin: 'ai',
      findingId: write.findingId,
      model: write.model,
      promptVersion: write.promptVersion,
      reviewedBy: reviewer.userId,
      reviewedAt: at,
    };
    const merged = await mergeLink(tx, fromRef, toRef, write.type, props, write.findingId);
    const written = { fromNumber: ends.from.number, toNumber: ends.to.number };
    if (!merged.created) return { result: { result: merged.ours ? 'created' : 'exists', ...written }, audits: [] };
    const audit: OutboxAudit = {
      action: 'link.created',
      targetType: 'link',
      targetId: linkTargetId(write.type, write.fromId, write.toId),
      before: null,
      after: { type: write.type, fromId: write.fromId, toId: write.toId, ...props },
      meta: {
        type: write.type,
        fromNumber: ends.from.number,
        toNumber: ends.to.number,
        label: higherLabel(ends.from.label, ends.to.label),
      },
    };
    return { result: { result: 'created', ...written }, audits: [audit] };
  });
}

// ---- What a finding's approval already made ---------------------------------------------------

/** A link or mapping this finding's approval made, with its ends. */
export interface MadeLink {
  kind: 'link';
  fromId: string;
  fromNumber: string;
  toId: string;
  toNumber: string;
}

/** A record this finding's approval made. */
export interface MadeRecord {
  kind: 'record';
  recordId: string;
  number: string;
}

/** The merge this finding's approval made. */
export interface MadeMerge {
  kind: 'merge';
  keptId: string;
  keptNumber: string;
  retiredId: string;
  retiredNumber: string;
}

export type Made = MadeLink | MadeRecord | MadeMerge;

/** Where to look for what a finding's approval made, by its kind and proposal. */
export type MadeLookup =
  | { kind: 'link'; type: LinkType; documentId: string }
  | { kind: 'mapping'; type: MappingLinkType; fromId: string; toId: string }
  | { kind: 'record'; recordKind: RecordKind }
  | { kind: 'duplicate'; recordKind: RecordKind; a: string; b: string };

/**
 * What this finding's approval already made in the graph, found by the finding's ID, or null when
 * it made nothing (D45.5). Read by the writer in the org's own database: it only tells our code
 * whether the graph part is already done, and shows nothing to anyone. A link is looked for among
 * the links of its type from its document (the `sourceDocId` index), a mapping between its two
 * records, a record among those of its kind, and a merge on the two records.
 */
export async function madeByFinding(
  graph: Pick<GraphService, 'read'>,
  orgId: string,
  findingId: string,
  lookup: MadeLookup,
): Promise<Made | null> {
  return graph.read(orgId, async (tx) => {
    switch (lookup.kind) {
      case 'link': {
        if (!ONTOLOGY_TYPES.includes(lookup.type)) return null;
        const res = await tx.run(
          `MATCH (a)-[r:${lookup.type} {sourceDocId: $documentId}]->(b)
           WHERE r.findingId = $findingId
           RETURN a.id AS fromId, a.number AS fromNumber, b.id AS toId, b.number AS toNumber
           LIMIT 1`,
          { documentId: lookup.documentId, findingId },
        );
        return madeLink(res.records[0]);
      }
      case 'mapping': {
        if (!MAPPING_TYPES.includes(lookup.type)) return null;
        const res = await tx.run(
          `MATCH (a:${END_NODE_LABELS[mappingFromKind(lookup.type)]} {id: $fromId})-[r:${lookup.type}]->(b:Requirement {id: $toId})
           WHERE r.findingId = $findingId
           RETURN a.id AS fromId, a.number AS fromNumber, b.id AS toId, b.number AS toNumber
           LIMIT 1`,
          { fromId: lookup.fromId, toId: lookup.toId, findingId },
        );
        return madeLink(res.records[0]);
      }
      case 'record': {
        const res = await tx.run(
          `MATCH (n:${NODE_LABELS[lookup.recordKind]} {findingId: $findingId})
           RETURN n.id AS id, n.number AS number
           LIMIT 1`,
          { findingId },
        );
        const row = res.records[0];
        const id = row?.get('id');
        const number = row?.get('number');
        if (typeof id !== 'string' || typeof number !== 'string') return null;
        return { kind: 'record', recordId: id, number };
      }
      case 'duplicate': {
        const label = NODE_LABELS[lookup.recordKind];
        const res = await tx.run(
          `MATCH (o:${label}) WHERE o.id IN $ids AND o.mergeFindingId = $findingId AND o.status = 'retired'
           MATCH (k:${label} {id: o.mergedInto}) WHERE k.id IN $ids
           RETURN k.id AS keptId, k.number AS keptNumber, o.id AS retiredId, o.number AS retiredNumber
           LIMIT 1`,
          { ids: [lookup.a, lookup.b], findingId },
        );
        const row = res.records[0];
        if (!row) return null;
        const keptId = row.get('keptId');
        const keptNumber = row.get('keptNumber');
        const retiredId = row.get('retiredId');
        const retiredNumber = row.get('retiredNumber');
        if (
          typeof keptId !== 'string' ||
          typeof keptNumber !== 'string' ||
          typeof retiredId !== 'string' ||
          typeof retiredNumber !== 'string'
        ) {
          return null;
        }
        return { kind: 'merge', keptId, keptNumber, retiredId, retiredNumber };
      }
    }
  });
}

function madeLink(row: { get: (key: string) => unknown } | undefined): MadeLink | null {
  if (!row) return null;
  const fromId = row.get('fromId');
  const fromNumber = row.get('fromNumber');
  const toId = row.get('toId');
  const toNumber = row.get('toNumber');
  if (
    typeof fromId !== 'string' ||
    typeof fromNumber !== 'string' ||
    typeof toId !== 'string' ||
    typeof toNumber !== 'string'
  ) {
    return null;
  }
  return { kind: 'link', fromId, fromNumber, toId, toNumber };
}
