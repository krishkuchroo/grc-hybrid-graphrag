// Reading the Analyst review queue (S5-002; D16, D24, D38, D45.3, D47, D50, D51, D52.5, D55, D57,
// D73, D163, D186): the paged list of findings, one finding in full, and the pending counts.
// - Who: the route needs the Review-queue `view` cell (Admin and Analyst; the guard refuses every
//   other role), and the service checks `canViewReviewQueue` again (403).
// - The org wall and labels: every Postgres read runs in the reader's own org context
//   (`withOrgContext`), so row security on `review_findings` checks the org, the Review-queue cell
//   and the label (D73), and our code asks again for the reader's own org and the labels at or
//   below their clearance (D45.3). A finding that fails either is 404, the same as a missing one or
//   another org's, and is missing from the list, its `total` and the counts.
// - Records a finding names (link ends and their candidates, the duplicate pair, the mapping ends)
//   are read from Neo4j in one batch per page, as the reader's own role x clearance account
//   (./queue-graph.ts). One the read doesn't find (relabelled above the reader's clearance, a type
//   their role can't view, or gone) is `{ hidden: true }`, with no number or name. The names and
//   numbers stored in a proposal are never shown: only what the reader's read finds now. A
//   decision's outcome (which holds record numbers) is shown only when that read finds every record
//   it names.
// - The document and the chunk are read in the reader's context too, with the role's view of their
//   record type and the label checked by our code and by row security; one the reader can't read
//   is left out (`null`), and so is the sentence when its chunk is.
// - The list's filters (kind, status, document, record, failed check) and sort come from S5-001's
//   list query. The record filter matches any record the finding names: an end, a candidate, the
//   duplicate pair, the mapping ends, what its approval made, or (for a link) the record approved
//   from the proposed record an end points to. A record the reader can't see matches nothing.
// - The counts are the pending findings per kind in the reader's view, with the list's own
//   visibility rules, so each equals the list's total for that kind.
// - Logs (D163): IDs, counts and codes only, never a name, a sentence, a chunk or a note.
import {
  LABELS,
  REVIEW_FINDING_KINDS,
  can,
  canViewReviewQueue,
  duplicateProposalSchema,
  isVisible,
  linkProposalSchema,
  mappingProposalSchema,
  outcomeSchemas,
  parseReviewListQuery,
  recordProposalSchema,
  type DuplicateProposal,
  type DuplicateRecordDetail,
  type HiddenRecord,
  type Label,
  type LinkEndDetail,
  type LinkEndProposal,
  type LinkEndSummary,
  type LinkProposal,
  type MappingEndDetail,
  type MappingProposal,
  type NamedRecord,
  type OutcomeOf,
  type PagedReviewFindings,
  type PointingLinkFinding,
  type RecordProposal,
  type ReviewChunk,
  type ReviewCounts,
  type ReviewDocument,
  type ReviewFindingDetail,
  type ReviewFindingKind,
  type ReviewFindingRow,
  type ReviewFindingStatus,
  type ReviewListQuery,
  type ReviewPerson,
  type ReviewRecordKind,
  type ReviewSourceDocument,
} from '@grc/shared';
import { and, arrayContains, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { ApiError, errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member, user } from '../../identity/schema.js';
import { documents, type UploaderType } from '../../intake/intake.schema.js';
import { chunks, reviewFindings, type ReviewFindingRow as FindingDbRow } from '../../processing/processing.schema.js';
import type { Caller } from '../../records/records.service.js';
import {
  RecordWants,
  isRecordVisible,
  readNamedRecords,
  type GraphRecord,
  type QueueViewer,
  type RecordLookup,
} from './queue-graph.js';
import { locateSentence } from './sentence-place.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most link findings a proposed record's detail lists (its count is always the full one). */
export const MAX_POINTING_LINK_FINDINGS = 100;

const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You do not have permission to do this.');
const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The finding was not found.');

const HIDDEN: HiddenRecord = Object.freeze({ hidden: true as const });

/** A stored finding whose proposal doesn't fit its kind's shape (never shown, never guessed). */
export class ReviewFindingUnreadable extends Error {
  readonly code = 'review_finding_unreadable';

  constructor() {
    super('A review finding could not be read.');
    this.name = 'ReviewFindingUnreadable';
  }
}

/** A finding with its proposal read in its kind's shape. */
type ParsedFinding =
  | { row: FindingDbRow; kind: 'link'; proposal: LinkProposal }
  | { row: FindingDbRow; kind: 'record'; proposal: RecordProposal }
  | { row: FindingDbRow; kind: 'duplicate'; proposal: DuplicateProposal }
  | { row: FindingDbRow; kind: 'mapping'; proposal: MappingProposal };

/** A document as the reader may read it. */
export interface DocumentInfo {
  id: string;
  fileName: string;
  kind: ReviewSourceDocument['kind'];
  label: Label;
  uploaderType: UploaderType;
  uploaderId: string;
  createdAt: Date;
}

/** What the Postgres side of a page knows besides its rows. */
export interface PageFacts {
  documents: Map<string, DocumentInfo>;
  /** The statuses of the `record` findings that link ends point to, as the reader sees them. */
  recordFindings: Map<string, ReviewFindingStatus>;
  /** How many visible link findings point to each `record` finding. */
  pointing: Map<string, number>;
  /** People's display names, by user ID. */
  people: Map<string, string>;
}

export interface ReviewQueueServiceDeps {
  db: Db;
  graph: Pick<GraphService, 'readAs'>;
  log?: Logger;
}

export function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

export function viewerOf(caller: Caller): QueueViewer {
  return { orgId: caller.orgId, role: caller.role, clearance: caller.clearance };
}

/** The labels at or below the reader's clearance (D51). */
export function visibleLabels(caller: Caller): Label[] {
  return LABELS.filter((label) => isVisible(caller.clearance, label));
}

function unique<T>(values: Iterable<T | null | undefined>): T[] {
  const out = new Set<T>();
  for (const v of values) if (v !== null && v !== undefined) out.add(v);
  return [...out];
}

/** `<column> @> <value>` for a jsonb column, the value sent as a parameter. */
function contains(column: AnyPgColumn, value: object): SQL {
  return sql`${column} @> ${JSON.stringify(value)}::jsonb`;
}

/** A mapping's `from` end is a control (SATISFIES) or a requirement (MAPS_TO); `to` is a requirement. */
function mappingFromKind(type: MappingProposal['type']): ReviewRecordKind {
  return type === 'SATISFIES' ? 'control' : 'requirement';
}

function parseFinding(row: FindingDbRow): ParsedFinding {
  switch (row.kind) {
    case 'link': {
      const p = linkProposalSchema.safeParse(row.proposal);
      if (p.success) return { row, kind: 'link', proposal: p.data };
      break;
    }
    case 'record': {
      const p = recordProposalSchema.safeParse(row.proposal);
      if (p.success) return { row, kind: 'record', proposal: p.data };
      break;
    }
    case 'duplicate': {
      const p = duplicateProposalSchema.safeParse(row.proposal);
      if (p.success) return { row, kind: 'duplicate', proposal: p.data };
      break;
    }
    case 'mapping': {
      const p = mappingProposalSchema.safeParse(row.proposal);
      if (p.success) return { row, kind: 'mapping', proposal: p.data };
      break;
    }
  }
  throw new ReviewFindingUnreadable();
}

/** The records a finding names: link ends (and, with `candidates`, their candidates), the duplicate
 * pair and the mapping ends. */
function addWants(wants: RecordWants, finding: ParsedFinding, candidates: boolean): void {
  switch (finding.kind) {
    case 'link':
      for (const end of [finding.proposal.from, finding.proposal.to]) addEndWants(wants, end, candidates);
      return;
    case 'duplicate':
      wants.add(finding.proposal.kind, finding.proposal.kept.recordId);
      wants.add(finding.proposal.kind, finding.proposal.other.recordId);
      return;
    case 'mapping':
      wants.add(mappingFromKind(finding.proposal.type), finding.proposal.from.recordId);
      wants.add('requirement', finding.proposal.to.recordId);
      return;
    case 'record':
      return;
  }
}

function addEndWants(wants: RecordWants, end: LinkEndProposal, candidates: boolean): void {
  wants.add(end.kind, end.match?.recordId);
  if (candidates) for (const c of end.candidates) wants.add(end.kind, c.recordId);
}

function named(records: RecordLookup, kind: ReviewRecordKind, id: string): NamedRecord {
  return records.shown(kind, id) ?? HIDDEN;
}

/** A link end as the list shows it: its matched record (or hidden), the proposed record it points
 * to with that finding's status, or how many candidates it has. */
export function endSummary(end: LinkEndProposal, records: RecordLookup, facts: PageFacts): LinkEndSummary {
  const base = { kind: end.kind, name: end.name };
  if (end.match) {
    const record = records.shown(end.kind, end.match.recordId);
    return record ? { ...base, state: 'matched', record } : { ...base, state: 'hidden' };
  }
  if (end.recordFindingId !== null) {
    const status = facts.recordFindings.get(end.recordFindingId);
    return status !== undefined
      ? { ...base, state: 'proposed', findingId: end.recordFindingId, status }
      : { ...base, state: 'hidden' };
  }
  return { ...base, state: 'candidates', candidateCount: end.candidates.length };
}

/** A link end in full: the list's, plus each candidate as the reader may see it, with its step and score. */
function endDetail(end: LinkEndProposal, records: RecordLookup, facts: PageFacts): LinkEndDetail {
  const candidates = end.candidates.map((c) => ({
    record: named(records, end.kind, c.recordId),
    step: c.step,
    score: c.score,
  }));
  return { ...endSummary(end, records, facts), candidates };
}

function sourceDocument(row: FindingDbRow, facts: PageFacts): ReviewSourceDocument | null {
  const doc = row.documentId !== null ? facts.documents.get(row.documentId) : undefined;
  return doc ? { id: doc.id, name: doc.fileName, kind: doc.kind } : null;
}

function person(id: string | null, facts: PageFacts): ReviewPerson | null {
  return id === null ? null : { id, name: facts.people.get(id) ?? null };
}

/** The fields every row has. */
function rowBase(row: FindingDbRow, facts: PageFacts) {
  return {
    id: row.id,
    status: row.status,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    decidedBy: person(row.decidedBy, facts),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    document: sourceDocument(row, facts),
  };
}

/** One finding as the list shows it. */
function toRow(finding: ParsedFinding, records: RecordLookup, facts: PageFacts): ReviewFindingRow {
  const base = rowBase(finding.row, facts);
  switch (finding.kind) {
    case 'link':
      return {
        ...base,
        kind: 'link',
        summary: {
          type: finding.proposal.type,
          failedChecks: [...finding.row.failedChecks],
          from: endSummary(finding.proposal.from, records, facts),
          to: endSummary(finding.proposal.to, records, facts),
        },
      };
    case 'record':
      return {
        ...base,
        kind: 'record',
        summary: {
          recordKind: finding.proposal.kind,
          name: finding.proposal.name,
          linkFindingCount: facts.pointing.get(finding.row.id) ?? 0,
        },
      };
    case 'duplicate':
      return {
        ...base,
        kind: 'duplicate',
        summary: {
          recordKind: finding.proposal.kind,
          kept: named(records, finding.proposal.kind, finding.proposal.kept.recordId),
          other: named(records, finding.proposal.kind, finding.proposal.other.recordId),
          step: finding.proposal.step,
          score: finding.proposal.score,
        },
      };
    case 'mapping':
      return {
        ...base,
        kind: 'mapping',
        summary: {
          type: finding.proposal.type,
          from: named(records, mappingFromKind(finding.proposal.type), finding.proposal.from.recordId),
          to: named(records, 'requirement', finding.proposal.to.recordId),
        },
      };
  }
}

/** The stored outcome in its kind's shape, or null when there is none (or it doesn't fit). */
function outcomeOf<K extends ReviewFindingKind>(kind: K, raw: unknown): OutcomeOf<K> | null {
  if (raw === null || raw === undefined) return null;
  const schema: z.ZodType = outcomeSchemas[kind];
  const parsed = schema.safeParse(raw);
  return parsed.success ? (parsed.data as OutcomeOf<K>) : null;
}

/** The records a decision's outcome names, by kind and ID (each kind is the finding's own). */
function outcomeRecords(finding: ParsedFinding): Array<{ kind: ReviewRecordKind; id: unknown }> {
  const raw = finding.row.outcome;
  if (raw === null || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  switch (finding.kind) {
    case 'link':
      return [
        { kind: finding.proposal.from.kind, id: o['fromId'] },
        { kind: finding.proposal.to.kind, id: o['toId'] },
      ];
    case 'mapping':
      return [
        { kind: mappingFromKind(finding.proposal.type), id: o['fromId'] },
        { kind: 'requirement', id: o['toId'] },
      ];
    case 'record':
      return [{ kind: finding.proposal.kind, id: o['recordId'] }];
    case 'duplicate':
      return [
        { kind: finding.proposal.kind, id: o['keptId'] },
        { kind: finding.proposal.kind, id: o['retiredId'] },
      ];
  }
}

/** The outcome only when the reader's read finds every record it names; otherwise null, so a record
 * relabelled above their clearance (or of a type they can't view) is never shown by its number. */
function visibleOutcome<T>(outcome: T | null, finding: ParsedFinding, records: RecordLookup): T | null {
  if (outcome === null) return null;
  const seen = outcomeRecords(finding).every(
    ({ kind, id }) => typeof id === 'string' && records.get(kind, id) !== undefined,
  );
  return seen ? outcome : null;
}

function duplicateRecord(record: GraphRecord | undefined, facts: PageFacts): DuplicateRecordDetail {
  if (!record) return HIDDEN;
  return {
    recordId: record.id,
    number: record.number,
    name: record.name,
    kind: record.kind,
    label: record.label,
    status: record.status,
    owner: { id: record.owner ?? '', name: record.owner !== null ? (facts.people.get(record.owner) ?? null) : null },
    sourceIds: record.sourceIds,
    linkCount: record.linkCount ?? 0,
  };
}

function mappingEnd(record: GraphRecord | undefined): MappingEndDetail {
  if (!record) return HIDDEN;
  return {
    recordId: record.id,
    number: record.number,
    name: record.name,
    kind: record.kind,
    label: record.label,
    status: record.status,
    framework: record.framework,
    code: record.code,
    title: record.kind === 'requirement' ? record.title : null,
  };
}

/** The reader's org and the labels at or below their clearance: our own check, before row security's
 * (the queue's visibility, used by the chat's pending links too). */
export function findingVisibility(caller: Caller, labels: readonly Label[]): SQL {
  return and(eq(reviewFindings.orgId, caller.orgId), inArray(reviewFindings.label, [...labels]))!;
}

/** The documents the reader may read: their own org, a record type their role views, a label at or
 * below their clearance; row security checks the same again. */
export async function readVisibleDocuments(
  tx: Tx,
  caller: Caller,
  labels: readonly Label[],
  ids: readonly string[],
): Promise<Map<string, DocumentInfo>> {
  const out = new Map<string, DocumentInfo>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      id: documents.id,
      fileName: documents.fileName,
      kind: documents.kind,
      recordType: documents.recordType,
      label: documents.label,
      uploaderType: documents.uploaderType,
      uploaderId: documents.uploaderId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(eq(documents.orgId, caller.orgId), inArray(documents.id, [...ids]), inArray(documents.label, [...labels])),
    );
  for (const r of rows) {
    if (!can(caller.role, r.recordType, 'view') || !isVisible(caller.clearance, r.label)) continue;
    out.set(r.id, {
      id: r.id,
      fileName: r.fileName,
      kind: r.kind,
      label: r.label,
      uploaderType: r.uploaderType,
      uploaderId: r.uploaderId,
      createdAt: r.createdAt,
    });
  }
  return out;
}

export class ReviewQueueService {
  private readonly db: Db;
  private readonly graph: Pick<GraphService, 'readAs'>;
  private readonly log: Logger;

  constructor(deps: ReviewQueueServiceDeps) {
    this.db = deps.db;
    this.graph = deps.graph;
    this.log = deps.log ?? createLogger().child({ context: 'ReviewQueueService' });
  }

  /** `GET /api/v1/review/findings`: the reader's findings, paged, filtered and sorted. */
  async list(caller: Caller, query: unknown): Promise<PagedReviewFindings> {
    if (!canViewReviewQueue(caller.role)) throw FORBIDDEN();
    const q = parseReviewListQuery(query);
    const empty: PagedReviewFindings = { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
    const labels = visibleLabels(caller);
    if (labels.length === 0) return empty;
    // A record the reader can't see now matches nothing, so the filter can't tell what names it.
    const recordId = q.recordId;
    if (recordId !== undefined) {
      const visible = await this.readGraph(caller, () => isRecordVisible(this.graph, viewerOf(caller), recordId));
      if (!visible) return empty;
    }

    const page = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const where = and(this.visibility(caller, labels), await this.filters(tx, caller, q))!;
      const order =
        q.sort === 'oldest'
          ? [asc(reviewFindings.createdAt), asc(reviewFindings.id)]
          : [desc(reviewFindings.createdAt), desc(reviewFindings.id)];
      const [counted] = await tx.select({ total: count() }).from(reviewFindings).where(where);
      const rows = await tx
        .select()
        .from(reviewFindings)
        .where(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const findings = rows.map((row) => this.parse(caller, row));
      const facts = await this.pageFacts(tx, caller, labels, findings, { uploaders: false });
      return { total: Number(counted?.total ?? 0), findings, facts };
    });

    const wants = new RecordWants();
    for (const finding of page.findings) addWants(wants, finding, false);
    const records = await this.readGraph(caller, () => readNamedRecords(this.graph, viewerOf(caller), wants));
    return {
      items: page.findings.map((f) => toRow(f, records, page.facts)),
      page: q.page,
      pageSize: q.pageSize,
      total: page.total,
    };
  }

  /** `GET /api/v1/review/findings/:id`: one finding in full; 404 when hidden, missing or another org's. */
  async get(caller: Caller, id: string): Promise<ReviewFindingDetail> {
    if (!canViewReviewQueue(caller.role)) throw FORBIDDEN();
    const labels = visibleLabels(caller);
    if (typeof id !== 'string' || !UUID.test(id.toLowerCase()) || labels.length === 0) throw NOT_FOUND();
    const findingId = id.toLowerCase();

    const loaded = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [row] = await tx
        .select()
        .from(reviewFindings)
        .where(and(eq(reviewFindings.id, findingId), this.visibility(caller, labels)))
        .limit(1);
      if (!row) return null;
      const finding = this.parse(caller, row);
      const pointing = finding.kind === 'record' ? await this.pointingLinks(tx, caller, labels, finding.row.id) : [];
      const facts = await this.pageFacts(tx, caller, labels, [finding, ...pointing], { uploaders: true });
      const chunk = finding.kind === 'link' ? await this.readChunk(tx, caller, labels, finding.row) : null;
      return { finding, pointing, facts, chunk };
    });
    if (!loaded) throw NOT_FOUND();
    const { finding, pointing, facts, chunk } = loaded;

    const wants = new RecordWants();
    addWants(wants, finding, true);
    for (const { kind, id } of outcomeRecords(finding)) if (typeof id === 'string') wants.add(kind, id);
    for (const link of pointing) addWants(wants, link, false);
    const records = await this.readGraph(caller, () =>
      readNamedRecords(this.graph, viewerOf(caller), wants, { withLinkCount: finding.kind === 'duplicate' }),
    );

    // The owners of a duplicate pair are named only once the reader's read has found the records.
    if (finding.kind === 'duplicate') {
      const owners = unique(records.all().map((r) => r.owner)).filter((o) => !facts.people.has(o));
      if (owners.length > 0) {
        const names = await withOrgContext(this.db, contextOf(caller), (tx) => this.personNames(tx, caller, owners));
        for (const [k, v] of names) facts.people.set(k, v);
      }
    }

    return this.detail(caller, finding, pointing, records, facts, chunk);
  }

  /** `GET /api/v1/review/counts`: pending findings per kind, and their total, in the reader's view. */
  async counts(caller: Caller): Promise<ReviewCounts> {
    if (!canViewReviewQueue(caller.role)) throw FORBIDDEN();
    const pending: ReviewCounts['pending'] = { link: 0, record: 0, duplicate: 0, mapping: 0 };
    const labels = visibleLabels(caller);
    if (labels.length === 0) return { pending, total: 0 };
    const rows = await withOrgContext(this.db, contextOf(caller), (tx) =>
      tx
        .select({ kind: reviewFindings.kind, n: count() })
        .from(reviewFindings)
        .where(and(this.visibility(caller, labels), eq(reviewFindings.status, 'pending')))
        .groupBy(reviewFindings.kind),
    );
    let total = 0;
    for (const row of rows) {
      if (!(REVIEW_FINDING_KINDS as readonly string[]).includes(row.kind)) continue;
      const n = Number(row.n);
      pending[row.kind] = n;
      total += n;
    }
    return { pending, total };
  }

  // ---- Postgres ---------------------------------------------------------------------------------

  // The reader's org and the labels at or below their clearance: our own check, before row security's.
  private visibility(caller: Caller, labels: readonly Label[]): SQL {
    return findingVisibility(caller, labels);
  }

  // The list query's filters.
  private async filters(tx: Tx, caller: Caller, q: ReviewListQuery): Promise<SQL | undefined> {
    return and(
      inArray(reviewFindings.status, [...q.status]),
      q.kind !== undefined ? eq(reviewFindings.kind, q.kind) : undefined,
      q.documentId !== undefined ? eq(reviewFindings.documentId, q.documentId) : undefined,
      q.failedCheck !== undefined ? arrayContains(reviewFindings.failedChecks, [q.failedCheck]) : undefined,
      q.recordId !== undefined ? await this.namesRecord(tx, caller, q.recordId) : undefined,
    );
  }

  // Any record the finding names (see the top of the file).
  private async namesRecord(tx: Tx, caller: Caller, recordId: string): Promise<SQL> {
    const p = reviewFindings.proposal;
    const o = reviewFindings.outcome;
    // The proposed records approved as this record: the link findings that point to them name it too.
    const approvedAs = await tx
      .select({ id: reviewFindings.id })
      .from(reviewFindings)
      .where(and(eq(reviewFindings.orgId, caller.orgId), eq(reviewFindings.kind, 'record'), contains(o, { recordId })));
    return or(
      contains(p, { from: { match: { recordId } } }),
      contains(p, { to: { match: { recordId } } }),
      contains(p, { from: { candidates: [{ recordId }] } }),
      contains(p, { to: { candidates: [{ recordId }] } }),
      contains(p, { kept: { recordId } }),
      contains(p, { other: { recordId } }),
      contains(p, { from: { recordId } }),
      contains(p, { to: { recordId } }),
      contains(o, { recordId }),
      contains(o, { fromId: recordId }),
      contains(o, { toId: recordId }),
      contains(o, { keptId: recordId }),
      contains(o, { retiredId: recordId }),
      ...approvedAs.flatMap((r) => [
        contains(p, { from: { recordFindingId: r.id } }),
        contains(p, { to: { recordFindingId: r.id } }),
      ]),
    )!;
  }

  // Everything else a page shows from Postgres: its documents, the statuses of the proposed records
  // its link ends point to, how many link findings point to its proposed records, and people's names.
  private async pageFacts(
    tx: Tx,
    caller: Caller,
    labels: readonly Label[],
    findings: readonly ParsedFinding[],
    options: { uploaders: boolean },
  ): Promise<PageFacts> {
    const docs = await this.readDocuments(tx, caller, labels, unique(findings.map((f) => f.row.documentId)));

    const proposedIds = unique(
      findings.flatMap((f) =>
        f.kind === 'link' ? [f.proposal.from.recordFindingId, f.proposal.to.recordFindingId] : [],
      ),
    );
    const recordFindings = new Map<string, ReviewFindingStatus>();
    if (proposedIds.length > 0) {
      const rows = await tx
        .select({ id: reviewFindings.id, status: reviewFindings.status })
        .from(reviewFindings)
        .where(
          and(
            this.visibility(caller, labels),
            eq(reviewFindings.kind, 'record'),
            inArray(reviewFindings.id, proposedIds),
          ),
        );
      for (const r of rows) recordFindings.set(r.id, r.status);
    }

    const pointing = await this.pointingCounts(
      tx,
      caller,
      labels,
      findings.filter((f) => f.kind === 'record').map((f) => f.row.id),
    );

    const userIds = unique([
      ...findings.map((f) => f.row.decidedBy),
      ...(options.uploaders
        ? [...docs.values()].filter((d) => d.uploaderType === 'user').map((d) => d.uploaderId)
        : []),
    ]);
    const people = await this.personNames(tx, caller, userIds);
    if (options.uploaders) {
      const keyIds = [...docs.values()].filter((d) => d.uploaderType === 'api_key').map((d) => d.uploaderId);
      for (const [k, v] of await this.apiKeyNames(tx, caller, keyIds)) people.set(`api_key:${k}`, v);
    }
    return { documents: docs, recordFindings, pointing, people };
  }

  // The documents the reader may read (readVisibleDocuments).
  private async readDocuments(
    tx: Tx,
    caller: Caller,
    labels: readonly Label[],
    ids: readonly string[],
  ): Promise<Map<string, DocumentInfo>> {
    return readVisibleDocuments(tx, caller, labels, ids);
  }

  // How many visible link findings point to each of these proposed records (either end).
  private async pointingCounts(
    tx: Tx,
    caller: Caller,
    labels: readonly Label[],
    recordFindingIds: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (recordFindingIds.length === 0) return out;
    const result = await tx.execute<{ ref: string; n: number | string }>(sql`
      SELECT v.ref AS ref, count(DISTINCT f.id) AS n
      FROM review_findings AS f
      CROSS JOIN LATERAL (VALUES (f.proposal -> 'from' ->> 'recordFindingId'), (f.proposal -> 'to' ->> 'recordFindingId')) AS v(ref)
      WHERE f.org_id = ${caller.orgId}
        AND f.kind = 'link'
        AND f.label IN ${[...labels]}
        AND v.ref IN ${[...recordFindingIds]}
      GROUP BY v.ref`);
    for (const row of result.rows) out.set(row.ref, Number(row.n));
    return out;
  }

  // The visible link findings that point to one proposed record, newest first.
  private async pointingLinks(
    tx: Tx,
    caller: Caller,
    labels: readonly Label[],
    recordFindingId: string,
  ): Promise<ParsedFinding[]> {
    const p = reviewFindings.proposal;
    const rows = await tx
      .select()
      .from(reviewFindings)
      .where(
        and(
          this.visibility(caller, labels),
          eq(reviewFindings.kind, 'link'),
          or(contains(p, { from: { recordFindingId } }), contains(p, { to: { recordFindingId } })),
        ),
      )
      .orderBy(desc(reviewFindings.createdAt), desc(reviewFindings.id))
      .limit(MAX_POINTING_LINK_FINDINGS);
    return rows.map((row) => this.parse(caller, row));
  }

  // The link finding's chunk, if the reader may read it, with the sentence's place in its text.
  private async readChunk(
    tx: Tx,
    caller: Caller,
    labels: readonly Label[],
    row: FindingDbRow,
  ): Promise<ReviewChunk | null> {
    if (row.chunkId === null) return null;
    const [chunk] = await tx
      .select({ id: chunks.id, text: chunks.text, recordType: chunks.recordType, label: chunks.label })
      .from(chunks)
      .where(and(eq(chunks.orgId, caller.orgId), eq(chunks.id, row.chunkId), inArray(chunks.label, [...labels])))
      .limit(1);
    if (!chunk || !can(caller.role, chunk.recordType, 'view') || !isVisible(caller.clearance, chunk.label)) return null;
    return {
      id: chunk.id,
      text: chunk.text,
      sentenceAt: row.sentence !== null ? locateSentence(chunk.text, row.sentence) : null,
    };
  }

  // The display names of these members of the reader's org.
  private async personNames(tx: Tx, caller: Caller, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, caller.orgId), inArray(user.id, [...ids])));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // The names of these API keys of the reader's org.
  private async apiKeyNames(tx: Tx, caller: Caller, ids: readonly string[]): Promise<Map<string, string>> {
    const keys = unique(ids.filter((id) => UUID.test(id)));
    if (keys.length === 0) return new Map();
    const rows = await tx
      .select({ id: apiKeys.id, name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, caller.orgId), inArray(apiKeys.id, keys)));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ---- Building the detail ------------------------------------------------------------------------

  private detail(
    caller: Caller,
    finding: ParsedFinding,
    pointing: readonly ParsedFinding[],
    records: RecordLookup,
    facts: PageFacts,
    chunk: ReviewChunk | null,
  ): ReviewFindingDetail {
    const row = finding.row;
    const base = {
      ...rowBase(row, facts),
      document: this.documentDetail(row, facts),
      // The sentence is the chunk's text: shown only with a chunk the reader may read.
      sentence: chunk !== null ? row.sentence : null,
      chunk,
      model: row.model,
      promptVersion: row.promptVersion,
      note: row.decisionNote,
    };
    switch (finding.kind) {
      case 'link':
        return {
          ...base,
          kind: 'link',
          summary: {
            type: finding.proposal.type,
            failedChecks: [...row.failedChecks],
            from: endDetail(finding.proposal.from, records, facts),
            to: endDetail(finding.proposal.to, records, facts),
          },
          outcome: visibleOutcome(outcomeOf('link', row.outcome), finding, records),
        };
      case 'record':
        return {
          ...base,
          kind: 'record',
          summary: {
            recordKind: finding.proposal.kind,
            name: finding.proposal.name,
            linkFindingCount: facts.pointing.get(row.id) ?? 0,
            details: finding.proposal.details ?? null,
            linkFindings: pointing.flatMap((link) => this.pointingLink(caller, link, row.id, records, facts)),
          },
          outcome: visibleOutcome(outcomeOf('record', row.outcome), finding, records),
        };
      case 'duplicate':
        return {
          ...base,
          kind: 'duplicate',
          summary: {
            recordKind: finding.proposal.kind,
            kept: duplicateRecord(records.get(finding.proposal.kind, finding.proposal.kept.recordId), facts),
            other: duplicateRecord(records.get(finding.proposal.kind, finding.proposal.other.recordId), facts),
            step: finding.proposal.step,
            score: finding.proposal.score,
          },
          outcome: visibleOutcome(outcomeOf('duplicate', row.outcome), finding, records),
        };
      case 'mapping':
        return {
          ...base,
          kind: 'mapping',
          summary: {
            type: finding.proposal.type,
            reason: finding.proposal.reason,
            from: mappingEnd(records.get(mappingFromKind(finding.proposal.type), finding.proposal.from.recordId)),
            to: mappingEnd(records.get('requirement', finding.proposal.to.recordId)),
          },
          outcome: visibleOutcome(outcomeOf('mapping', row.outcome), finding, records),
        };
    }
  }

  // The source document in full: its label, uploader (with name where it can be found) and upload time.
  private documentDetail(row: FindingDbRow, facts: PageFacts): ReviewDocument | null {
    const doc = row.documentId !== null ? facts.documents.get(row.documentId) : undefined;
    if (!doc) return null;
    const name =
      doc.uploaderType === 'user'
        ? (facts.people.get(doc.uploaderId) ?? null)
        : doc.uploaderType === 'api_key'
          ? (facts.people.get(`api_key:${doc.uploaderId}`) ?? null)
          : null;
    return {
      id: doc.id,
      name: doc.fileName,
      kind: doc.kind,
      label: doc.label,
      uploader: { type: doc.uploaderType, id: doc.uploaderId, name },
      uploadedAt: doc.createdAt.toISOString(),
    };
  }

  // A link finding pointing to the proposed record: which end it is, and the other end.
  private pointingLink(
    caller: Caller,
    link: ParsedFinding,
    recordFindingId: string,
    records: RecordLookup,
    facts: PageFacts,
  ): PointingLinkFinding[] {
    if (link.kind !== 'link') return [];
    const side = link.proposal.from.recordFindingId === recordFindingId ? 'from' : 'to';
    if (link.proposal[side].recordFindingId !== recordFindingId) {
      this.log.warn({ orgId: caller.orgId, findingId: link.row.id }, 'a pointing link finding names neither end');
      return [];
    }
    const other = side === 'from' ? link.proposal.to : link.proposal.from;
    return [
      {
        id: link.row.id,
        status: link.row.status,
        type: link.proposal.type,
        side,
        other: endSummary(other, records, facts),
      },
    ];
  }

  // ---- Errors -----------------------------------------------------------------------------------

  private parse(caller: Caller, row: FindingDbRow): ParsedFinding {
    try {
      return parseFinding(row);
    } catch (err) {
      this.log.error(
        { orgId: caller.orgId, findingId: row.id, kind: row.kind, code: 'review_finding_unreadable' },
        'a review finding does not fit its kind',
      );
      throw err;
    }
  }

  // A graph read; a failure is logged by its type or code and the org only, and answered as 500.
  private async readGraph<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.log.error({ ...errorKind(err), orgId: caller.orgId }, 'the review queue could not read the graph');
      throw err;
    }
  }
}
