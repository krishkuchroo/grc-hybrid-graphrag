// Taking AI facts back out (S5-004; D24, D37, D38, D45.3, D45.5, D45.7, D50, D51, D52.5, D56, D69,
// D163, D201, D207). The only way an AI link ever leaves the graph (D207).
//
// Removing one finding (`removeFinding`, the Analyst's Review-queue `work` cell):
//   1. The finding's row is locked in the Analyst's own org context (`SELECT … FOR UPDATE`; RLS and
//      our code check its label, 404 when hidden, missing or another org's), and `canRemove` must
//      allow its kind and status: a live or approved link or mapping, or an approved new record
//      (409 `not_removable` for a duplicate or a pending finding, 409 `already_decided` for one
//      already rejected or removed, as for the loser of two removals at once).
//   2. The records it names are read as they stand now (following `mergedInto`), and the Analyst
//      must see them, by our check and through their own read-only account (404 otherwise, D57).
//   3. One Neo4j transaction, as the writer with the Analyst as the actor: for a link or mapping,
//      the finding's own AI link is deleted with its `link.removed` copy (./remove-graph.ts; a link
//      that was already there from elsewhere, outcome `exists` or not origin `ai`, is never
//      deleted); for a record, the record its approval created is retired with `record.retired`
//      (planner's reading S5-Q4), unless it already is. Its links stay.
//   4. In the Postgres transaction that holds the lock: the finding becomes `removed`, with the
//      decider, time, note and outcome (`removed.graph`), and its `review.removed` entry. S4 never
//      raises or makes live a removed proposal again (S4-008).
//
// The impact of one upload (`documentImpact`, Review-queue `view`: Admin and Analyst): the document,
// if the reader may see it (S3's rule: an upload kind, never evidence, whose record type the role
// views and whose label is at or below the clearance; 404 otherwise), and how much removing it
// would touch.
//
// Removing everything from one upload (`removeDocument`, D52.5, the Analyst only), each step safe
// to repeat:
//   1. The document becomes `removed`, in the Analyst's own view (404 when hidden). From then on
//      every S4 step for it ends without doing anything (processing/reader, embed, extract and
//      decide check the status, the last two inside their own transactions).
//   2-6 run in one Postgres transaction under the review removal context (below), which holds the
//      document's row and the document's open findings locked, so a second removal waits for this
//      one, S4's steps wait and then find the document removed, and a decision under way on one of
//      its findings finishes first (a new one waits and then finds it decided):
//   2. Every AI link in the org's graph whose `sourceDocId` is the document is deleted, in batches,
//      each batch one Neo4j transaction with its `link.removed` entries.
//   3. Every record created by approving one of its `record` findings is retired, with
//      `record.retired`.
//   4. Its pending findings become `rejected`, its live and approved ones `removed`, with the
//      Analyst as the decider and the note.
//   5. The chunk-to-record rows of its chunks are deleted. The chunks stay (findings point to them).
//   6. One `document.removed` entry holds the counts and the note (its source ID makes it one per
//      document, however often the removal runs).
//   It answers with the counts. These include links and records above the Analyst's clearance
//   (planner's reading S5-Q1): counts only, never a name or a number. A second run finds nothing
//   left to do and answers zero counts. The stored file is kept (S5-Q7), and a repeat upload of the
//   same file finds the removed document and doesn't bring it back (S3's content hash).
//
// The review removal context: Admin at Restricted inside the org, as `system:review`. Steps 2-6 must
// reach every finding and chunk-to-record row of the document, whatever their labels (S5-Q1), and
// they only run after the Analyst passed the guard's `work` cell and saw the document in their own
// view. The org wall still holds (every statement also names the org). Graph writes are always the
// writer's; the Analyst is the actor of every entry.
//
// Logs (D163): IDs, counts and codes only; never a sentence, a chunk, a record's name or a note.
import {
  DOCUMENT_RECORD_TYPE,
  LABELS,
  REVIEW_AUDIT_ACTIONS,
  REVIEW_DOCUMENT_TARGET_TYPE,
  REVIEW_ERRORS,
  REVIEW_FINDING_KINDS,
  REVIEW_FINDING_TARGET_TYPE,
  ROLE_TABLE,
  UPLOAD_KINDS,
  can,
  canRemove,
  canViewReviewQueue,
  canWorkReviewQueue,
  documentRemoveBodySchema,
  isRecordVisible,
  isReviewFindingKind,
  isRole,
  isSubject,
  isVisible,
  linkOutcomeSchema,
  linkProposalSchema,
  mappingOutcomeSchema,
  mappingProposalSchema,
  recordOutcomeSchema,
  removeBodySchema,
  reviewOutcomeSchema,
  type LinkOutcome,
  type MappingOutcome,
  type RecordOutcome,
  type RemovalGraphResult,
  type ReviewDocumentImpact,
  type ReviewErrorCode,
  type ReviewOutcome,
} from '@grc/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z, ZodError } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuditActor, AuditOutbox } from '../../audit/outbox.js';
import { ApiError, errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext, type Tx } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member, user } from '../../identity/schema.js';
import { documents, type DocumentRow } from '../../intake/intake.schema.js';
import {
  chunkRecords,
  chunks,
  reviewFindings,
  type ReviewFindingRow as FindingRow,
} from '../../processing/processing.schema.js';
import { isReadableDocumentKind } from '../../processing/reader/readable-kinds.js';
import type { Caller } from '../../records/records.service.js';
import { visibleLabels } from '../../records/record-queries.js';
import {
  RECORD_NODE_LABELS,
  RECORD_RETIRE_BATCH,
  DOCUMENT_LINK_BATCH,
  SOURCED_LINK_TYPES,
  aiLinkRemovedAudit,
  countDocumentLinks,
  currentIds,
  currentNode,
  deleteDocumentLinks,
  deleteFindingLink,
  readNode,
  recordTypeOfLabel,
  retireRecord,
  type DeletedLink,
  type FindingLinkMatch,
  type FindingNodeLabel,
  type GraphNode,
} from './remove-graph.js';

