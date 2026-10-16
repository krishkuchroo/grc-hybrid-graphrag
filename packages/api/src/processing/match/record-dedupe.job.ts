// The duplicate check (S4-007; D18, D24, D43, D45.5, D51, D69, D70, D72; planner's reading S4-Q3):
// the `processing.record-dedupe` handler, 4 at once in the worker program only. S4-005 queues one
// for each Asset, Risk, Control, Policy or Incident it gives a name embedding (key: the record ID
// plus the name embedded). For that one record, if it is still active, it compares the record with
// the org's other active records of the same kind, as Admin at Restricted (housekeeping: nothing
// is shown to anyone here), in D43's steps with no Gemma:
//   1. exact: the same name after `normaliseName`;
//   2. close spelling: the `record_names` full-text index, scored by `editSimilarity`;
//   3. close meaning: the record's own name embedding against the label's vector index.
// Names whose digits differ never count by spelling or meaning (`srv-app-01` is not `srv-app-02`).
//
// - **A clear duplicate merges automatically:** only when exactly one other record has the same
//   name after `normaliseName` and the same label (./record-merge.ts: the older record kept, the
//   source IDs and links moved, the other retired into it, one Neo4j transaction with its audit
//   entries). If either record changed since the check read it, nothing is merged and the job runs
//   again later (`RunLater`). A pair the Analyst has rejected or removed as a duplicate is never
//   merged; a pending finding for a pair that then merges becomes `live` (made live by our rules).
// - **Everything else goes to the Analyst:** an exact match with a different label, more than one
//   exact match, and the spelling and meaning candidates at or above their cut-offs (up to 3) each
//   give one pending `duplicate` finding per pair, labelled the higher of the two records' labels.
//   The finding key names the pair in ID order, so the same pair is never raised twice in either
//   order, and never again once the Analyst has decided it (findings are kept, D24).
// - Retired records are never matched, merged or flagged.
// Postgres runs under the intake system context (the org wall still applies); Neo4j writes are made
// as `system:processing`. Running the same job again changes nothing more (D45.5). Log lines hold
// only IDs, counts and codes, never a name or a vector (D163).
import type { OnApplicationBootstrap } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  NODE_LABELS,
  RECORD_KINDS,
  duplicateProposalSchema,
  isLabel,
  type RecordKind,
  type ReviewFindingStatus,
} from '@grc/shared';
import { EMBEDDING_DIMENSIONS } from '../../ai/embedder.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import { RunLater, type JobsService } from '../../jobs/jobs.module.js';
import { reviewFindings, type NewReviewFindingRow } from '../processing.schema.js';
import { PROCESSING_CONCURRENCY, PROCESSING_QUEUES } from '../queues.js';
import {
  byNumber,
  decideDuplicates,
  higherLabel,
  mergeable,
  sameNames,
  type RankedCandidate,
  type StoredName,
} from './match-rules.js';
import { SYSTEM_MATCH_VIEW, kindRead, readFor, readMeaning, readScan, readSpelling } from './name-matcher.js';
import { mergeRecords, type MergeDeps } from './record-merge.js';

/** Seconds before a check whose records changed mid-way runs again. */
export const RECORD_DEDUPE_RETRY_SECONDS = 30;

/** The finding statuses the Analyst sets that mean "these are not one record": never merged again. */
const ANALYST_REFUSED: readonly ReviewFindingStatus[] = ['rejected', 'removed'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's payload (S4 shared notes, "The job chain"). */
export const recordDedupeJobSchema = z.object({
  orgId: z.string().regex(UUID),
  recordId: z.string().regex(UUID),
});

/** What one run did. */
export type RecordDedupeOutcome =
  | { status: 'skipped'; reason: 'bad_job_data' | 'not_found' | 'retired' }
  | { status: 'merged'; keptId: string; retiredId: string; linksMoved: number }
  | { status: 'held'; reason: 'analyst_decided' }
  | { status: 'flagged'; pairs: number; added: number }
  | { status: 'nothing' };

export interface RecordDedupeDeps {
  db: Db;
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: MergeDeps['outbox'];
  log?: Logger;
  now?: () => string;
}

/** The record the check is for, as stored. */
interface CheckedRecord extends StoredName {
  kind: RecordKind;
  status: string;
  embedding: number[] | null;
}

const KIND_BY_LABEL: ReadonlyMap<string, RecordKind> = new Map(
  RECORD_KINDS.map((kind) => [NODE_LABELS[kind], kind] as const),
);

function kindOf(labels: unknown): RecordKind | null {
  if (!Array.isArray(labels)) return null;
  for (const l of labels) {
    const kind = KIND_BY_LABEL.get(String(l));
    if (kind) return kind;
  }
  return null;
}

/** A stored name embedding, if it is one: bge-m3's 1024 finite numbers (D71). */
function embeddingOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) return null;
  return v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : null;
}

