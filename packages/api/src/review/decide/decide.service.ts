// Approving and rejecting review findings (S5-003; D16, D24, D26, D37, D38, D39, D43, D45.5, D45.6,
// D50, D51, D56, D67, D68, D69, D73, D196, D198, D207, D212 (3), (4); S5 shared notes). The AI
// proposed; the Analyst decides, in their own view, and our code checks every rule again.
//
// Two databases, one decision (D37, D45.5), in this order:
//   1. In one Postgres transaction under the Analyst's own org context (so row security checks the
//      org, the Review-queue cell and the label, D73), the finding's document is share-locked (a
//      whole-upload removal waits for the decision, or the decision sees the removal) and then the
//      finding's row is locked (`SELECT ... FOR UPDATE`); it must be visible (404) and pending (409
//      `already_decided`). Of two decisions at once, the second waits here and then gets 409.
//   2. The graph change and its audit entries commit in one Neo4j transaction, as the writer, with
//      the Analyst as actor (./decide-graph.ts, `RecordsService.create`, `mergeReviewedRecords`).
//   3. The finding's new status, decider, time, note and outcome, and its `review.approved` or
//      `review.rejected` entry (`AuditService.appendInTx`), commit in the transaction holding the lock.
// A crash between 2 and 3 is safe: the finding is still pending, and a retry finds what its
// approval made by the finding's ID (`madeByFinding`) and only finishes the Postgres part; a
// rejection then answers 409, so the graph never disagrees with the finding.
//
// Per kind, approving (`POST /review/findings/:id/approve`):
//   - link: each end resolves to one record (its clear match; else the record its proposed new
//     record's approval made, 409 `end_not_approved` or `end_rejected` until then; else the
//     candidate the body names, 400 `end_not_chosen` or `end_not_candidate`), then the checks
//     (visible 404, active 409, two records fitting the ontology 400, `endsCoverSource` 409) and the
//     live AI link with its `link.created` entry, never doubled (outcome `exists`).
//   - record: created through S1's create path from the Analyst's form, origin `ai`, labelled at
//     least the finding's (the document's) label (400 `label_below_source`) and at most the
//     Analyst's clearance (D198), granted by the Review-queue `work` cell (planner's reading S5-Q2).
//   - duplicate: merged as S4-007 merges, by the Analyst, keeping the record they name (by default
//     the older one), the kept record taking the higher label (planner's reading S5-Q3).
//   - mapping: the suggested SATISFIES or MAPS_TO, origin `ai`, with the Framework-mappings
//     `approve` cell too (403 otherwise); both ends active and visible (404 otherwise).
// Rejecting (`POST /review/findings/:id/reject`) changes nothing in Neo4j: the finding becomes
// `rejected` (hidden by default, kept forever, never raised again by processing) with its entry, and
// rejecting a proposed new record also rejects, in the same transaction, every pending link finding
// the Analyst can see that points to it, each with its own entry (planner's reading S5-Q6).
//
// A decision is a person's judgement: an API key gets 403. Logs and entries hold IDs, numbers,
// codes and the Analyst's note (in the entry only), never a sentence, chunk text, record name or
// Gemma's reason (D163).
import {
  LABELS,
  REVIEW_AUDIT_ACTIONS,
  REVIEW_FINDING_KINDS,
  REVIEW_FINDING_TARGET_TYPE,
  canApproveFinding,
  canDecide,
  canWorkReviewQueue,
  defaultLabel,
  duplicateProposalSchema,
  isVisible,
  linkProposalSchema,
  mappingProposalSchema,
  parseApproveBody,
  recordOutcomeSchema,
  recordProposalSchema,
  rejectBodySchema,
  reviewOutcomeSchema,
  type Label,
  type LinkEndProposal,
  type ReviewOutcome,
} from '@grc/shared';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z, ZodError } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuditOutbox } from '../../audit/outbox.js';
import { ApiError, errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { documents } from '../../intake/intake.schema.js';
import { higherLabel } from '../../processing/match/match-rules.js';
import { mergeReviewedRecords } from '../../processing/match/record-merge.js';
import { reviewFindings, type ReviewFindingRow } from '../../processing/processing.schema.js';
import type { Caller, RecordsService } from '../../records/records.service.js';
import { FINDING_NOT_FOUND, FORBIDDEN, PEOPLE_ONLY, RECORD_NOT_FOUND, reviewError } from './decide-errors.js';
import {
  checkLinkEnds,
  checkMappingEnds,
  endIn,
  endVisibleTo,
  madeByFinding,
  mappingFromKind,
  readReviewerEnds,
  writeApprovedLink,
  writeApprovedMapping,
  type EndRef,
  type LinkSource,
  type MadeLink,
  type MadeLookup,
  type Reviewer,
} from './decide-graph.js';

/** What a decision answers: the finding's new state and what it made. */
export const reviewDecisionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(REVIEW_FINDING_KINDS),
  status: z.enum(['approved', 'rejected']),
  label: z.enum(LABELS),
  decidedBy: z.string(),
  decidedAt: z.iso.datetime({ offset: true }),
  note: z.string().nullable(),
  /** What the approval made, by record ID and number; `null` for a rejection. */
  outcome: reviewOutcomeSchema.nullable(),
  /** The pending link findings rejected with a rejected proposed record (empty otherwise). */
  rejectedLinkFindingIds: z.array(z.uuid()),
});

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export interface ReviewDecideDeps {
  db: Db;
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>;
  audit: Pick<AuditService, 'appendInTx'>;
  records: Pick<RecordsService, 'create'>;
  log?: Logger;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored finding our code can't read (a proposal that doesn't fit its kind's schema, a missing
 * source): nothing is approved (fail safe, D45.7), and the caller sees a 500 with a reference ID. */
