// The rule checks and the decision (S4-008; D24, D37, D38, D39, D40, D41, D42, D45.5, D45.6, D45.7,
// D51, D52.5, D69, D72, D73, D163, D207): the `processing.chunk-resolve` handler, 4 at once in the
// worker program only (D72 "duplicate matching ×4"), under the intake system context (S3 planner's
// reading R10), so the org wall still applies. The AI proposes and our code decides (D45.6).
//
// Full mode (a chunk Gemma has read, stage `extracted`):
//   1. the stored answer is read again leniently (S4-001), and every record in it is matched with
//      S4-007's matcher in the uploader's view (./uploader-view.ts): records the uploader couldn't
//      see are never matched, so never linked or named in a finding;
//   2. each link gets the three rule checks (./decide-rules.ts). A link the Analyst rejected or
//      removed before is dropped: never raised again, never made live again;
//   3. the links that pass all three go live in one Neo4j transaction with their `link.created`
//      entries (./live-links.ts): origin `ai`, with their source document, chunk, sentence, model,
//      prompt version and the document's label;
//   4. in one Postgres transaction: one `record` finding per proposed new risk, control, policy or
//      incident (per document, kind and normalised name; never an asset, D40), a `link` finding for
//      each link (`live` for one made live, else `pending` with its failed checks, each end's match
//      or candidates, and the sentence; a link already in the graph from elsewhere waits as
//      `pending` too), a chunk-to-record row for every clearly matched record, the chunk's move to
//      `resolved`, and, when it was the document's last chunk, the document's move to `processed`.
// Mentions mode (embed-only, fast-loaded documents, D42; stage `embedded`): no Gemma answer. The
// chunk is linked to the org's active records whose number or normalised name it names as whole
// words, in the uploader's view (Admin at Restricted for the system's fast load); only chunk-to-record
// rows and the stage are written: no findings, no graph writes.
//
// Re-runs (D45.5): a resolved chunk is skipped. A crash between the Neo4j and the Postgres steps is
// safe: the re-run finds its own links (no second link, MERGE) and adds each finding once (the
// finding key). Records that change between the match and the write (a merge, a retirement, a
// relabel) put the job off (`RunLater`) to be matched again; Ollama being down (the matcher's close
// meaning step embeds names) puts it off too, using up no try (D45.7). Any other error is a failed
// try (D72); on the last one the chunk ends `failed` and its document `failed` with
// `resolve_failed` (the other chunks still finish). Status changes write no audit entry (as in S3).
//
// Logs and the error a failed try leaves (D163): IDs, counts, codes and the model, never a chunk's
// text, a sentence, a name or an answer.
import type { OnApplicationBootstrap } from '@nestjs/common';
import { RECORD_KINDS, isLabel, readExtractionAnswer, type Label } from '@grc/shared';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { AiCallError, AiFailure, AiInputError, isAiFailure } from '../../ai/ai-failure.js';
import type { AuditOutbox } from '../../audit/outbox.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { documents } from '../../intake/intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import { RunLater, type JobHandlerInput, type JobsService } from '../../jobs/jobs.module.js';
import { higherLabel, type KeyedName } from '../match/match-rules.js';
import { kindRead, readFor, readScan, type MatchView, type NameMatcher } from '../match/name-matcher.js';
import {
  chunkRecords,
  chunks,
  reviewFindings,
  type ChunkRecordKind,
  type ChunkStage,
  type NewChunkRecordRow,
  type NewReviewFindingRow,
} from '../processing.schema.js';
import { CHUNK_RESOLVE_MODES, PROCESSING_CONCURRENCY, PROCESSING_QUEUES, type ChunkResolveMode } from '../queues.js';
import {
  evaluateLinks,
  identityOfLink,
  identityOfProposal,
  isRefused,
  linkProposal,
  matchedEnds,
  mentionedRecords,
  proposedRecords,
  type EvaluatedLink,
  type LinkIdentity,
  type ProposedRecord,
} from './decide-rules.js';
import { LinkEndsChanged, writeLiveLinks, type LiveLinkOutcome, type LiveLinkWrite } from './live-links.js';
import { uploaderView } from './uploader-view.js';

/** The code a document fails with when a chunk's resolution has used its last try. */
export const RESOLVE_FAILURE_CODE = 'resolve_failed';

/** How long a chunk waits before it is tried again while Ollama can't embed the names (D45.7). */
export const OLLAMA_WAIT_SECONDS = 60;