/** The record, of any of the five kinds, read by the writer (the system sees every label). */
async function readRecord(graph: RecordDedupeDeps['graph'], orgId: string, id: string): Promise<CheckedRecord | null> {
  const branches = RECORD_KINDS.map((kind) => `MATCH (n:${NODE_LABELS[kind]} {id: $id}) RETURN n`);
  return graph.read(orgId, async (tx) => {
    const res = await tx.run(
      `CALL () { ${branches.join(' UNION ')} }
       RETURN labels(n) AS labels, n.id AS id, n.number AS number, n.name AS name, n.sensitivity AS label,
              n.status AS status, n.version AS version, n.sourceIds AS sourceIds, n.nameEmbedding AS embedding
       LIMIT 1`,
      { id },
    );
    const row = res.records[0];
    if (!row) return null;
    const kind = kindOf(row.get('labels'));
    const label = row.get('label');
    const number = row.get('number');
    if (!kind || typeof number !== 'string') return null;
    const name = row.get('name');
    const sourceIds = row.get('sourceIds');
    const version = Number(row.get('version'));
    return {
      kind,
      id,
      number,
      name: typeof name === 'string' ? name : '',
      // A node without a known label is invisible to every reader; the check treats it as Restricted.
      label: isLabel(label) ? label : 'restricted',
      status: String(row.get('status') ?? ''),
      version: Number.isInteger(version) ? version : 0,
      sourceIds: Array.isArray(sourceIds) ? sourceIds.filter((s): s is string => typeof s === 'string') : [],
      embedding: embeddingOf(row.get('embedding')),
    };
  });
}

/** The finding key of a pair: the same whichever of the two the check was for. */
export function duplicateFindingKey(kind: RecordKind, a: string, b: string): string {
  const [first, second] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `duplicate:${kind}:${first}:${second}`;
}

/** The pending finding for one possible duplicate pair, or null if its proposal doesn't pass. */
function findingRow(orgId: string, self: CheckedRecord, pair: RankedCandidate): NewReviewFindingRow | null {
  const mine = { recordId: self.id, number: self.number };
  const theirs = { recordId: pair.candidate.recordId, number: pair.candidate.number };
  const [kept, other] = byNumber(self, pair.candidate) <= 0 ? [mine, theirs] : [theirs, mine];
  const proposal = duplicateProposalSchema.safeParse({
    kind: self.kind,
    kept,
    other,
    step: pair.candidate.step,
    score: pair.candidate.score,
  });
  if (!proposal.success) return null;
  return {
    orgId,
    kind: 'duplicate',
    status: 'pending',
    findingKey: duplicateFindingKey(self.kind, self.id, pair.candidate.recordId),
    proposal: proposal.data,
    label: higherLabel(self.label, pair.label),
  };
}

/** One run of the job. Throws for what a retry may fix (Neo4j, Postgres), and `RunLater` when the
 * records changed while the check ran. */
