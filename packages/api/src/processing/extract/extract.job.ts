// Gemma extraction (S4-006; D16, D34, D38, D39, D41, D45.5, D45.7, D52, D69, D72, D163): the
// `processing.chunk-extract` handler. It runs in the worker program only (D36), one job at a time
// (D72 "Gemma ×1"), under the intake system context (S3 planner's reading R10), so the org wall
// still applies. For one embedded chunk of a full-pipeline document it:
//   1. asks Gemma for the records and links the chunk states (./prompt.ts: the chunk's text as data
//      inside <UNSTRUCTURED_DOCUMENT_CONTEXT>, its own section markers neutralised);
//   2. reads the answer with S4-001's lenient reader: valid items kept, the rest dropped and counted;
//   3. stores the kept answer, the model and the prompt version on the chunk (stage `extracted`) and
//      queues `processing.chunk-resolve` with mode `full`, in one transaction (D29).
// Re-runs (D45.5): a chunk already extracted is never sent to Gemma again; the job only makes sure
// its resolution is queued. The store applies only while the chunk is still `embedded`.
// Ollama down (D45.7): the job is put off with `RunLater`, using up no try, so the chunk waits and
// the document stays Processing. Anything else, an unreadable answer included, is a failed try
// (D72); on the last one the chunk ends `failed` and the document `failed` with `extract_failed`.
// Fast-loaded documents (uploader type `system`) are embed-only (D42) and never reach Gemma.
// A chunk of a document the Analyst removed (S5-004, D52.5) is never sent to Gemma, and an answer
// that comes back after the removal is not stored: the store's transaction holds the document's row
// shared and checks its status first, so nothing is written or queued for it. A last failed try
// never turns a removed document into a failed one.
//
// Logs (D163): IDs, counts, timings, the model, the prompt version and codes. Never the chunk's
// text, the prompt or the answer.
import type { OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, notInArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isAiFailure } from '../../ai/ai-failure.js';
import type { TextModel } from '../../ai/text-model.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import { documents } from '../../intake/intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import type { JobHandlerInput, JobsService } from '../../jobs/jobs.module.js';
import { RunLater } from '../../jobs/jobs.module.js';
import { chunks } from '../processing.schema.js';
import { PROCESSING_CONCURRENCY, PROCESSING_JOB_KEYS, PROCESSING_QUEUES, type ChunkResolveJob } from '../queues.js';
import { askForExtraction, type ExtractionResult } from './prompt.js';

/** How long a chunk waits before it is tried again while Ollama can't serve it (D45.7). */
export const OLLAMA_WAIT_SECONDS = 60;

/** The code a document fails with when a chunk's extraction has used its last try. */
export const EXTRACT_FAILURE_CODE = 'extract_failed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID);

/** The job's data (S4 shared notes, "The job chain"). */
export const chunkExtractJobSchema = z.object({ orgId: uuid, chunkId: uuid });

/** The answer was JSON but nothing in it could be read (D52.4): a failed try, so D72's retries apply. */
export class UnreadableExtraction extends Error {
  readonly code = 'unreadable_answer';

  constructor() {
    super('Nothing in the extraction answer could be read.');
    this.name = 'UnreadableExtraction';
  }
}

/** What one run did. */
export type ChunkExtractOutcome =
  | {
      status: 'extracted';
      chunkId: string;
      records: number;
      links: number;
      droppedRecords: number;
      droppedLinks: number;
      /** The resolve job's ID, or null when one with the chunk's key was already queued or running. */
      resolveJobId: string | null;
    }
  | { status: 'resolve_queued'; chunkId: string; resolveJobId: string | null }
  | {
      status: 'skipped';
      chunkId?: string;
      reason:
        | 'bad_job_data'
        | 'chunk_not_found'
        | 'embed_only'
        | 'not_embedded'
        | 'already_resolved'
        | 'chunk_failed'
        | 'changed_meanwhile'
        | 'document_removed';
    };