/** How long a chunk waits before it is matched again when its records changed meanwhile. */
export const ENDS_CHANGED_WAIT_SECONDS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's data (S4 shared notes, "The job chain"). */
export const chunkResolveJobSchema = z.object({
  orgId: z.string().regex(UUID),
  chunkId: z.string().regex(UUID),
  mode: z.enum(CHUNK_RESOLVE_MODES),
});

/** What one run did. */
export type ChunkResolveOutcome =
  | {
      status: 'resolved';
      chunkId: string;
      mode: ChunkResolveMode;
      /** Links made live now (or by this chunk's earlier, interrupted run). */
      live: number;
      /** `link` findings added at `pending`. */
      pending: number;
      /** `record` findings added. */
      records: number;
      /** Chunk-to-record rows added. */
      chunkRecords: number;
      /** Links dropped because the Analyst refused them before. */
      refused: number;
      /** True when this was the document's last chunk and the document is now Processed. */
      documentProcessed: boolean;
    }
  | {
      status: 'skipped';
      chunkId?: string;
      reason:
        | 'bad_job_data'
        | 'chunk_not_found'
        | 'wrong_mode'
        | 'not_ready'
        | 'already_resolved'
        | 'chunk_failed'
        | 'changed_meanwhile';
    };

export interface ChunkResolveDeps {
  db: Db;
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>;
  matcher: Pick<NameMatcher, 'matchAll'>;
  log?: Logger;
  now?: () => Date;
}

/** The try a run is on, as the jobs service tells it. */
export type ResolveAttempt = Pick<JobHandlerInput, 'attempt' | 'attempts' | 'isLastAttempt'>;

const FIRST_AND_LAST: ResolveAttempt = { attempt: 1, attempts: 1, isLastAttempt: true };

interface Ids {
  orgId: string;
  documentId: string;
  chunkId: string;
}

/** The chunk, its document and the uploader's view, as one run reads them. */
interface Loaded {
  ids: Ids;
  stage: ChunkStage;
  text: string;
  chunkLabel: Label;
  recordType: NewChunkRecordRow['chunkRecordType'];
  extraction: Record<string, unknown> | null;
  model: string | null;
  promptVersion: string | null;
  /** The document's label (the chunk carries it too; the higher of the two, should they differ). */
  label: Label;
  embedOnly: boolean;
  view: MatchView | null;
}

/** What the Postgres step wrote. */
interface Saved {
  live: number;
  pending: number;
  records: number;
  chunkRecords: number;
  documentProcessed: boolean;
}

/** The stage each mode resolves a chunk from. */
const FROM_STAGE: Readonly<Record<ChunkResolveMode, ChunkStage>> = { full: 'extracted', mentions: 'embedded' };

/** The finding statuses that mean the Analyst refused a link: never raised or made live again. */
const REFUSED_STATUSES = ['rejected', 'removed'] as const;

/**
 * One run of the job. Returns what it did; throws `RunLater` while Ollama can't serve the matcher
 * or when the matched records changed meanwhile, and any other error for a failed try (after
 * marking the chunk and its document failed on the last).
 */
