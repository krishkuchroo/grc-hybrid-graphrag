// Processing part 2a, chunk vectors (S4-005; D25, D29, D42, D45.5, D45.7, D71, D72): the
// `processing.document-embed` handler. It runs in the worker program only, 2 at a time (D72
// "embed ×2"), under the intake system context. For one document in `processing` it:
//   1. takes the chunks with no vector yet (stage `read`), in position order, a batch at a time;
//   2. has bge-m3 (EMBEDDER) embed each batch and stores the vectors (stage `embedded`), each batch
//      in its own transaction and only on chunks still without one;
//   3. in the same transaction as the last vectors, queues the next step for every chunk at
//      `embedded`: `processing.chunk-extract` (Gemma) for a full document, or
//      `processing.chunk-resolve` with mode `mentions` for an embed-only, fast-loaded one (D42:
//      uploader type `system`).
// Re-runs (D45.5): a chunk with a vector is never embedded again, a chunk past `embedded` is never
// queued again, and each chunk's job key is its ID, so a job already waiting isn't doubled.
// A document the Analyst removes meanwhile (S5-004, D52.5) stops the run: each batch first reads
// the document's status, and each batch's transaction holds the document's row shared and checks
// it again before it stores anything or queues a next step, so nothing is written for it after
// the removal.
// Ollama down or busy (`unavailable`, `timed_out`): the job is put off with `RunLater`, which uses
// no try, so the document stays Processing and carries on by itself once Ollama is back (D45.7).
// A long document stops after a time budget and carries on in a fresh copy of the job, so a run
// never outlives pg-boss's job expiry. Any other error is a failed try (D72); on the last one the
// document ends `failed` with `embed_failed`.
// Logs and the error a failed try leaves (D163): IDs, counts, timings, the model and error codes.
// Never a chunk's text or a vector.
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { ProcessingMode } from '@grc/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { AiCallError, AiFailure, AiInputError, isAiFailure } from '../../ai/ai-failure.js';
import type { Embedder } from '../../ai/embedder.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import { documents } from '../../intake/intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import { RunLater, type JobHandlerInput, type JobsService } from '../../jobs/jobs.module.js';
import { chunks } from '../processing.schema.js';
import {
  PROCESSING_CONCURRENCY,
  PROCESSING_JOB_KEYS,
  PROCESSING_QUEUES,
  type ChunkExtractJob,
  type ChunkResolveJob,
} from '../queues.js';

/** Chunks embedded per call to the embedder (it sends them to Ollama in its own smaller batches). */
export const CHUNK_EMBED_BATCH = 64;

/** How long a job waits before it tries again while Ollama is down or busy (D45.7). */
export const OLLAMA_WAIT_SECONDS = 60;

/** After this long a run starts no new batch and the job carries on in a fresh copy: pg-boss
 * expires a job that stays active for 15 minutes, and a batch can take up to 4 more. */
export const EMBED_RUN_BUDGET_MS = 5 * 60_000;

/** How soon the fresh copy of a long document's job may start. */
const CARRY_ON_SECONDS = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's data (S4 shared notes, "The job chain"). */
export const documentEmbedJobSchema = z.object({ orgId: z.string().regex(UUID), documentId: z.string().regex(UUID) });

/** What one run did. `skipped`: nothing to do (bad job data, no such document, or not Processing). */
export type DocumentEmbedOutcome =
  | { status: 'embedded'; documentId: string; mode: ProcessingMode; embedded: number; queued: number }
  | { status: 'skipped'; documentId?: string; reason: 'bad_job_data' | 'document_not_found' | 'not_processing' };

export interface DocumentEmbedDeps {
  db: Db;
  embedder: Pick<Embedder, 'embed'>;
  jobs: Pick<JobsService, 'sendInTx'>;
  log?: Logger;
  /** Chunks per embedder call; CHUNK_EMBED_BATCH by default. */
  batchSize?: number;
  /** Seconds to wait while Ollama is down; OLLAMA_WAIT_SECONDS by default. */
  waitSeconds?: number;
  /** A run's time budget; EMBED_RUN_BUDGET_MS by default. */
  runBudgetMs?: number;
}

interface DocumentIds {
  orgId: string;
  documentId: string;
}

/** True for the failures that mean "Ollama can't serve this now": wait, don't fail (D45.7). */
export function embedderUnavailable(err: unknown): err is AiFailure {
  return isAiFailure(err, 'unavailable') || isAiFailure(err, 'timed_out');
}

/**
 * One run of the job. Resolves when the document's chunks all have vectors and their next step is
 * queued, or when there's nothing to do. Throws `RunLater` while Ollama is down or when a long
 * document carries on in a fresh job; any other throw is a failed try.
 */