/** Neo4j stops the Analyst's own visibility read after this long (D48). */
export const REMOVAL_READ_TIMEOUT_MS = 5000;

/** How many times a batch of graph work is tried when a concurrent change makes it fail. */
const GRAPH_BATCH_TRIES = 3;

/** The user ID the review removal context runs as. */
export const REVIEW_REMOVAL_USER_ID = 'system:review';

/** The review removal context (see the top of the file): the org wall still applies, and Admin at
 * Restricted reaches every finding and chunk-to-record row of the document inside the org. */
export function REVIEW_REMOVAL_CONTEXT(orgId: string): OrgContext {
  return { orgId, userId: REVIEW_REMOVAL_USER_ID, role: 'admin', clearance: 'restricted' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateTime = z.iso.datetime({ offset: true });
const count = z.int().min(0);

/** The answer to removing one finding: its new status, the decision's time and the outcome. */
export const findingRemovedSchema = z.object({
  id: z.uuid(),
  kind: z.enum(REVIEW_FINDING_KINDS),
  status: z.literal('removed'),
  decidedAt: dateTime,
  outcome: reviewOutcomeSchema,
});

/** The answer to removing one upload: what this run did, as counts only. */
export const documentRemovedSchema = z.object({
  documentId: z.uuid(),
  status: z.literal('removed'),
  counts: z.object({
    /** AI links deleted from the graph. */
    aiLinksDeleted: count,
    /** Records approved from the document's findings that were retired. */
    recordsRetired: count,
    /** Pending findings rejected. */
    findingsRejected: count,
    /** Live and approved findings removed. */
    findingsRemoved: count,
    /** Chunk-to-record rows deleted. */
    chunkRecordsDeleted: count,
  }),
});

export type FindingRemoved = z.infer<typeof findingRemovedSchema>;
export type DocumentRemoved = z.infer<typeof documentRemovedSchema>;
export type DocumentRemovalCounts = DocumentRemoved['counts'];

export interface ReviewRemoveServiceDeps {
  db: Db;
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>;
  audit: Pick<AuditService, 'appendInTx'>;
  log?: Logger;
  now?: () => Date;
}

/** How a finding's graph fact is taken back out. */
type RemovalPlan = LinkPlan | RecordPlan;

interface LinkPlan {
  kind: 'link' | 'mapping';
  type: string;
  from: { id: string; labels: readonly FindingNodeLabel[] };
  to: { id: string; labels: readonly FindingNodeLabel[] };
  /** Approving it wrote nothing: the link was already there from elsewhere, so nothing goes. */
  exists: boolean;
  match: FindingLinkMatch;
  /** The outcome before the removal. */
  base: Omit<LinkOutcome, 'removed'> | Omit<MappingOutcome, 'removed'>;
}

interface RecordPlan {
  kind: 'record';
  recordId: string;
  base: Omit<RecordOutcome, 'removed'>;
}

const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You do not have permission to do this.');
const FINDING_NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The finding was not found.');
const RECORD_NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const DOCUMENT_NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The document was not found.');
const DOCUMENT_NOT_REMOVABLE = (): ApiError =>
  new ApiError(
    409,
    'not_removable',
    'Only policy documents, SOC tickets and audit reports can be removed here: nothing else from an upload goes through the AI.',
  );

function reviewError(code: ReviewErrorCode): ApiError {
  const { status, message } = REVIEW_ERRORS[code];
  return new ApiError(status, code, message);
}

/** Why a finding can't be removed: one already decided for good, or a kind or status that never is. */
function refusal(kind: string, status: string): ApiError {
  if (isReviewFindingKind(kind) && kind !== 'duplicate' && (status === 'rejected' || status === 'removed')) {
    return reviewError('already_decided');
  }
  return reviewError('not_removable');
}

function uuidOrNull(id: unknown): string | null {
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
}

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

function actorOf(caller: Caller): AuditActor {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

/** Our code's own check of one record (D50, D51), with ownership for an "own" cell. */
function visibleTo(caller: Caller, node: GraphNode): boolean {
  return isRecordVisible(
    { role: caller.role, clearance: caller.clearance },
    { recordType: recordTypeOfLabel(node.nodeLabel), label: node.label, isOwner: node.owner === caller.userId },
  );
}

/** Whether the role's cell for the record type is an "own" cell (no shared account can read it). */
function isOwnCell(role: string, recordType: string): boolean {
  return isRole(role) && isSubject(recordType) && ROLE_TABLE[recordType][role] === 'edit_own';
}

/** The ends of a mapping type: a control to a requirement, or a requirement to a requirement. */
function mappingEnds(type: string): { from: FindingNodeLabel[]; to: FindingNodeLabel[] } {
  return type === 'SATISFIES'
    ? { from: ['Control'], to: ['Requirement'] }
    : { from: ['Requirement'], to: ['Requirement'] };
}

/** How a finding's fact is taken back out; null when the stored finding doesn't say (fail safe:
 * nothing is removed, 409 `not_removable`). */
function planFor(row: FindingRow): RemovalPlan | null {
  if (row.kind === 'record') {
    const outcome = recordOutcomeSchema.safeParse(row.outcome);
    if (!outcome.success) return null;
    return { kind: 'record', recordId: outcome.data.recordId, base: withoutRemoved(outcome.data) };
  }
  if (row.kind === 'link') {
    if (row.status === 'live') {
      const proposal = linkProposalSchema.safeParse(row.proposal);
      if (!proposal.success || row.chunkId === null) return null;
      const { type, from, to } = proposal.data;
      if (!from.match || !to.match) return null;
      return {
        kind: 'link',
        type,
        from: { id: from.match.recordId, labels: RECORD_NODE_LABELS },
        to: { id: to.match.recordId, labels: RECORD_NODE_LABELS },
        exists: false,
        match: { by: 'chunk', chunkId: row.chunkId, findingId: row.id },
        base: {
          result: 'created',
          type,
          fromId: from.match.recordId,
          fromNumber: from.match.number,
          toId: to.match.recordId,
          toNumber: to.match.number,
        },
      };
    }
    const outcome = linkOutcomeSchema.safeParse(row.outcome);
    if (!outcome.success) return null;
    return {
      kind: 'link',
      type: outcome.data.type,
      from: { id: outcome.data.fromId, labels: RECORD_NODE_LABELS },
      to: { id: outcome.data.toId, labels: RECORD_NODE_LABELS },
      exists: outcome.data.result === 'exists',
      match: { by: 'finding', findingId: row.id },
      base: withoutRemoved(outcome.data),
    };
  }
  if (row.kind === 'mapping') {
    let base: Omit<MappingOutcome, 'removed'>;
    if (row.status === 'live') {
      const proposal = mappingProposalSchema.safeParse(row.proposal);
      if (!proposal.success) return null;
      const { type, from, to } = proposal.data;
      base = {
        result: 'created',
        type,
        fromId: from.recordId,
        fromNumber: from.number,
        toId: to.recordId,
        toNumber: to.number,
      };
    } else {
      const outcome = mappingOutcomeSchema.safeParse(row.outcome);
      if (!outcome.success) return null;
      base = withoutRemoved(outcome.data);
    }
    const ends = mappingEnds(base.type);
    return {
      kind: 'mapping',
      type: base.type,
      from: { id: base.fromId, labels: ends.from },
      to: { id: base.toId, labels: ends.to },
      exists: base.result === 'exists',
      match: { by: 'finding', findingId: row.id },
      base,
    };
  }
  return null;
}

function withoutRemoved<T extends { removed?: unknown }>(outcome: T): Omit<T, 'removed'> {
  const rest: Partial<T> = { ...outcome };
  delete rest.removed;
  return rest as Omit<T, 'removed'>;
}

/** The record numbers an outcome names, for the decision entry's meta. */
function numbersOf(outcome: ReviewOutcome): string[] {
  if ('number' in outcome) return [outcome.number];
  if ('fromNumber' in outcome) return [outcome.fromNumber, outcome.toNumber];
  return [];
}

/** The outcome after the removal: the one before it with `removed.graph`. */
function removedOutcome(plan: RemovalPlan, graph: RemovalGraphResult): ReviewOutcome {
  if (plan.kind === 'record') {
    return { ...plan.base, removed: { graph: graph === 'retired' ? 'retired' : 'already_retired' } };
  }
  return { ...plan.base, removed: { graph: graph === 'deleted' ? 'deleted' : 'not_found' } } as ReviewOutcome;
}

/** Runs one batch of graph work, again if a concurrent change made it fail (it only matches what
 * is still there, so a second try is safe). */
async function withTries<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= GRAPH_BATCH_TRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      last = err;
    }
  }
  throw last;
}