export async function resolveChunk(
  deps: ChunkResolveDeps,
  data: unknown,
  attempt: ResolveAttempt = FIRST_AND_LAST,
): Promise<ChunkResolveOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'ChunkResolve' });
  const parsed = chunkResolveJobSchema.safeParse(data);
  if (!parsed.success) {
    log.warn({ code: 'bad_job_data' }, 'a chunk-resolve job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const orgId = parsed.data.orgId.toLowerCase();
  const chunkId = parsed.data.chunkId.toLowerCase();
  const mode = parsed.data.mode;

  const loaded = await load(deps, orgId, chunkId);
  if (!loaded) {
    log.warn({ orgId, chunkId, code: 'chunk_not_found' }, 'a chunk-resolve job named no chunk');
    return { status: 'skipped', chunkId, reason: 'chunk_not_found' };
  }
  const { ids } = loaded;

  // Embed-only documents are resolved by their mentions, every other document by Gemma's answer (D42).
  if ((mode === 'mentions') !== loaded.embedOnly) {
    log.warn({ ...ids, mode, code: 'wrong_mode' }, "a chunk-resolve job's mode doesn't fit its document");
    return { status: 'skipped', chunkId, reason: 'wrong_mode' };
  }
  if (loaded.stage === 'resolved') return { status: 'skipped', chunkId, reason: 'already_resolved' };
  if (loaded.stage === 'failed') return { status: 'skipped', chunkId, reason: 'chunk_failed' };
  if (loaded.stage !== FROM_STAGE[mode]) {
    log.warn({ ...ids, mode, stage: loaded.stage, code: 'not_ready' }, 'a chunk-resolve job found the chunk not ready');
    return { status: 'skipped', chunkId, reason: 'not_ready' };
  }

  const startedAt = performance.now();
  try {
    const outcome = mode === 'full' ? await resolveFull(deps, log, loaded) : await resolveMentions(deps, loaded);
    if (outcome.status === 'resolved') {
      log.info(
        {
          ...ids,
          mode,
          model: loaded.model ?? undefined,
          live: outcome.live,
          pending: outcome.pending,
          records: outcome.records,
          chunkRecords: outcome.chunkRecords,
          refused: outcome.refused,
          documentProcessed: outcome.documentProcessed,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
        'a chunk was resolved',
      );
    } else if (outcome.reason === 'changed_meanwhile') {
      log.info({ ...ids, mode, code: outcome.reason }, 'a chunk changed during resolution; nothing was saved');
    }
    return outcome;
  } catch (err) {
    if (err instanceof RunLater) throw err;
    if (unavailable(err)) {
      log.warn(
        { ...ids, code: err.code, model: err.model, delaySeconds: OLLAMA_WAIT_SECONDS },
        'the embedder is unavailable; the chunk waits',
      );
      throw new RunLater(OLLAMA_WAIT_SECONDS, 'the embedder is unavailable');
    }
    if (err instanceof LinkEndsChanged) {
      log.info(
        { ...ids, code: err.code, delaySeconds: ENDS_CHANGED_WAIT_SECONDS },
        'records the chunk names changed; it will be matched again',
      );
      throw new RunLater(ENDS_CHANGED_WAIT_SECONDS, 'records changed');
    }
    log.warn(
      { ...ids, mode, ...errorKind(err), attempt: attempt.attempt, attempts: attempt.attempts },
      'a chunk resolution failed',
    );
    if (attempt.isLastAttempt) await markFailed(deps, log, ids, FROM_STAGE[mode]);
    throw safeError(err);
  }
}

/** True for the failures that mean "Ollama can't serve this now": wait, don't fail (D45.7). */
function unavailable(err: unknown): err is AiFailure {
  return isAiFailure(err, 'unavailable') || isAiFailure(err, 'timed_out');
}

// Reads the chunk with its document, and the uploader's view, in one transaction.
async function load(deps: ChunkResolveDeps, orgId: string, chunkId: string): Promise<Loaded | undefined> {
  return withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(orgId), async (tx) => {
    const [row] = await tx
      .select({
        documentId: chunks.documentId,
        stage: chunks.stage,
        text: chunks.text,
        chunkLabel: chunks.label,
        recordType: chunks.recordType,
        extraction: chunks.extraction,
        model: chunks.extractionModel,
        promptVersion: chunks.extractionPromptVersion,
        documentLabel: documents.label,
        uploaderType: documents.uploaderType,
        uploaderId: documents.uploaderId,
      })
      .from(chunks)
      .innerJoin(documents, and(eq(documents.orgId, chunks.orgId), eq(documents.id, chunks.documentId)))
      .where(and(eq(chunks.orgId, orgId), eq(chunks.id, chunkId)))
      .limit(1);
    if (!row) return undefined;
    const view = await uploaderView(
      tx,
      { orgId, uploaderType: row.uploaderType, uploaderId: row.uploaderId },
      deps.now?.() ?? new Date(),
    );
    const chunkLabel: Label = isLabel(row.chunkLabel) ? row.chunkLabel : 'restricted';
    const documentLabel: Label = isLabel(row.documentLabel) ? row.documentLabel : 'restricted';
    return {
      ids: { orgId, documentId: row.documentId, chunkId },
      stage: row.stage,
      text: row.text,
      chunkLabel: row.chunkLabel,
      recordType: row.recordType,
      extraction: row.extraction ?? null,
      model: row.model ?? null,
      promptVersion: row.promptVersion ?? null,
      label: higherLabel(chunkLabel, documentLabel),
      embedOnly: row.uploaderType === 'system',
      view,
    };
  });
}

// Full mode: Gemma's answer, matched, checked, decided.
async function resolveFull(deps: ChunkResolveDeps, log: Logger, loaded: Loaded): Promise<ChunkResolveOutcome> {
  const { ids, view } = loaded;
  if (loaded.extraction === null || !loaded.model || !loaded.promptVersion) {
    log.warn({ ...ids, code: 'not_ready' }, 'an extracted chunk has no stored answer');
    return { status: 'skipped', chunkId: ids.chunkId, reason: 'not_ready' };
  }
  const { answer } = readExtractionAnswer(loaded.extraction);

  // 1. What each name means, in the uploader's view (null: sees nothing, so nothing matches).
  const matches = await deps.matcher.matchAll(
    ids.orgId,
    view,
    answer.records.map((r) => ({ kind: r.kind, name: r.name })),
  );
  const ends = matchedEnds(ids.documentId, answer.records, matches);
  const proposed = proposedRecords(answer.records, ends);

  // 2. The rule checks, without the links the Analyst refused before.
  const evaluated = evaluateLinks({
    chunkId: ids.chunkId,
    chunkText: loaded.text,
    documentLabel: loaded.label,
    links: answer.links,
    ends,
  });
  const refused = await refusedLinks(deps.db, ids.orgId, evaluated);
  const kept = evaluated.filter((link) => !isRefused(identityOfLink(link), refused));

  // 3. The confident ones go live, in one Neo4j transaction with their audit entries.
  const confident = kept.flatMap(toWrite);
  const outcomes =
    view !== null && confident.length > 0
      ? await writeLiveLinks(
          { outbox: deps.outbox },
          ids.orgId,
          view,
          {
            documentId: ids.documentId,
            chunkId: ids.chunkId,
            model: loaded.model,
            promptVersion: loaded.promptVersion,
            sourceLabel: loaded.label,
          },
          confident,
        )
      : new Map<string, LiveLinkOutcome>();

  // 4. The findings, the chunk-to-record rows, the stage and the document's end, in one Postgres
  //    transaction.
  const matched = new Map<string, ChunkRecordKind>();
  for (const end of ends.values()) if (end.match) matched.set(end.match.recordId, end.kind);
  const model = loaded.model;
  const promptVersion = loaded.promptVersion;
  const saved = await save(deps, loaded, FROM_STAGE.full, matched, async (tx) => {
    const recordFindings = await addRecordFindings(tx, loaded, proposed, model, promptVersion);
    let dropped = 0;
    const rows: NewReviewFindingRow[] = [];
    for (const link of kept) {
      const proposal = linkProposal(link, recordFindings.ids);
      if (!proposal) {
        dropped += 1;
        continue;
      }
      const outcome = outcomes.get(link.key);
      rows.push({
        orgId: ids.orgId,
        kind: 'link',
        status: outcome === 'created' || outcome === 'ours' ? 'live' : 'pending',
        findingKey: link.key,
        proposal,
        documentId: ids.documentId,
        chunkId: ids.chunkId,
        sentence: link.sentence,
        failedChecks: link.failed,
        label: link.label,
        model,
        promptVersion,
      });
    }
    if (dropped > 0) log.warn({ ...ids, code: 'bad_proposal', dropped }, 'link proposals were dropped');
    const added =
      rows.length === 0
        ? []
        : await tx
            .insert(reviewFindings)
            .values(rows)
            .onConflictDoNothing({ target: [reviewFindings.orgId, reviewFindings.findingKey] })
            .returning({ status: reviewFindings.status });
    return {
      live: added.filter((r) => r.status === 'live').length,
      pending: added.filter((r) => r.status === 'pending').length,
      records: recordFindings.added,
    };
  });
  if (!saved) return { status: 'skipped', chunkId: ids.chunkId, reason: 'changed_meanwhile' };
  return {
    status: 'resolved',
    chunkId: ids.chunkId,
    mode: 'full',
    live: saved.live,
    pending: saved.pending,
    records: saved.records,
    chunkRecords: saved.chunkRecords,
    refused: evaluated.length - kept.length,
    documentProcessed: saved.documentProcessed,
  };
}

// A link that passed every rule check (so both ends are clear matches) as a live link to write;
// none for any other.
function toWrite(link: EvaluatedLink): LiveLinkWrite[] {
  const from = link.from.match;
  const to = link.to.match;
  if (link.failed.length > 0 || !from || !to) return [];
  return [
    {
      key: link.key,
      type: link.type,
      from: { kind: link.from.kind, id: from.recordId },
      to: { kind: link.to.kind, id: to.recordId },
      sentence: link.sentence,
    },
  ];
}

// The links of the org the Analyst refused (rejected, or removed once live) of the types this chunk
// proposes, as identities.
async function refusedLinks(db: Db, orgId: string, links: readonly EvaluatedLink[]): Promise<LinkIdentity[]> {
  if (links.length === 0) return [];
  const types = [...new Set(links.map((l) => l.type))];
  const rows = await withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), (tx) =>
    tx
      .select({ proposal: reviewFindings.proposal })
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.orgId, orgId),
          eq(reviewFindings.kind, 'link'),
          inArray(reviewFindings.status, [...REFUSED_STATUSES]),
          inArray(sql<string>`${reviewFindings.proposal}->>'type'`, types),
        ),
      ),
  );
  return rows.map((r) => identityOfProposal(r.proposal)).filter((i): i is LinkIdentity => i !== null);
}