export async function runRecordDedupe(
  deps: RecordDedupeDeps,
  job: { id: string; data: unknown },
): Promise<RecordDedupeOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'RecordDedupe' });
  const parsed = recordDedupeJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.warn({ jobId: job.id, code: 'bad_job_data' }, 'a duplicate check job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const orgId = parsed.data.orgId.toLowerCase();
  const recordId = parsed.data.recordId.toLowerCase();
  const ids = { orgId, recordId, jobId: job.id };

  const self = await readRecord(deps.graph, orgId, recordId);
  if (!self) return { status: 'skipped', reason: 'not_found' };
  if (self.status !== 'active') return { status: 'skipped', reason: 'retired' };

  // Admin at Restricted views every kind, so this read always exists.
  const read = kindRead(SYSTEM_MATCH_VIEW, self.kind, self.id);
  if (!read) return { status: 'nothing' };
  const found = await readFor(deps.graph, orgId, SYSTEM_MATCH_VIEW, read, async (tx) => {
    const same = sameNames(await readScan(tx, read.scope), self);
    if (mergeable(self, same)) return { same, spelling: [], meaning: [] };
    const spelling = await readSpelling(tx, read.scope, self.name);
    const meaning = self.embedding ? await readMeaning(tx, read.scope, self.name, self.embedding) : [];
    return { same, spelling, meaning };
  });
  const decision = decideDuplicates(self, found.same, found.spelling, found.meaning);
  const sys = INTAKE_SYSTEM_CONTEXT(orgId);

  if (decision.kind === 'merge') {
    const key = duplicateFindingKey(self.kind, self.id, decision.other.id);
    const [decided] = await withOrgContext(deps.db, sys, (tx) =>
      tx
        .select({ status: reviewFindings.status })
        .from(reviewFindings)
        .where(and(eq(reviewFindings.orgId, orgId), eq(reviewFindings.findingKey, key)))
        .limit(1),
    );
    if (decided && ANALYST_REFUSED.includes(decided.status)) {
      log.info({ ...ids, otherId: decision.other.id, code: 'analyst_decided' }, 'a duplicate pair was not merged');
      return { status: 'held', reason: 'analyst_decided' };
    }
    const merged = await mergeRecords(
      { outbox: deps.outbox, now: deps.now },
      {
        orgId,
        kind: self.kind,
        a: { id: self.id, version: self.version },
        b: { id: decision.other.id, version: decision.other.version },
        step: 'exact',
      },
    );
    if (merged.status === 'changed') {
      log.info({ ...ids, otherId: decision.other.id, code: 'records_changed' }, 'a duplicate check will run again');
      throw new RunLater(RECORD_DEDUPE_RETRY_SECONDS, 'records changed');
    }
    await withOrgContext(deps.db, sys, (tx) =>
      tx
        .update(reviewFindings)
        .set({ status: 'live', updatedAt: new Date() })
        .where(
          and(
            eq(reviewFindings.orgId, orgId),
            eq(reviewFindings.findingKey, key),
            eq(reviewFindings.status, 'pending'),
          ),
        ),
    );
    log.info(
      {
        ...ids,
        keptId: merged.keptId,
        retiredId: merged.retiredId,
        linksMoved: merged.linksMoved,
        linksKept: merged.linksKept,
        linksDropped: merged.linksDropped,
      },
      'duplicate records merged',
    );
    return { status: 'merged', keptId: merged.keptId, retiredId: merged.retiredId, linksMoved: merged.linksMoved };
  }

  if (decision.kind === 'flag') {
    const rows = decision.pairs
      .map((pair) => findingRow(orgId, self, pair))
      .filter((r): r is NewReviewFindingRow => r !== null);
    if (rows.length < decision.pairs.length) {
      log.warn(
        { ...ids, code: 'bad_proposal', dropped: decision.pairs.length - rows.length },
        'a duplicate pair was dropped',
      );
    }
    if (rows.length === 0) return { status: 'nothing' };
    const added = await withOrgContext(deps.db, sys, (tx) =>
      tx
        .insert(reviewFindings)
        .values(rows)
        .onConflictDoNothing({ target: [reviewFindings.orgId, reviewFindings.findingKey] })
        .returning({ id: reviewFindings.id }),
    );
    log.info({ ...ids, pairs: rows.length, added: added.length }, 'possible duplicates flagged');
    return { status: 'flagged', pairs: rows.length, added: added.length };
  }

  return { status: 'nothing' };
}

/** Registers the check in the worker program only; S4-005 queues it. */
export class RecordDedupeJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'RecordDedupe' });

  constructor(
    private readonly jobs: JobsService,
    private readonly deps: Omit<RecordDedupeDeps, 'log'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: RecordDedupeDeps = { ...this.deps, log: this.log };
    await this.jobs.work(
      PROCESSING_QUEUES.recordDedupe,
      async (job) => {
        try {
          await runRecordDedupe(deps, job);
        } catch (err) {
          if (!(err instanceof RunLater)) {
            this.log.error({ jobId: job.id, attempt: job.attempt, ...errorKind(err) }, 'a duplicate check failed');
          }
          throw err;
        }
      },
      { concurrency: PROCESSING_CONCURRENCY.recordDedupe },
    );
  }
}