export interface ChunkExtractDeps {
  db: Db;
  jobs: Pick<JobsService, 'sendInTx'>;
  textModel: TextModel;
  log?: Logger;
}

/** The try a run is on, as the jobs service tells it. */
export type ExtractAttempt = Pick<JobHandlerInput, 'attempt' | 'attempts' | 'isLastAttempt'>;

const FIRST_AND_LAST: ExtractAttempt = { attempt: 1, attempts: 1, isLastAttempt: true };

interface ChunkAndDocument {
  chunkId: string;
  documentId: string;
  stage: string;
  text: string;
  uploaderType: string;
  documentStatus: string;
}

type Ids = { orgId: string; documentId: string; chunkId: string };

// Whether the chunk's document is gone or the Analyst removed it (S5-004). With `lock`, its row is
// held shared for the rest of the caller's transaction, so a removal waits for it (or it for one).
async function documentRemoved(tx: Tx, ids: Ids, opts: { lock?: boolean } = {}): Promise<boolean> {
  const query = tx
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId)))
    .limit(1);
  const [row] = opts.lock ? await query.for('share') : await query;
  return !row || row.status === 'removed';
}

/**
 * One run of the job. Returns what it did; throws `RunLater` while Ollama can't serve the call, and
 * any other error for a failed try (after marking the chunk and its document failed on the last).
 */