// Adds the chunk's `record` findings (each once per document, kind and name) and answers each
// proposal's finding ID by key, with how many were added now.
async function addRecordFindings(
  tx: Tx,
  loaded: Loaded,
  proposed: readonly ProposedRecord[],
  model: string,
  promptVersion: string,
): Promise<{ ids: Map<string, string>; added: number }> {
  const ids = new Map<string, string>();
  if (proposed.length === 0) return { ids, added: 0 };
  const inserted = await tx
    .insert(reviewFindings)
    .values(
      proposed.map((p): NewReviewFindingRow => ({
        orgId: loaded.ids.orgId,
        kind: 'record',
        status: 'pending',
        findingKey: p.key,
        proposal: p.proposal,
        documentId: loaded.ids.documentId,
        chunkId: loaded.ids.chunkId,
        label: loaded.label,
        model,
        promptVersion,
      })),
    )
    .onConflictDoNothing({ target: [reviewFindings.orgId, reviewFindings.findingKey] })
    .returning({ id: reviewFindings.id, key: reviewFindings.findingKey });
  for (const row of inserted) ids.set(row.key, row.id);
  // Another chunk of the document proposed the same record first: point to its finding.
  const missing = proposed.map((p) => p.key).filter((key) => !ids.has(key));
  if (missing.length > 0) {
    const existing = await tx
      .select({ id: reviewFindings.id, key: reviewFindings.findingKey })
      .from(reviewFindings)
      .where(and(eq(reviewFindings.orgId, loaded.ids.orgId), inArray(reviewFindings.findingKey, missing)));
    for (const row of existing) ids.set(row.key, row.id);
  }
  return { ids, added: inserted.length };
}