export async function embedDocument(
  deps: DocumentEmbedDeps,
  job: Pick<JobHandlerInput, 'data' | 'isLastAttempt'>,
): Promise<DocumentEmbedOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'DocumentEmbed' });
  const parsed = documentEmbedJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.warn({ code: 'bad_job_data' }, 'a document embed job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const ids: DocumentIds = { orgId: parsed.data.orgId.toLowerCase(), documentId: parsed.data.documentId.toLowerCase() };
  const ctx = INTAKE_SYSTEM_CONTEXT(ids.orgId);

  try {
    const doc = await withOrgContext(deps.db, ctx, async (tx) => {
      const [row] = await tx
        .select({ status: documents.status, uploaderType: documents.uploaderType })
        .from(documents)
        .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId)))
        .limit(1);
      return row;
    });
    if (!doc) {
      log.warn({ ...ids, code: 'document_not_found' }, 'a document embed job named no document');
      return { status: 'skipped', reason: 'document_not_found' };
    }
    if (doc.status !== 'processing') {
      log.info({ ...ids, documentStatus: doc.status }, 'a document embed job found the document not processing');
      return { status: 'skipped', documentId: ids.documentId, reason: 'not_processing' };
    }
    const mode: ProcessingMode = doc.uploaderType === 'system' ? 'embed_only' : 'full';
    return await embedChunks(deps, log, ids, mode);
  } catch (err) {
    if (err instanceof RunLater) throw err;
    if (embedderUnavailable(err)) {
      const waitSeconds = deps.waitSeconds ?? OLLAMA_WAIT_SECONDS;
      log.warn(
        { ...ids, code: err.code, model: err.model, waitSeconds },
        'the embedder is unavailable; the document waits and tries again later',
      );
      throw new RunLater(waitSeconds, 'embedder unavailable');
    }
    log.error({ ...ids, ...errorKind(err), lastAttempt: job.isLastAttempt }, 'embedding a document failed');
    if (job.isLastAttempt) await markFailed(deps.db, log, ids);
    throw safeError(err);
  }
}

// Embeds the chunks still without a vector, batch by batch; the last batch's transaction also
// queues the next steps. A document whose chunks all have vectors only gets its next steps queued.
async function embedChunks(
  deps: DocumentEmbedDeps,
  log: Logger,
  ids: DocumentIds,
  mode: ProcessingMode,
): Promise<DocumentEmbedOutcome> {
  const ctx = INTAKE_SYSTEM_CONTEXT(ids.orgId);
  const batchSize = deps.batchSize ?? CHUNK_EMBED_BATCH;
  const budgetMs = deps.runBudgetMs ?? EMBED_RUN_BUDGET_MS;
  const startedAt = performance.now();
  const ofDocument = and(eq(chunks.orgId, ids.orgId), eq(chunks.documentId, ids.documentId));
  let embedded = 0;
  let model: string | undefined;

  for (;;) {
    if (embedded > 0 && performance.now() - startedAt > budgetMs) {
      log.info(
        { ...ids, embedded, elapsedMs: Math.round(performance.now() - startedAt) },
        'a long document carries on embedding in a fresh job',
      );
      throw new RunLater(CARRY_ON_SECONDS, 'document embed carries on');
    }

    const batch = await withOrgContext(deps.db, ctx, async (tx) => {
      if (await documentRemoved(tx, ids)) return null;
      return tx
        .select({ id: chunks.id, text: chunks.text })
        .from(chunks)
        .where(and(ofDocument, eq(chunks.stage, 'read')))
        .orderBy(asc(chunks.position))
        .limit(batchSize);
    });
    if (batch === null) return removedMeanwhile(log, ids, embedded);

    let vectors: number[][] = [];
    if (batch.length > 0) {
      const answer = await deps.embedder.embed(batch.map((c) => c.text));
      if (answer.vectors.length !== batch.length) {
        throw new AiFailure('invalid_output', { model: answer.model, elapsedMs: answer.elapsedMs });
      }
      vectors = answer.vectors;
      model = answer.model;
    }

    const step = await withOrgContext(deps.db, ctx, async (tx) => {
      // The document's row, held shared: a removal waits for this batch, or this batch for it.
      if (await documentRemoved(tx, ids, { lock: true })) return null;
      const now = new Date();
      let stored = 0;
      for (const [i, chunk] of batch.entries()) {
        const updated = await tx
          .update(chunks)
          .set({ embedding: vectors[i], stage: 'embedded', updatedAt: now })
          .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.id, chunk.id), eq(chunks.stage, 'read')))
          .returning({ id: chunks.id });
        stored += updated.length;
      }
      const [left] = await tx
        .select({ n: count() })
        .from(chunks)
        .where(and(ofDocument, eq(chunks.stage, 'read')));
      if (Number(left?.n ?? 0) > 0) return { stored, queued: null };
      return { stored, queued: await queueNextSteps(tx, deps.jobs, ids, mode) };
    });
    if (step === null) return removedMeanwhile(log, ids, embedded);
    embedded += step.stored;

    if (step.queued !== null) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (step.queued.chunks === 0) {
        log.warn({ ...ids, mode }, 'a document in processing has no embedded chunks to hand on');
      }
      log.info(
        { ...ids, mode, model, embedded, chunks: step.queued.chunks, queued: step.queued.queued, elapsedMs },
        'a document was embedded and its chunks handed on',
      );
      return { status: 'embedded', documentId: ids.documentId, mode, embedded, queued: step.queued.queued };
    }
    // Chunks are left without a vector, yet this batch found none: never loop on it.
    if (batch.length === 0) throw new Error('document embed: chunks without a vector could not be read');
  }
}