export async function extractChunk(
  deps: ChunkExtractDeps,
  data: unknown,
  attempt: ExtractAttempt = FIRST_AND_LAST,
): Promise<ChunkExtractOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'ChunkExtract' });
  const parsed = chunkExtractJobSchema.safeParse(data);
  if (!parsed.success) {
    log.warn({ code: 'bad_job_data' }, 'a chunk-extract job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const { orgId, chunkId } = parsed.data;
  const ctx = INTAKE_SYSTEM_CONTEXT(orgId);

  const found = await withOrgContext(deps.db, ctx, async (tx): Promise<ChunkAndDocument | undefined> => {
    const [row] = await tx
      .select({
        chunkId: chunks.id,
        documentId: chunks.documentId,
        stage: chunks.stage,
        text: chunks.text,
        uploaderType: documents.uploaderType,
        documentStatus: documents.status,
      })
      .from(chunks)
      .innerJoin(documents, and(eq(documents.orgId, chunks.orgId), eq(documents.id, chunks.documentId)))
      .where(and(eq(chunks.orgId, orgId), eq(chunks.id, chunkId)))
      .limit(1);
    return row;
  });
  if (!found) {
    log.warn({ orgId, chunkId, code: 'chunk_not_found' }, 'a chunk-extract job named no chunk');
    return { status: 'skipped', chunkId, reason: 'chunk_not_found' };
  }
  const ids = { orgId, documentId: found.documentId, chunkId };

  // A removed document's chunks are never sent to Gemma (S5-004).
  if (found.documentStatus === 'removed') {
    log.info({ ...ids, code: 'document_removed' }, 'a chunk-extract job found its document removed');
    return { status: 'skipped', chunkId, reason: 'document_removed' };
  }

  // Fast-loaded documents get chunks, vectors and mention links only, never Gemma (D42).
  if (found.uploaderType === 'system') {
    log.warn({ ...ids, code: 'embed_only' }, 'a chunk of an embed-only document was not sent for extraction');
    return { status: 'skipped', chunkId, reason: 'embed_only' };
  }

  switch (found.stage) {
    case 'extracted':
      return queueResolve(deps, log, ids);
    case 'resolved':
      return { status: 'skipped', chunkId, reason: 'already_resolved' };
    case 'failed':
      return { status: 'skipped', chunkId, reason: 'chunk_failed' };
    case 'embedded':
      break;
    default:
      log.warn(
        { ...ids, stage: found.stage, code: 'not_embedded' },
        'a chunk-extract job found the chunk not embedded',
      );
      return { status: 'skipped', chunkId, reason: 'not_embedded' };
  }

  try {
    const result = await ask(deps, log, ids, found.text, attempt);
    return await store(deps, log, ids, result);
  } catch (err) {
    if (err instanceof RunLater) throw err;
    if (attempt.isLastAttempt) await markFailed(deps, log, ids, err);
    throw err;
  }
}

// Asks Gemma once. Ollama being down puts the job off; an unreadable answer is a failed try.
async function ask(
  deps: ChunkExtractDeps,
  log: Logger,
  ids: { orgId: string; documentId: string; chunkId: string },
  text: string,
  attempt: ExtractAttempt,
): Promise<ExtractionResult> {
  const tries = { attempt: attempt.attempt, attempts: attempt.attempts };
  let result: ExtractionResult;
  try {
    result = await askForExtraction(deps.textModel, text);
  } catch (err) {
    if (isAiFailure(err, 'unavailable')) {
      log.warn(
        { ...ids, code: err.code, model: err.model, delaySeconds: OLLAMA_WAIT_SECONDS },
        'the text model is unavailable; the chunk waits',
      );
      throw new RunLater(OLLAMA_WAIT_SECONDS, 'the text model is unavailable');
    }
    log.warn({ ...ids, ...errorKind(err), ...tries }, 'a chunk extraction call failed');
    throw err;
  }
  if (!result.read.readable) {
    log.warn(
      {
        ...ids,
        code: 'unreadable_answer',
        model: result.model,
        promptVersion: result.promptVersion,
        droppedRecords: result.read.droppedRecords,
        droppedLinks: result.read.droppedLinks,
        elapsedMs: result.elapsedMs,
        ...tries,
      },
      'nothing in the extraction answer could be read',
    );
    throw new UnreadableExtraction();
  }
  return result;
}

// Stores the kept answer on the chunk and queues its resolution, in one transaction, while the
// chunk is still `embedded`.
async function store(
  deps: ChunkExtractDeps,
  log: Logger,
  ids: { orgId: string; documentId: string; chunkId: string },
  result: ExtractionResult,
): Promise<ChunkExtractOutcome> {
  const { answer, droppedRecords, droppedLinks } = result.read;
  const saved = await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(ids.orgId), async (tx) => {
    if (await documentRemoved(tx, ids, { lock: true })) return { updated: false as const, removed: true };
    const updated = await tx
      .update(chunks)
      .set({
        stage: 'extracted',
        extraction: { records: answer.records, links: answer.links },
        extractionModel: result.model,
        extractionPromptVersion: result.promptVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.id, ids.chunkId), eq(chunks.stage, 'embedded')))
      .returning({ id: chunks.id });
    if (updated.length === 0) return { updated: false as const, removed: false };
    const resolveJobId = await deps.jobs.sendInTx(tx, PROCESSING_QUEUES.chunkResolve, resolveJob(ids), {
      singletonKey: PROCESSING_JOB_KEYS.chunkResolve(ids.chunkId),
    });
    return { updated: true as const, resolveJobId };
  });
  if (!saved.updated && saved.removed) {
    log.info(
      { ...ids, code: 'document_removed' },
      'the document was removed during extraction; the answer was not stored',
    );
    return { status: 'skipped', chunkId: ids.chunkId, reason: 'document_removed' };
  }
  if (!saved.updated) {
    log.info({ ...ids, code: 'changed_meanwhile' }, 'the chunk changed during extraction; its answer was not stored');
    return { status: 'skipped', chunkId: ids.chunkId, reason: 'changed_meanwhile' };
  }
  log.info(
    {
      ...ids,
      model: result.model,
      promptVersion: result.promptVersion,
      records: answer.records.length,
      links: answer.links.length,
      droppedRecords,
      droppedLinks,
      neutralisedMarkers: result.neutralisedMarkers,
      elapsedMs: result.elapsedMs,
      waitedMs: result.waitedMs,
      resolveJobId: saved.resolveJobId,
    },
    'a chunk was extracted and queued for resolution',
  );
  return {
    status: 'extracted',
    chunkId: ids.chunkId,
    records: answer.records.length,
    links: answer.links.length,
    droppedRecords,
    droppedLinks,
    resolveJobId: saved.resolveJobId,
  };
}