// Mentions mode: the records the chunk names, in the uploader's view, as chunk-to-record rows only.
async function resolveMentions(deps: ChunkResolveDeps, loaded: Loaded): Promise<ChunkResolveOutcome> {
  const { ids, view } = loaded;
  const named = new Map<string, ChunkRecordKind>();
  if (view !== null) {
    for (const kind of RECORD_KINDS) {
      const read = kindRead(view, kind);
      if (!read) continue;
      const records: KeyedName[] = await readFor(deps.graph, ids.orgId, view, read, (tx) => readScan(tx, read.scope));
      for (const r of mentionedRecords(loaded.text, records)) named.set(r.id, kind);
    }
  }
  const saved = await save(deps, loaded, FROM_STAGE.mentions, named, () =>
    Promise.resolve({ live: 0, pending: 0, records: 0 }),
  );
  if (!saved) return { status: 'skipped', chunkId: ids.chunkId, reason: 'changed_meanwhile' };
  return {
    status: 'resolved',
    chunkId: ids.chunkId,
    mode: 'mentions',
    live: 0,
    pending: 0,
    records: 0,
    chunkRecords: saved.chunkRecords,
    refused: 0,
    documentProcessed: saved.documentProcessed,
  };
}

/**
 * The Postgres step, in one transaction under the intake system context: the document is locked
 * first (so the chunks of one document finish one after another and exactly one of them sees it
 * done), the chunk moves to `resolved` only from the stage this run read (else nothing is written
 * and the answer is null), then `findings` adds the findings, the chunk-to-record rows go in, and
 * the document becomes `processed` when every chunk of it is resolved.
 */