class UnreadableFinding extends Error {
  readonly code = 'unreadable_finding';

  constructor() {
    super('A stored review finding could not be read.');
    this.name = 'UnreadableFinding';
  }
}

/** The finding's document, as share-locked for the decision. */
interface LockedDocument {
  id: string;
  label: Label;
  recordType: string;
  status: string;
}

interface Locked {
  row: ReviewFindingRow;
  doc: LockedDocument | null;
}

/** What approving one kind made, and the Analyst's note. */
interface Approved {
  outcome: ReviewOutcome;
  note: string | undefined;
  /** For links and mappings: whether the link was written now or found already there. */
  result?: 'created' | 'exists';
}

function findingIdOf(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw FINDING_NOT_FOUND();
  return id.toLowerCase();
}

function proposalOf<S extends z.ZodType>(schema: S, row: ReviewFindingRow): z.infer<S> {
  const parsed = schema.safeParse(row.proposal);
  if (!parsed.success) throw new UnreadableFinding();
  return parsed.data;
}

/** The record numbers an outcome names, for the decision entry's meta. */
function outcomeNumbers(outcome: ReviewOutcome | null): string[] {
  if (!outcome) return [];
  if ('fromNumber' in outcome) return [outcome.fromNumber, outcome.toNumber];
  if ('keptNumber' in outcome) return [outcome.keptNumber, outcome.retiredNumber];
  return [outcome.number];
}

/** Where to look for what this finding's approval made in the graph; null when its proposal can't
 * be read (then nothing was ever approved from it). */
function madeLookupOf(row: ReviewFindingRow): MadeLookup | null {
  switch (row.kind) {
    case 'link': {
      const p = linkProposalSchema.safeParse(row.proposal);
      if (!p.success || row.documentId === null) return null;
      return { kind: 'link', type: p.data.type, documentId: row.documentId };
    }
    case 'record': {
      const p = recordProposalSchema.safeParse(row.proposal);
      return p.success ? { kind: 'record', recordKind: p.data.kind } : null;
    }
    case 'duplicate': {
      const p = duplicateProposalSchema.safeParse(row.proposal);
      if (!p.success) return null;
      return { kind: 'duplicate', recordKind: p.data.kind, a: p.data.kept.recordId, b: p.data.other.recordId };
    }
    case 'mapping': {
      const p = mappingProposalSchema.safeParse(row.proposal);
      if (!p.success) return null;
      return { kind: 'mapping', type: p.data.type, fromId: p.data.from.recordId, toId: p.data.to.recordId };
    }
    default:
      return null;
  }
}