/** An error without the failed work's details, for the caller (the log has the IDs). */
class RemovalFailed extends Error {
  constructor(readonly code: string | undefined) {
    super('The removal could not be saved.');
    this.name = 'RemovalFailed';
  }
}

export class ReviewRemoveService {
  private readonly db: Db;
  private readonly graph: ReviewRemoveServiceDeps['graph'];
  private readonly outbox: ReviewRemoveServiceDeps['outbox'];
  private readonly audit: ReviewRemoveServiceDeps['audit'];
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: ReviewRemoveServiceDeps) {
    this.db = deps.db;
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.audit = deps.audit;
    this.log = (deps.log ?? createLogger()).child({ context: 'ReviewRemove' });
    this.now = deps.now ?? (() => new Date());
  }

  // ---- One finding --------------------------------------------------------------------------

  /** Removes one live or approved finding's fact from the graph (see the top of the file). */
  async removeFinding(caller: Caller, id: string, body: unknown): Promise<FindingRemoved> {
    if (!canWorkReviewQueue(caller.role)) throw FORBIDDEN();
    const { note } = removeBodySchema.parse(body ?? {});
    const findingId = uuidOrNull(id);
    if (!findingId) throw FINDING_NOT_FOUND();
    try {
      const answer = await withOrgContext(this.db, contextOf(caller), async (tx) => {
        const [row] = await tx
          .select()
          .from(reviewFindings)
          .where(and(eq(reviewFindings.orgId, caller.orgId), eq(reviewFindings.id, findingId)))
          .limit(1)
          .for('update');
        if (!row || !isVisible(caller.clearance, row.label)) throw FINDING_NOT_FOUND();
        if (!canRemove(row.kind, row.status)) throw refusal(row.kind, row.status);
        const plan = planFor(row);
        if (!plan) throw reviewError('not_removable');

        const graph =
          plan.kind === 'record' ? await this.retireApproved(caller, plan) : await this.deleteOwnLink(caller, plan);
        const outcome = removedOutcome(plan, graph);
        const decidedAt = this.now();
        await tx
          .update(reviewFindings)
          .set({
            status: 'removed',
            decidedBy: caller.userId,
            decidedAt,
            decisionNote: note ?? null,
            outcome,
            updatedAt: decidedAt,
          })
          .where(and(eq(reviewFindings.orgId, caller.orgId), eq(reviewFindings.id, row.id)));
        await this.audit.appendInTx(tx, {
          orgId: caller.orgId,
          ...actorOf(caller),
          action: REVIEW_AUDIT_ACTIONS.removed,
          targetType: REVIEW_FINDING_TARGET_TYPE,
          targetId: row.id,
          before: { status: row.status },
          after: { status: 'removed', ...(note !== undefined ? { note } : {}) },
          meta: {
            kind: row.kind,
            oldStatus: row.status,
            newStatus: 'removed',
            label: row.label,
            numbers: numbersOf(outcome),
            graph,
          },
        });
        return {
          id: row.id,
          kind: row.kind,
          status: 'removed' as const,
          decidedAt: decidedAt.toISOString(),
          outcome,
          graph,
          previous: row.status,
        };
      });
      this.log.info(
        {
          orgId: caller.orgId,
          findingId: answer.id,
          kind: answer.kind,
          previousStatus: answer.previous,
          graph: answer.graph,
        },
        'a finding was removed',
      );
      return {
        id: answer.id,
        kind: answer.kind,
        status: answer.status,
        decidedAt: answer.decidedAt,
        outcome: answer.outcome,
      };
    } catch (err) {
      throw this.failed(err, 'a finding removal failed', { orgId: caller.orgId, findingId });
    }
  }

  /** A link or mapping finding: its own AI link deleted with `link.removed`, if it is there. */
  private async deleteOwnLink(caller: Caller, plan: LinkPlan): Promise<RemovalGraphResult> {
    const orgId = caller.orgId;
    const ends = await this.graph.read(orgId, async (tx) => ({
      from: await currentNode(tx, plan.from.id, plan.from.labels),
      to: await currentNode(tx, plan.to.id, plan.to.labels),
    }));
    if (!ends.from || !ends.to) throw RECORD_NOT_FOUND();
    if (!(await this.callerSees(caller, [ends.from, ends.to]))) throw RECORD_NOT_FOUND();
    if (plan.exists) return 'not_found';

    const deleted = await this.outbox.withAuditedWrites(orgId, actorOf(caller), async (tx) => {
      // Read both ends again inside the write, so a merge or relabel since the check is seen.
      const from = await currentNode(tx, plan.from.id, plan.from.labels);
      const to = await currentNode(tx, plan.to.id, plan.to.labels);
      if (!from || !to || !visibleTo(caller, from) || !visibleTo(caller, to)) throw RECORD_NOT_FOUND();
      const link = await deleteFindingLink(tx, plan.type, from, to, plan.match);
      return { result: link !== null, audits: link ? [aiLinkRemovedAudit(link)] : [] };
    });
    return deleted ? 'deleted' : 'not_found';
  }

  /** A record finding: the record its approval created retired with `record.retired`, unless it is. */
  private async retireApproved(caller: Caller, plan: RecordPlan): Promise<RemovalGraphResult> {
    const orgId = caller.orgId;
    const node = await this.graph.read(orgId, (tx) => readNode(tx, plan.recordId, RECORD_NODE_LABELS));
    if (!node || !(await this.callerSees(caller, [node]))) throw RECORD_NOT_FOUND();
    const at = this.now().toISOString();
    return this.outbox.withAuditedWrites(orgId, actorOf(caller), async (tx) => {
      const again = await readNode(tx, plan.recordId, [node.nodeLabel]);
      if (!again || !visibleTo(caller, again)) throw RECORD_NOT_FOUND();
      const retired = await retireRecord(tx, again.id, [again.nodeLabel], caller.userId, at);
      return {
        result: retired.result,
        audits: retired.result === 'retired' ? [retired.audit] : [],
      };
    });
  }

  /**
   * Whether the caller sees every one of `nodes` now: our own check, then Neo4j's through their
   * read-only role x clearance account (D45.3, D57). A record type that is an "own" cell for the
   * role is read by the writer, limited to their own records and their clearance (S1 shared notes).
   */
  private async callerSees(caller: Caller, nodes: readonly GraphNode[]): Promise<boolean> {
    if (!nodes.every((node) => visibleTo(caller, node))) return false;
    const labels = visibleLabels(caller.clearance);
    const own = nodes.filter((node) => isOwnCell(caller.role, recordTypeOfLabel(node.nodeLabel)));
    const shared = nodes.filter((node) => !own.includes(node));
    const found = async (tx: Parameters<Parameters<GraphService['read']>[1]>[0], node: GraphNode, mine: boolean) => {
      const res = await tx.run(
        `MATCH (n:${node.nodeLabel} {id: $id})
         WHERE n.sensitivity IN $labels${mine ? ' AND n.owner = $owner' : ''}
         RETURN n.id AS id LIMIT 1`,
        { id: node.id, labels, owner: caller.userId },
      );
      return res.records.length === 1;
    };
    if (shared.length > 0) {
      const seen = await this.graph.readAs(
        caller.orgId,
        caller.role,
        caller.clearance,
        async (tx) => {
          for (const node of shared) if (!(await found(tx, node, false))) return false;
          return true;
        },
        { timeoutMs: REMOVAL_READ_TIMEOUT_MS },
      );
      if (!seen) return false;
    }
    if (own.length > 0) {
      const seen = await this.graph.read(caller.orgId, async (tx) => {
        for (const node of own) if (!(await found(tx, node, true))) return false;
        return true;
      });
      if (!seen) return false;
    }
    return true;
  }

  // ---- One upload -----------------------------------------------------------------------------

  /** What removing one upload would touch (Admin and Analyst; counts only, S5-Q1). */
  async documentImpact(caller: Caller, id: string): Promise<ReviewDocumentImpact> {
    if (!canViewReviewQueue(caller.role)) throw FORBIDDEN();
    const documentId = uuidOrNull(id);
    if (!documentId) throw DOCUMENT_NOT_FOUND();
    try {
      const seen = await withOrgContext(this.db, contextOf(caller), async (tx) => {
        const row = await findVisibleDocument(tx, caller, documentId);
        if (!row) return null;
        return { row, uploaderName: await uploaderName(tx, caller.orgId, row) };
      });
      if (!seen) throw DOCUMENT_NOT_FOUND();
      const findings = await withOrgContext(this.db, REVIEW_REMOVAL_CONTEXT(caller.orgId), (tx) =>
        findingCounts(tx, caller.orgId, documentId),
      );
      const liveAiLinks = await this.graph.read(caller.orgId, (tx) => countDocumentLinks(tx, documentId));
      const { row } = seen;
      return {
        document: {
          id: row.id,
          name: row.fileName,
          kind: row.kind,
          label: row.label,
          uploader: { type: row.uploaderType, id: row.uploaderId, name: seen.uploaderName },
          uploadedAt: row.createdAt.toISOString(),
          status: row.status,
        },
        counts: { liveAiLinks, ...findings },
      };
    } catch (err) {
      throw this.failed(err, 'a document impact read failed', { orgId: caller.orgId, documentId });
    }
  }

  /** Removes everything from one upload, in one action (see the top of the file). */
  async removeDocument(caller: Caller, id: string, body: unknown): Promise<DocumentRemoved> {
    if (!canWorkReviewQueue(caller.role)) throw FORBIDDEN();
    const { note } = documentRemoveBodySchema.parse(body ?? {});
    const documentId = uuidOrNull(id);
    if (!documentId) throw DOCUMENT_NOT_FOUND();
    const orgId = caller.orgId;
    const ids = { orgId, documentId };
    const started = performance.now();
    try {
      // 1. The document becomes `removed`, in the Analyst's own view. Its row is locked first, so a
      //    resolve writing live links for it (which holds it shared) finishes before.
      const marked = await withOrgContext(this.db, contextOf(caller), async (tx) => {
        const row = await findVisibleDocument(tx, caller, documentId, { lock: true });
        if (!row) throw DOCUMENT_NOT_FOUND();
        if (!isReadableDocumentKind(row.kind)) throw DOCUMENT_NOT_REMOVABLE();
        if (row.status !== 'removed') {
          await tx
            .update(documents)
            .set({ status: 'removed', failureCode: null, updatedAt: this.now() })
            .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)));
        }
        return { kind: row.kind, label: row.label, previousStatus: row.status };
      });

      // 2-6, holding the document and its open findings (see the top of the file).
      const counts = await withOrgContext(this.db, REVIEW_REMOVAL_CONTEXT(orgId), async (tx) => {
        const [held] = await tx
          .select({ status: documents.status })
          .from(documents)
          .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)))
          .for('update');
        if (held?.status !== 'removed') throw new Error('document removal: the document is not marked removed');
        const open = await tx
          .select()
          .from(reviewFindings)
          .where(
            and(
              eq(reviewFindings.orgId, orgId),
              eq(reviewFindings.documentId, documentId),
              inArray(reviewFindings.status, ['pending', 'live', 'approved']),
            ),
          )
          .orderBy(asc(reviewFindings.id))
          .for('update');

        // 2. Every AI link from the document.
        const deleted = await this.deleteAllDocumentLinks(caller, documentId);
        // 3. Every record approved from its findings.
        const retired = await this.retireDocumentRecords(caller, open);
        // 4. Its findings.
        const decided = await this.closeFindings(tx, caller, open, deleted, retired, note);
        // 5. Its chunk-to-record rows.
        const unlinked = await tx
          .delete(chunkRecords)
          .where(
            and(
              eq(chunkRecords.orgId, orgId),
              inArray(
                chunkRecords.chunkId,
                tx
                  .select({ id: chunks.id })
                  .from(chunks)
                  .where(and(eq(chunks.orgId, orgId), eq(chunks.documentId, documentId))),
              ),
            ),
          )
          .returning({ chunkId: chunkRecords.chunkId });

        const out: DocumentRemovalCounts = {
          aiLinksDeleted: deleted.length,
          recordsRetired: [...retired.values()].filter((r) => r === 'retired').length,
          findingsRejected: decided.rejected,
          findingsRemoved: decided.removed,
          chunkRecordsDeleted: unlinked.length,
        };
        // 6. One `document.removed` entry, with the counts and the note.
        await this.audit.appendInTx(tx, {
          orgId,
          ...actorOf(caller),
          action: REVIEW_AUDIT_ACTIONS.documentRemoved,
          targetType: REVIEW_DOCUMENT_TARGET_TYPE,
          targetId: documentId,
          before: { status: marked.previousStatus },
          after: { status: 'removed', ...(note !== undefined ? { note } : {}) },
          meta: { kind: marked.kind, label: marked.label, counts: out },
          sourceId: `${REVIEW_AUDIT_ACTIONS.documentRemoved}:${documentId}`,
        });
        return out;
      });

      this.log.info(
        { ...ids, previousStatus: marked.previousStatus, ...counts, ms: Math.round(performance.now() - started) },
        'an upload was removed',
      );
      return { documentId, status: 'removed', counts };
    } catch (err) {
      throw this.failed(err, 'an upload removal failed', ids);
    }
  }

  /** Step 2: every AI link whose source is the document, a batch per Neo4j transaction. */
  private async deleteAllDocumentLinks(caller: Caller, documentId: string): Promise<DeletedLink[]> {
    const all: DeletedLink[] = [];
    for (const type of SOURCED_LINK_TYPES) {
      for (;;) {
        const batch = await withTries(() =>
          this.outbox.withAuditedWrites(caller.orgId, actorOf(caller), async (tx) => {
            const links = await deleteDocumentLinks(tx, type, documentId, DOCUMENT_LINK_BATCH);
            return { result: links, audits: links.map(aiLinkRemovedAudit) };
          }),
        );
        all.push(...batch);
        if (batch.length < DOCUMENT_LINK_BATCH) break;
      }
    }
    return all;
  }

  /** Step 3: the records the document's approved `record` findings created, retired; by record ID,
   * whether each was retired now or already was. */
  private async retireDocumentRecords(
    caller: Caller,
    open: readonly FindingRow[],
  ): Promise<Map<string, 'retired' | 'already_retired'>> {
    const ids = [
      ...new Set(
        open
          .filter((row) => row.kind === 'record' && row.status === 'approved')
          .map((row) => recordOutcomeSchema.safeParse(row.outcome))
          .flatMap((parsed) => (parsed.success ? [parsed.data.recordId] : [])),
      ),
    ];
    const out = new Map<string, 'retired' | 'already_retired'>();
    for (let i = 0; i < ids.length; i += RECORD_RETIRE_BATCH) {
      const batch = ids.slice(i, i + RECORD_RETIRE_BATCH);
      const at = this.now().toISOString();
      const results = await withTries(() =>
        this.outbox.withAuditedWrites(caller.orgId, actorOf(caller), async (tx) => {
          const done = [];
          for (const id of batch) done.push(await retireRecord(tx, id, RECORD_NODE_LABELS, caller.userId, at));
          return {
            result: done.map((r) => ({ id: r.id, result: r.result })),
            audits: done.flatMap((r) => (r.result === 'retired' ? [r.audit] : [])),
          };
        }),
      );
      for (const r of results) out.set(r.id, r.result);
    }
    return out;
  }

  /** Step 4: pending findings rejected, live and approved ones removed with their outcome. */
  private async closeFindings(
    tx: Tx,
    caller: Caller,
    open: readonly FindingRow[],
    deleted: readonly DeletedLink[],
    retired: ReadonlyMap<string, 'retired' | 'already_retired'>,
    note: string | undefined,
  ): Promise<{ rejected: number; removed: number }> {
    const orgId = caller.orgId;
    const decidedAt = this.now();
    const decision = { decidedBy: caller.userId, decidedAt, decisionNote: note ?? null, updatedAt: decidedAt };

    const pending = open.filter((row) => row.status === 'pending').map((row) => row.id);
    let rejected = 0;
    if (pending.length > 0) {
      const done = await tx
        .update(reviewFindings)
        .set({ status: 'rejected', ...decision })
        .where(
          and(
            eq(reviewFindings.orgId, orgId),
            inArray(reviewFindings.id, pending),
            eq(reviewFindings.status, 'pending'),
          ),
        )
        .returning({ id: reviewFindings.id });
      rejected = done.length;
    }

    const closing = open.filter((row) => row.status === 'live' || row.status === 'approved');
    const plans = new Map<string, RemovalPlan | null>(closing.map((row) => [row.id, planFor(row)]));
    const where = await this.whereEndsAreNow(orgId, [...plans.values()]);
    const byFinding = new Set(deleted.flatMap((l) => (l.findingId !== null ? [l.findingId] : [])));
    // S4's live links carry their chunk and no finding; the Analyst's approved ones carry the finding.
    const byChunk = new Set(
      deleted.flatMap((l) =>
        l.chunkId !== null && l.findingId === null ? [`${l.type}|${l.chunkId}|${l.fromId}|${l.toId}`] : [],
      ),
    );

    let removed = 0;
    for (const row of closing) {
      const plan = plans.get(row.id) ?? null;
      let outcome: ReviewOutcome | null = row.outcome ?? null;
      if (plan?.kind === 'record') {
        outcome = removedOutcome(plan, retired.get(plan.recordId) ?? 'already_retired');
      } else if (plan) {
        const from = where.get(plan.from.id) ?? plan.from.id;
        const to = where.get(plan.to.id) ?? plan.to.id;
        const gone =
          !plan.exists &&
          (plan.match.by === 'finding'
            ? byFinding.has(plan.match.findingId)
            : byChunk.has(`${plan.type}|${plan.match.chunkId}|${from}|${to}`));
        outcome = removedOutcome(plan, gone ? 'deleted' : 'not_found');
      }
      const done = await tx
        .update(reviewFindings)
        .set({ status: 'removed', ...decision, outcome })
        .where(
          and(eq(reviewFindings.orgId, orgId), eq(reviewFindings.id, row.id), eq(reviewFindings.status, row.status)),
        )
        .returning({ id: reviewFindings.id });
      removed += done.length;
    }
    return { rejected, removed };
  }

  /** Where the records S4's live links joined stand now (after any merge), by original ID. */
  private async whereEndsAreNow(orgId: string, plans: readonly (RemovalPlan | null)[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        plans.flatMap((plan) =>
          plan && plan.kind !== 'record' && plan.match.by === 'chunk' ? [plan.from.id, plan.to.id] : [],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    return this.graph.read(orgId, (tx) => currentIds(tx, ids, RECORD_NODE_LABELS));
  }

  /** Our refusals and validation errors pass through; anything else is logged by its type, code and
   * IDs only, and answered as a 500 with a reference ID. */
  private failed(err: unknown, message: string, ids: Record<string, string>): unknown {
    if (err instanceof ApiError || err instanceof ZodError) return err;
    const fields = errorKind(err);
    this.log.error({ ...ids, ...fields }, message);
    return new RemovalFailed(fields.errorCode);
  }
}

// ---- Postgres reads --------------------------------------------------------------------------

/** One document the caller may see (S3's rule, as `DocumentsService`): an upload kind (never
 * evidence) whose record type the role views, at or below the clearance, in the caller's org.
 * With `lock`, the row is locked for the rest of the transaction. */
async function findVisibleDocument(
  tx: Tx,
  caller: Caller,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<DocumentRow | undefined> {
  const kinds = UPLOAD_KINDS.filter((kind) => can(caller.role, DOCUMENT_RECORD_TYPE[kind], 'view'));
  const labels = LABELS.filter((label) => isVisible(caller.clearance, label));
  if (kinds.length === 0 || labels.length === 0) return undefined;
  const query = tx
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.orgId, caller.orgId),
        eq(documents.id, id),
        inArray(documents.kind, [...kinds]),
        inArray(documents.label, [...labels]),
      ),
    )
    .limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row;
}