async function save(
  deps: ChunkResolveDeps,
  loaded: Loaded,
  fromStage: ChunkStage,
  named: ReadonlyMap<string, ChunkRecordKind>,
  findings: (tx: Tx) => Promise<Pick<Saved, 'live' | 'pending' | 'records'>>,
): Promise<Saved | null> {
  const { ids } = loaded;
  return withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(ids.orgId), async (tx) => {
    const now = deps.now?.() ?? new Date();
    await lockDocument(tx, ids);
    const moved = await tx
      .update(chunks)
      .set({ stage: 'resolved', updatedAt: now })
      .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.id, ids.chunkId), eq(chunks.stage, fromStage)))
      .returning({ id: chunks.id });
    if (moved.length === 0) return null;

    const counts = await findings(tx);

    const rows: NewChunkRecordRow[] = [...named].map(([recordId, recordKind]) => ({
      orgId: ids.orgId,
      chunkId: ids.chunkId,
      recordId,
      recordKind,
      chunkRecordType: loaded.recordType,
      label: loaded.chunkLabel,
    }));
    const linked =
      rows.length === 0
        ? []
        : await tx
            .insert(chunkRecords)
            .values(rows)
            .onConflictDoNothing({ target: [chunkRecords.orgId, chunkRecords.chunkId, chunkRecords.recordId] })
            .returning({ recordId: chunkRecords.recordId });

    const documentProcessed = await finishDocument(tx, ids, now);
    return { ...counts, chunkRecords: linked.length, documentProcessed };
  });
}

// Locks the chunk's document row for the rest of the transaction.
async function lockDocument(tx: Tx, ids: Ids): Promise<void> {
  await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId)))
    .for('update');
}

// The document becomes `processed` (only from `processing`) when none of its chunks is left unresolved.
async function finishDocument(tx: Tx, ids: Ids, now: Date): Promise<boolean> {
  const [left] = await tx
    .select({ n: count() })
    .from(chunks)
    .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.documentId, ids.documentId), ne(chunks.stage, 'resolved')));
  if (Number(left?.n ?? 0) > 0) return false;
  const updated = await tx
    .update(documents)
    .set({ status: 'processed', updatedAt: now })
    .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId), eq(documents.status, 'processing')))
    .returning({ id: documents.id });
  return updated.length > 0;
}

// The last try failed: the chunk ends `failed` (if still at the stage this run read) and its
// document `failed` with `resolve_failed` (unless it already failed), in one transaction. The other
// chunks still finish. A failure here is logged, and the try's own error goes on to the failed-jobs
// list (D72).
async function markFailed(deps: ChunkResolveDeps, log: Logger, ids: Ids, fromStage: ChunkStage): Promise<void> {
  try {
    const marked = await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(ids.orgId), async (tx) => {
      const now = deps.now?.() ?? new Date();
      await lockDocument(tx, ids);
      const failedChunk = await tx
        .update(chunks)
        .set({ stage: 'failed', updatedAt: now })
        .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.id, ids.chunkId), eq(chunks.stage, fromStage)))
        .returning({ id: chunks.id });
      if (failedChunk.length === 0) return false;
      await tx
        .update(documents)
        .set({ status: 'failed', failureCode: RESOLVE_FAILURE_CODE, updatedAt: now })
        .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId), ne(documents.status, 'failed')));
      return true;
    });
    if (marked) {
      log.error({ ...ids, code: RESOLVE_FAILURE_CODE }, "a chunk's resolution used its last try; the document failed");
    }
  } catch (err) {
    log.error(
      { ...ids, code: RESOLVE_FAILURE_CODE, ...errorKind(err) },
      'a chunk whose resolution used its last try could not be marked failed',
    );
  }
}

/** The error a failed try leaves in pg-boss: the AI clients' own errors (codes only), or one that
 * names only the error's type and code, since a database error's message can quote a value. */
function safeError(err: unknown): Error {
  if (err instanceof AiFailure || err instanceof AiCallError || err instanceof AiInputError) return err;
  const { errorType, errorCode } = errorKind(err);
  const out = new Error(`chunk resolution failed (${errorType ?? 'Error'}${errorCode ? `, ${errorCode}` : ''})`);
  out.name = 'ChunkResolveError';
  return out;
}

/** Registers the handler in the worker program only (D36); S4-005 and S4-006 queue it. */
export class ChunkResolveJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'ChunkResolve' });

  constructor(
    private readonly jobs: JobsService,
    private readonly deps: Omit<ChunkResolveDeps, 'log'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: ChunkResolveDeps = { ...this.deps, log: this.log };
    await this.jobs.work(
      PROCESSING_QUEUES.chunkResolve,
      async (job) => {
        await resolveChunk(deps, job.data, job);
      },
      { concurrency: PROCESSING_CONCURRENCY.chunkResolve },
    );
  }
}