// Whether the document is gone or the Analyst removed it (S5-004). With `lock`, its row is held
// shared for the rest of the caller's transaction.
async function documentRemoved(tx: Tx, ids: DocumentIds, opts: { lock?: boolean } = {}): Promise<boolean> {
  const query = tx
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId)))
    .limit(1);
  const [row] = opts.lock ? await query.for('share') : await query;
  return !row || row.status === 'removed';
}

// The run stops: the document was removed (or deleted) while its chunks were being embedded.
function removedMeanwhile(log: Logger, ids: DocumentIds, embedded: number): DocumentEmbedOutcome {
  log.info({ ...ids, code: 'document_removed', embedded }, 'a document was removed while it was embedded; it stops');
  return { status: 'skipped', documentId: ids.documentId, reason: 'not_processing' };
}

// Queues each embedded chunk's next step in the caller's transaction (D29): Gemma extraction for a
// full document, mention linking for an embed-only one. A chunk past `embedded` is left alone.
async function queueNextSteps(
  tx: Tx,
  jobs: Pick<JobsService, 'sendInTx'>,
  ids: DocumentIds,
  mode: ProcessingMode,
): Promise<{ chunks: number; queued: number }> {
  const ready = await tx
    .select({ id: chunks.id })
    .from(chunks)
    .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.documentId, ids.documentId), eq(chunks.stage, 'embedded')))
    .orderBy(asc(chunks.position));
  let queued = 0;
  for (const { id } of ready) {
    let jobId: string | null;
    if (mode === 'embed_only') {
      const data: ChunkResolveJob = { orgId: ids.orgId, chunkId: id, mode: 'mentions' };
      jobId = await jobs.sendInTx(tx, PROCESSING_QUEUES.chunkResolve, data, {
        singletonKey: PROCESSING_JOB_KEYS.chunkResolve(id),
      });
    } else {
      const data: ChunkExtractJob = { orgId: ids.orgId, chunkId: id };
      jobId = await jobs.sendInTx(tx, PROCESSING_QUEUES.chunkExtract, data, {
        singletonKey: PROCESSING_JOB_KEYS.chunkExtract(id),
      });
    }
    if (jobId !== null) queued += 1;
  }
  return { chunks: ready.length, queued };
}

// The last try is used up: the document ends `failed` with `embed_failed` (only from `processing`).
async function markFailed(db: Db, log: Logger, ids: DocumentIds): Promise<void> {
  try {
    const updated = await withOrgContext(db, INTAKE_SYSTEM_CONTEXT(ids.orgId), (tx) =>
      tx
        .update(documents)
        .set({ status: 'failed', failureCode: 'embed_failed', updatedAt: new Date() })
        .where(
          and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId), eq(documents.status, 'processing')),
        )
        .returning({ id: documents.id }),
    );
    if (updated.length > 0)
      log.warn({ ...ids, code: 'embed_failed' }, 'a document failed: its chunks were not embedded');
  } catch (err) {
    log.error({ ...ids, ...errorKind(err) }, 'a document could not be marked failed');
  }
}

/** The error a failed try leaves in pg-boss: the AI clients' own errors (codes only), or one that
 * names only the error's type and code, since a database error's message can quote a vector. */
function safeError(err: unknown): Error {
  if (err instanceof AiFailure || err instanceof AiCallError || err instanceof AiInputError) return err;
  const { errorType, errorCode } = errorKind(err);
  const out = new Error(`document embedding failed (${errorType ?? 'Error'}${errorCode ? `, ${errorCode}` : ''})`);
  out.name = 'DocumentEmbedError';
  return out;
}

/** Registers the handler in the worker program only (D36). */
export class DocumentEmbedJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'DocumentEmbed' });

  constructor(
    private readonly jobs: JobsService,
    private readonly db: Db,
    private readonly embedder: Embedder,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: DocumentEmbedDeps = { db: this.db, embedder: this.embedder, jobs: this.jobs, log: this.log };
    await this.jobs.work(
      PROCESSING_QUEUES.documentEmbed,
      async (job) => {
        await embedDocument(deps, job);
      },
      { concurrency: PROCESSING_CONCURRENCY.documentEmbed },
    );
  }
}