/** The uploader's display name: a member's name, an API key's name, or none for the system. */
async function uploaderName(tx: Tx, orgId: string, row: DocumentRow): Promise<string | null> {
  if (row.uploaderType === 'user') {
    const [found] = await tx
      .select({ name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, orgId), eq(user.id, row.uploaderId)))
      .limit(1);
    return found?.name ?? null;
  }
  if (row.uploaderType === 'api_key' && UUID.test(row.uploaderId)) {
    const [found] = await tx
      .select({ name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, row.uploaderId.toLowerCase())))
      .limit(1);
    return found?.name ?? null;
  }
  return null;
}

/** The document's findings by what removing it would do to them, whatever their labels. */
async function findingCounts(
  tx: Tx,
  orgId: string,
  documentId: string,
): Promise<Omit<ReviewDocumentImpact['counts'], 'liveAiLinks'>> {
  const [row] = await tx
    .select({
      approvedRecords:
        sql<number>`count(*) FILTER (WHERE ${reviewFindings.kind} = 'record' AND ${reviewFindings.status} = 'approved')`.mapWith(
          Number,
        ),
      pendingFindings: sql<number>`count(*) FILTER (WHERE ${reviewFindings.status} = 'pending')`.mapWith(Number),
      liveOrApprovedFindings:
        sql<number>`count(*) FILTER (WHERE ${reviewFindings.status} IN ('live', 'approved'))`.mapWith(Number),
    })
    .from(reviewFindings)
    .where(and(eq(reviewFindings.orgId, orgId), eq(reviewFindings.documentId, documentId)));
  return {
    approvedRecords: row?.approvedRecords ?? 0,
    pendingFindings: row?.pendingFindings ?? 0,
    liveOrApprovedFindings: row?.liveOrApprovedFindings ?? 0,
  };
}