export class ReviewDecideService {
  private readonly db: Db;
  private readonly graph: ReviewDecideDeps['graph'];
  private readonly outbox: ReviewDecideDeps['outbox'];
  private readonly audit: ReviewDecideDeps['audit'];
  private readonly records: ReviewDecideDeps['records'];
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: ReviewDecideDeps) {
    this.db = deps.db;
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.audit = deps.audit;
    this.records = deps.records;
    this.log = (deps.log ?? createLogger()).child({ context: 'ReviewDecide' });
    this.now = deps.now ?? (() => new Date());
  }

  /** Approves a pending finding with the approve body of its kind (see the file comment). */
  async approve(caller: Caller, findingId: string, input: unknown): Promise<ReviewDecision> {
    const reviewer = reviewerOf(caller);
    const id = findingIdOf(findingId);
    return this.guarded(reviewer, id, () =>
      withOrgContext(this.db, reviewer, async (tx) => {
        const { row, doc } = await this.lockFinding(tx, reviewer, id, true);
        const approved = await this.approveKind(tx, reviewer, row, doc, input ?? {});
        const decidedAt = this.now();
        await this.finish(tx, reviewer, row, 'approved', approved.outcome, approved.note, decidedAt);
        this.log.info(
          { orgId: reviewer.orgId, findingId: row.id, kind: row.kind, status: 'approved', result: approved.result },
          'review finding approved',
        );
        return answer(row, 'approved', reviewer, decidedAt, approved.note, approved.outcome, []);
      }),
    );
  }

  /** Rejects a pending finding of any kind (see the file comment). */
  async reject(caller: Caller, findingId: string, input: unknown): Promise<ReviewDecision> {
    const reviewer = reviewerOf(caller);
    const id = findingIdOf(findingId);
    const { note } = rejectBodySchema.parse(input ?? {});
    return this.guarded(reviewer, id, () =>
      withOrgContext(this.db, reviewer, async (tx) => {
        const { row } = await this.lockFinding(tx, reviewer, id, false);
        // An approval whose graph part committed before a crash: the graph says approved, so the
        // finding stays pending for that approval's retry to finish.
        const lookup = madeLookupOf(row);
        if (lookup && (await madeByFinding(this.graph, reviewer.orgId, row.id, lookup))) {
          throw reviewError('already_decided');
        }
        const decidedAt = this.now();
        await this.finish(tx, reviewer, row, 'rejected', null, note, decidedAt);
        const linked = row.kind === 'record' ? await this.rejectPointingLinks(tx, reviewer, row, note, decidedAt) : [];
        this.log.info(
          { orgId: reviewer.orgId, findingId: row.id, kind: row.kind, status: 'rejected', linkFindings: linked.length },
          'review finding rejected',
        );
        return answer(row, 'rejected', reviewer, decidedAt, note, null, linked);
      }),
    );
  }

  /** Our refusals and bad bodies pass through; anything else is logged by its type, code and IDs. */
  private async guarded<T>(reviewer: Reviewer, findingId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ApiError) && !(err instanceof ZodError)) {
        this.log.error({ orgId: reviewer.orgId, findingId, ...errorKind(err) }, 'review decision failed');
      }
      throw err;
    }
  }

  /**
   * Locks the finding for the decision: read it (404 when missing, another org's or above the
   * clearance; row security hides those and our code checks the label again), check the kind may be
   * approved (403), share-lock its document (so a whole-upload removal and the decision run one
   * after the other), lock the row and check it is still pending (409 `already_decided`). An
   * approval of a finding whose document was removed is 409 `already_decided` too.
   */
  private async lockFinding(tx: Tx, reviewer: Reviewer, id: string, approving: boolean): Promise<Locked> {
    const peek = await this.readFinding(tx, reviewer.orgId, id, false);
    if (!peek || !isVisible(reviewer.clearance, peek.label)) throw FINDING_NOT_FOUND();
    if (approving && !canApproveFinding(reviewer.role, peek.kind)) throw FORBIDDEN();
    let doc: LockedDocument | null = null;
    if (peek.documentId !== null) {
      doc = await this.lockDocument(tx, reviewer.orgId, peek.documentId);
      if (!doc) throw FINDING_NOT_FOUND();
    }
    const row = await this.readFinding(tx, reviewer.orgId, id, true);
    if (!row || !isVisible(reviewer.clearance, row.label)) throw FINDING_NOT_FOUND();
    if (!canDecide(row.status)) throw reviewError('already_decided');
    if (approving && doc?.status === 'removed') throw reviewError('already_decided');
    return { row, doc };
  }

  private async readFinding(tx: Tx, orgId: string, id: string, lock: boolean): Promise<ReviewFindingRow | undefined> {
    const where = and(eq(reviewFindings.orgId, orgId), eq(reviewFindings.id, id));
    const rows = lock
      ? await tx.select().from(reviewFindings).where(where).for('update')
      : await tx.select().from(reviewFindings).where(where);
    return rows[0];
  }

  private async lockDocument(tx: Tx, orgId: string, documentId: string): Promise<LockedDocument | null> {
    const [doc] = await tx
      .select({
        id: documents.id,
        label: documents.label,
        recordType: documents.recordType,
        status: documents.status,
      })
      .from(documents)
      .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)))
      .for('share');
    return doc ?? null;
  }

  private approveKind(
    tx: Tx,
    reviewer: Reviewer,
    row: ReviewFindingRow,
    doc: LockedDocument | null,
    input: unknown,
  ): Promise<Approved> {
    switch (row.kind) {
      case 'link':
        return this.approveLink(tx, reviewer, row, doc, input);
      case 'record':
        return this.approveRecord(reviewer, row, doc, input);
      case 'duplicate':
        return this.approveDuplicate(reviewer, row, input);
      case 'mapping':
        return this.approveMapping(reviewer, row, input);
      default:
        throw new UnreadableFinding();
    }
  }

  // ---- link ------------------------------------------------------------------------------------

  private async approveLink(
    tx: Tx,
    reviewer: Reviewer,
    row: ReviewFindingRow,
    doc: LockedDocument | null,
    input: unknown,
  ): Promise<Approved> {
    const proposal = proposalOf(linkProposalSchema, row);
    const parsed = parseApproveBody('link', null, input);
    if (parsed.kind !== 'link') throw new UnreadableFinding();
    const { documentId, chunkId, sentence, model, promptVersion } = row;
    if (!doc || documentId === null || chunkId === null || sentence === null || model === null) {
      throw new UnreadableFinding();
    }
    if (promptVersion === null) throw new UnreadableFinding();
    const note = parsed.body.note;

    const made = await madeByFinding(this.graph, reviewer.orgId, row.id, {
      kind: 'link',
      type: proposal.type,
      documentId,
    });
    if (made?.kind === 'link') {
      return { outcome: { result: 'created', type: proposal.type, ...madeEnds(made) }, note, result: 'created' };
    }

    const fromId = await this.resolveEnd(tx, reviewer, proposal.from, parsed.body.from);
    const toId = await this.resolveEnd(tx, reviewer, proposal.to, parsed.body.to);
    const fromRef = { kind: proposal.from.kind, id: fromId };
    const toRef = { kind: proposal.to.kind, id: toId };
    const source: LinkSource = {
      documentId,
      chunkId,
      sentence,
      model,
      promptVersion,
      label: doc.label,
      recordType: doc.recordType,
    };
    const seen = await readReviewerEnds(this.graph, reviewer, [fromRef, toRef]);
    checkLinkEnds(reviewer, proposal.type, endIn(seen, fromRef), endIn(seen, toRef), source);

    const written = await writeApprovedLink(this.outbox, reviewer, {
      findingId: row.id,
      type: proposal.type,
      from: fromRef,
      to: toRef,
      source,
    });
    return {
      outcome: {
        result: written.result,
        type: proposal.type,
        fromId,
        fromNumber: written.fromNumber,
        toId,
        toNumber: written.toNumber,
      },
      note,
      result: written.result,
    };
  }

  /**
   * The one record a link end means: its clear match (a record the body names for it must be that
   * one); else, when it is a proposed new record, the record that proposal's approval made (409
   * `end_not_approved` while it waits, `end_rejected` once rejected); else the candidate the body
   * names (400 `end_not_chosen` when none is named, `end_not_candidate` when it isn't one).
   */
  private async resolveEnd(
    tx: Tx,
    reviewer: Reviewer,
    end: LinkEndProposal,
    chosen: string | undefined,
  ): Promise<string> {
    if (end.match) {
      if (chosen !== undefined && chosen !== end.match.recordId) throw reviewError('end_not_candidate');
      return end.match.recordId;
    }
    if (end.recordFindingId !== null) {
      const [proposed] = await tx
        .select({ status: reviewFindings.status, label: reviewFindings.label, outcome: reviewFindings.outcome })
        .from(reviewFindings)
        .where(
          and(
            eq(reviewFindings.orgId, reviewer.orgId),
            eq(reviewFindings.id, end.recordFindingId),
            eq(reviewFindings.kind, 'record'),
          ),
        );
      if (!proposed || !isVisible(reviewer.clearance, proposed.label)) throw RECORD_NOT_FOUND();
      if (proposed.status === 'rejected') throw reviewError('end_rejected');
      if (proposed.status !== 'approved' && proposed.status !== 'removed') throw reviewError('end_not_approved');
      const outcome = recordOutcomeSchema.safeParse(proposed.outcome);
      if (!outcome.success) throw new UnreadableFinding();
      if (chosen !== undefined && chosen !== outcome.data.recordId) throw reviewError('end_not_candidate');
      return outcome.data.recordId;
    }
    if (chosen === undefined) throw reviewError('end_not_chosen');
    if (!end.candidates.some((c) => c.recordId === chosen)) throw reviewError('end_not_candidate');
    return chosen;
  }

  // ---- record ----------------------------------------------------------------------------------

  private async approveRecord(
    reviewer: Reviewer,
    row: ReviewFindingRow,
    doc: LockedDocument | null,
    input: unknown,
  ): Promise<Approved> {
    const proposal = proposalOf(recordProposalSchema, row);
    const parsed = parseApproveBody('record', proposal.kind, input);
    if (parsed.kind !== 'record') throw new UnreadableFinding();
    const note = parsed.body.note;

    const made = await madeByFinding(this.graph, reviewer.orgId, row.id, { kind: 'record', recordKind: proposal.kind });
    if (made?.kind === 'record') return { outcome: { recordId: made.recordId, number: made.number }, note };

    // At least the document's label (only an Admin may lower one, D51); at most the Analyst's own
    // clearance, which S1's create checks (D198).
    const floor = doc ? higherLabel(row.label, doc.label) : row.label;
    const given = parsed.body.record as Record<string, unknown> & { label?: Label };
    const label = given.label ?? higherLabel(defaultLabel(proposal.kind), floor);
    if (!isVisible(label, floor)) throw reviewError('label_below_source');

    const created = await this.records.create(
      callerOf(reviewer),
      proposal.kind,
      { ...given, label },
      { origin: 'ai', findingId: row.id, permission: 'review_queue' },
    );
    return { outcome: { recordId: created.id, number: created.number }, note };
  }

  // ---- duplicate -------------------------------------------------------------------------------

  private async approveDuplicate(reviewer: Reviewer, row: ReviewFindingRow, input: unknown): Promise<Approved> {
    const proposal = proposalOf(duplicateProposalSchema, row);
    const parsed = parseApproveBody('duplicate', null, input);
    if (parsed.kind !== 'duplicate') throw new UnreadableFinding();
    const note = parsed.body.note;
    const a = proposal.kept.recordId;
    const b = proposal.other.recordId;
    const keep = parsed.body.keep;
    if (keep !== undefined && keep !== a && keep !== b) {
      throw new ApiError(400, 'validation_failed', 'keep: must be one of the two records of this finding.');
    }

    const made = await madeByFinding(this.graph, reviewer.orgId, row.id, {
      kind: 'duplicate',
      recordKind: proposal.kind,
      a,
      b,
    });
    if (made?.kind === 'merge') {
      const outcome = {
        keptId: made.keptId,
        keptNumber: made.keptNumber,
        retiredId: made.retiredId,
        retiredNumber: made.retiredNumber,
      };
      return { outcome, note };
    }

    const refA: EndRef = { kind: proposal.kind, id: a };
    const refB: EndRef = { kind: proposal.kind, id: b };
    const seen = await readReviewerEnds(this.graph, reviewer, [refA, refB]);
    const endA = endIn(seen, refA);
    const endB = endIn(seen, refB);
    if (!endA || !endB) throw RECORD_NOT_FOUND();
    if (endA.status !== 'active' || endB.status !== 'active') throw reviewError('record_not_active');

    const merged = await mergeReviewedRecords(
      { outbox: this.outbox },
      {
        orgId: reviewer.orgId,
        kind: proposal.kind,
        findingId: row.id,
        a,
        b,
        ...(keep !== undefined ? { keepId: keep } : {}),
        step: proposal.step,
        actor: { actorType: 'user', actorId: reviewer.userId },
        visible: (record) => endVisibleTo(reviewer, proposal.kind, record),
      },
    );
    if (merged.status === 'hidden') throw RECORD_NOT_FOUND();
    if (merged.status === 'not_active') throw reviewError('record_not_active');
    return {
      outcome: {
        keptId: merged.keptId,
        keptNumber: merged.keptNumber,
        retiredId: merged.retiredId,
        retiredNumber: merged.retiredNumber,
      },
      note,
    };
  }

  // ---- mapping ---------------------------------------------------------------------------------

  private async approveMapping(reviewer: Reviewer, row: ReviewFindingRow, input: unknown): Promise<Approved> {
    const proposal = proposalOf(mappingProposalSchema, row);
    const parsed = parseApproveBody('mapping', null, input);
    if (parsed.kind !== 'mapping') throw new UnreadableFinding();
    if (row.model === null || row.promptVersion === null) throw new UnreadableFinding();
    const note = parsed.body.note;
    const fromId = proposal.from.recordId;
    const toId = proposal.to.recordId;

    const made = await madeByFinding(this.graph, reviewer.orgId, row.id, {
      kind: 'mapping',
      type: proposal.type,
      fromId,
      toId,
    });
    if (made?.kind === 'link') {
      return { outcome: { result: 'created', type: proposal.type, ...madeEnds(made) }, note, result: 'created' };
    }

    const fromRef: EndRef = { kind: mappingFromKind(proposal.type), id: fromId };
    const toRef: EndRef = { kind: 'requirement', id: toId };
    const seen = await readReviewerEnds(this.graph, reviewer, [fromRef, toRef]);
    checkMappingEnds(reviewer, endIn(seen, fromRef), endIn(seen, toRef));

    const written = await writeApprovedMapping(this.outbox, reviewer, {
      findingId: row.id,
      type: proposal.type,
      fromId,
      toId,
      model: row.model,
      promptVersion: row.promptVersion,
    });
    return {
      outcome: {
        result: written.result,
        type: proposal.type,
        fromId,
        fromNumber: written.fromNumber,
        toId,
        toNumber: written.toNumber,
      },
      note,
      result: written.result,
    };
  }

  // ---- Postgres ----------------------------------------------------------------------------------

  /** The finding's new status, decision fields and outcome, and its `review.*` entry, in the
   * transaction holding its lock. */
  private async finish(
    tx: Tx,
    reviewer: Reviewer,
    row: ReviewFindingRow,
    status: 'approved' | 'rejected',
    outcome: ReviewOutcome | null,
    note: string | undefined,
    decidedAt: Date,
    extraMeta: Record<string, unknown> = {},
  ): Promise<void> {
    const updated = await tx
      .update(reviewFindings)
      .set({
        status,
        decidedBy: reviewer.userId,
        decidedAt,
        decisionNote: note ?? null,
        outcome,
        updatedAt: decidedAt,
      })
      .where(
        and(
          eq(reviewFindings.orgId, reviewer.orgId),
          eq(reviewFindings.id, row.id),
          eq(reviewFindings.status, 'pending'),
        ),
      )
      .returning({ id: reviewFindings.id });
    if (updated.length === 0) throw reviewError('already_decided');
    await this.audit.appendInTx(tx, {
      orgId: reviewer.orgId,
      actorType: 'user',
      actorId: reviewer.userId,
      action: status === 'approved' ? REVIEW_AUDIT_ACTIONS.approved : REVIEW_AUDIT_ACTIONS.rejected,
      targetType: REVIEW_FINDING_TARGET_TYPE,
      targetId: row.id,
      before: { status: row.status },
      after: { status, ...(outcome ? { outcome } : {}), ...(note !== undefined ? { note } : {}) },
      meta: {
        kind: row.kind,
        oldStatus: row.status,
        newStatus: status,
        label: row.label,
        numbers: outcomeNumbers(outcome),
        ...extraMeta,
      },
    });
  }

  /** Rejecting a proposed new record rejects every pending link finding pointing to it that the
   * Analyst can see (row security and our label check), each locked in ID order and with its own
   * `review.rejected` entry naming the record finding. */
  private async rejectPointingLinks(
    tx: Tx,
    reviewer: Reviewer,
    record: ReviewFindingRow,
    note: string | undefined,
    decidedAt: Date,
  ): Promise<string[]> {
    const pointing = await tx
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.orgId, reviewer.orgId),
          eq(reviewFindings.kind, 'link'),
          eq(reviewFindings.status, 'pending'),
          or(
            sql`${reviewFindings.proposal} -> 'from' ->> 'recordFindingId' = ${record.id}`,
            sql`${reviewFindings.proposal} -> 'to' ->> 'recordFindingId' = ${record.id}`,
          ),
        ),
      )
      .orderBy(asc(reviewFindings.id))
      .for('update');
    const rejected: string[] = [];
    for (const link of pointing) {
      if (!isVisible(reviewer.clearance, link.label) || !canDecide(link.status)) continue;
      await this.finish(tx, reviewer, link, 'rejected', null, note, decidedAt, { rejectedWith: record.id });
      rejected.push(link.id);
    }
    return rejected;
  }
}