// A chunk already extracted: only makes sure its resolution is queued (the job key keeps it single).
async function queueResolve(
  deps: ChunkExtractDeps,
  log: Logger,
  ids: { orgId: string; documentId: string; chunkId: string },
): Promise<ChunkExtractOutcome> {
  const queued = await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(ids.orgId), async (tx) => {
    if (await documentRemoved(tx, ids, { lock: true })) return { removed: true as const };
    const jobId = await deps.jobs.sendInTx(tx, PROCESSING_QUEUES.chunkResolve, resolveJob(ids), {
      singletonKey: PROCESSING_JOB_KEYS.chunkResolve(ids.chunkId),
    });
    return { removed: false as const, jobId };
  });
  if (queued.removed) return { status: 'skipped', chunkId: ids.chunkId, reason: 'document_removed' };
  const resolveJobId = queued.jobId;
  if (resolveJobId !== null) {
    log.info({ ...ids, resolveJobId }, 'an extracted chunk was queued for resolution again');
  }
  return { status: 'resolve_queued', chunkId: ids.chunkId, resolveJobId };
}

function resolveJob(ids: { orgId: string; chunkId: string }): ChunkResolveJob {
  return { orgId: ids.orgId, chunkId: ids.chunkId, mode: 'full' };
}

// The last try failed: the chunk ends `failed` (if still `embedded`) and its document `failed` with
// `extract_failed` (unless it already failed), in one transaction. The other chunks still finish.
// A failure here is logged and the try's own error goes on to the failed-jobs list (D72).
async function markFailed(
  deps: ChunkExtractDeps,
  log: Logger,
  ids: { orgId: string; documentId: string; chunkId: string },
  cause: unknown,
): Promise<void> {
  try {
    const marked = await withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(ids.orgId), async (tx) => {
      const now = new Date();
      const failedChunk = await tx
        .update(chunks)
        .set({ stage: 'failed', updatedAt: now })
        .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.id, ids.chunkId), eq(chunks.stage, 'embedded')))
        .returning({ id: chunks.id });
      if (failedChunk.length === 0) return false;
      await tx
        .update(documents)
        .set({ status: 'failed', failureCode: EXTRACT_FAILURE_CODE, updatedAt: now })
        .where(
          and(
            eq(documents.orgId, ids.orgId),
            eq(documents.id, ids.documentId),
            notInArray(documents.status, ['failed', 'removed']),
          ),
        );
      return true;
    });
    if (!marked) return;
    log.error(
      { ...ids, code: EXTRACT_FAILURE_CODE, ...errorKind(cause) },
      "a chunk's extraction used its last try; the document failed",
    );
  } catch (err) {
    log.error(
      { ...ids, code: EXTRACT_FAILURE_CODE, ...errorKind(err) },
      'a chunk whose extraction used its last try could not be marked failed',
    );
  }
}

/** Registers the extraction job in the worker program only; the API program never calls Gemma for it. */
export class ChunkExtractJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'ChunkExtract' });

  constructor(
    private readonly jobs: JobsService,
    private readonly db: Db,
    private readonly textModel: TextModel,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: ChunkExtractDeps = { db: this.db, jobs: this.jobs, textModel: this.textModel, log: this.log };
    await this.jobs.work(
      PROCESSING_QUEUES.chunkExtract,
      async (job) => {
        await extractChunk(deps, job.data, job);
      },
      { concurrency: PROCESSING_CONCURRENCY.chunkExtract },
    );
  }
}