/** The person deciding (D24, D45.6): an API key never decides (403), and only a role with the
 * Review-queue `work` cell does (the guard checks it first; this is the service's own check). */
function reviewerOf(caller: Caller): Reviewer {
  if (caller.apiKeyId !== undefined) throw PEOPLE_ONLY();
  if (!canWorkReviewQueue(caller.role)) throw FORBIDDEN();
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

/** The two ends of a link or mapping an approval already made, for its outcome. */
function madeEnds(made: MadeLink): { fromId: string; fromNumber: string; toId: string; toNumber: string } {
  return { fromId: made.fromId, fromNumber: made.fromNumber, toId: made.toId, toNumber: made.toNumber };
}

function callerOf(reviewer: Reviewer): Caller {
  return { orgId: reviewer.orgId, userId: reviewer.userId, role: reviewer.role, clearance: reviewer.clearance };
}

function answer(
  row: ReviewFindingRow,
  status: 'approved' | 'rejected',
  reviewer: Reviewer,
  decidedAt: Date,
  note: string | undefined,
  outcome: ReviewOutcome | null,
  rejectedLinkFindingIds: string[],
): ReviewDecision {
  return {
    id: row.id,
    kind: row.kind,
    status,
    label: row.label,
    decidedBy: reviewer.userId,
    decidedAt: decidedAt.toISOString(),
    note: note ?? null,
    outcome,
    rejectedLinkFindingIds,
  };
}
