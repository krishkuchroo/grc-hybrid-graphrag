// The document reader (S4-004; D25, D29, D41, D42, D45.5, D45.7, D53, D71, D72, D163): the
// `processing.document-read` handler. It runs in the worker program only (D36), 4 at a time (D72
// "read file ×4"), under the intake system context (the org wall still applies). For one stored
// policy document, SOC ticket or audit report it:
//   1. makes sure bge-m3's tokenizer is set up; when it isn't, it logs which command to run and
//      puts the job off (`RunLater`, no try used up), leaving the document `stored`;
//   2. reads the stored file from the org's own bucket;
//   3. reads its text in the file sandbox (./document-text.ts: its own process, 256 MB for the
//      whole read, decompressed PDF and DOCX data included, and 30 s);
//   4. cuts the text into chunks of at most 500 bge-m3 tokens, each starting 50 tokens before the
//      previous one ended (./chunker.ts);
//   5. in one transaction (D29): saves the chunks (stage `read`, the document's record type and
//      label), moves the document to `processing`, and queues `processing.document-embed`.
// Any other kind of document is left alone. A document that already has its chunks gets no second
// set: the job only makes sure its embed job is queued (D45.5).
//
// Failures: a file that can't be read ends the document `failed` with `unreadable`, one with no
// text with `no_text`, a sandbox limit with `timed_out` or `too_much_memory`; none of these is
// retried, because the same file fails the same way. A storage or database error is retried (D72),
// and on the last try the document ends `failed` with `read_failed`. Status changes write no audit
// entry (as in S3). Log lines hold only IDs, codes, counts and times, never a file name or text.
import type { OnApplicationBootstrap } from '@nestjs/common';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import { documents } from '../../intake/intake.schema.js';
import { runInProcessSandbox, SandboxError, type SandboxLimits } from '../../intake/imports/file-sandbox.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import { RunLater, type JobHandlerInput, type JobsService } from '../../jobs/jobs.module.js';
import type { FileStore } from '../../storage/file-store.js';
import type { DocumentFailureCode } from '../failure-codes.js';
import { CHUNK_RECORD_TYPES, chunks, type ChunkRecordType, type NewChunkRow } from '../processing.schema.js';
import {
  PROCESSING_CONCURRENCY,
  PROCESSING_JOB_KEYS,
  PROCESSING_QUEUES,
  type DocumentEmbedJob,
  type DocumentReadJob,
} from '../queues.js';
import { chunkText } from './chunker.js';
import { isReadableDocumentKind, isReadableFormat, type ReadableFormat } from './readable-kinds.js';
import { BgeM3Tokenizer, TokenizerUnavailableError, type TokenCounter } from './tokenizer.js';
import { TOKENIZER_SETUP_COMMAND } from './tokenizer-source.js';

/** How long a job waits before trying again while the tokenizer isn't set up. */
export const TOKENIZER_WAIT_SECONDS = 300;

/** Chunks saved per insert statement (all of them in the one transaction). */
export const CHUNK_INSERT_BATCH = 500;

/** The failure codes the sandboxed read gives for a file, none of them retried. */
const FILE_FAILURE_CODES = [
  'unreadable',
  'timed_out',
  'too_much_memory',
] as const satisfies readonly DocumentFailureCode[];
type FileFailureCode = (typeof FILE_FAILURE_CODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID);

/** The job's data (S4 shared notes, "The job chain"). */
export const documentReadJobSchema = z.object({ orgId: uuid, documentId: uuid });

/** What one run did. */
export type DocumentReadOutcome =
  | { status: 'processing'; documentId: string; chunkCount: number; embedJobId: string | null }
  | { status: 'already_read'; documentId: string; embedJobId: string | null }
  | { status: 'failed'; documentId: string; code: DocumentFailureCode }
  | {
      status: 'skipped';
      documentId?: string;
      reason: 'bad_job_data' | 'document_not_found' | 'not_a_readable_kind' | 'not_stored';
    };

/** Reads a document's text from its bytes; the default is the file sandbox. */
export type TextReader = (format: ReadableFormat, bytes: Uint8Array) => Promise<string>;

// The text reader sits next to this file, with its own extension (`.ts` from source).
const OWN_EXTENSION = /\.[cm]?[jt]s$/.exec(new URL(import.meta.url).pathname)?.[0] ?? '.js';
const DOCUMENT_TEXT = {
  module: new URL(`./document-text${OWN_EXTENSION}`, import.meta.url),
  exportName: 'readDocumentText',
} as const;

/**
 * The default reader: ./document-text.ts in the file sandbox's own process, with the sandbox's
 * limits. The memory limit holds for the whole process, not only its heap (D53): PDF and DOCX data
 * decompress into buffers outside it, and a file that would take more ends `too_much_memory`
 * while this program carries on.
 */
export function sandboxedTextReader(limits: SandboxLimits = {}): TextReader {
  return (format, bytes) => runInProcessSandbox<string>({ ...DOCUMENT_TEXT, input: bytes, args: [format] }, limits);
}

export interface DocumentReaderDeps {
  db: Db;
  files: Pick<FileStore, 'get'>;
  jobs: Pick<JobsService, 'sendInTx'>;
  /** bge-m3's tokenizer; throws a `TokenizerUnavailableError` when it isn't set up. */
  tokenizer: () => Promise<TokenCounter>;
  readText?: TextReader;
  log?: Logger;
}

interface Doc {
  id: string;
  orgId: string;
  kind: string;
  format: string;
  status: string;
  storageKey: string;
  recordType: string;
  label: (typeof documents.$inferSelect)['label'];
}

function isFileFailureCode(code: string): code is FileFailureCode {
  return (FILE_FAILURE_CODES as readonly string[]).includes(code);
}

function isChunkRecordType(v: string): v is ChunkRecordType {
  return (CHUNK_RECORD_TYPES as readonly string[]).includes(v);
}

const whereDocument = (orgId: string, documentId: string) =>
  and(eq(documents.orgId, orgId), eq(documents.id, documentId));

const whereChunksOf = (orgId: string, documentId: string) =>
  and(eq(chunks.orgId, orgId), eq(chunks.documentId, documentId));

// Queues the document's embed job in the caller's transaction; null when one is already queued or
// running (its job key is the document ID).
function queueEmbed(deps: Pick<DocumentReaderDeps, 'jobs'>, tx: Tx, orgId: string, documentId: string) {
  const data: DocumentEmbedJob = { orgId, documentId };
  return deps.jobs.sendInTx(tx, PROCESSING_QUEUES.documentEmbed, data, {
    singletonKey: PROCESSING_JOB_KEYS.documentEmbed(documentId),
  });
}

async function chunkCountOf(tx: Tx, orgId: string, documentId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(chunks).where(whereChunksOf(orgId, documentId));
  return Number(row?.n ?? 0);
}

/**
 * Ends the document `failed` with `code`, while it is `stored` (or `processing` with no chunks).
 * Answers whether it changed.
 */
export async function failDocument(
  db: Db,
  orgId: string,
  documentId: string,
  code: DocumentFailureCode,
): Promise<boolean> {
  return withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), async (tx) => {
    const updated = await tx
      .update(documents)
      .set({ status: 'failed', failureCode: code, updatedAt: new Date() })
      .where(
        and(
          whereDocument(orgId, documentId),
          inArray(documents.status, ['stored', 'processing']),
          sql`NOT EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.orgId} = ${orgId}::uuid AND ${chunks.documentId} = ${documentId}::uuid)`,
        ),
      )
      .returning({ id: documents.id });
    return updated.length > 0;
  });
}

async function fail(
  deps: DocumentReaderDeps,
  log: Logger,
  doc: Doc,
  code: DocumentFailureCode,
): Promise<DocumentReadOutcome> {
  const ids = { orgId: doc.orgId, documentId: doc.id };
  const changed = await failDocument(deps.db, doc.orgId, doc.id, code);
  if (!changed) return { status: 'skipped', documentId: doc.id, reason: 'not_stored' };
  log.warn({ ...ids, code }, 'a document could not be read');
  return { status: 'failed', documentId: doc.id, code };
}

/** One run of the job (see the top of the file). Throws only for what a retry may fix. */
export async function readDocument(deps: DocumentReaderDeps, data: unknown): Promise<DocumentReadOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'DocumentReader' });
  const readText = deps.readText ?? sandboxedTextReader();
  const parsed = documentReadJobSchema.safeParse(data);
  if (!parsed.success) {
    log.warn({ code: 'bad_job_data' }, 'a document read job had bad data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const job: DocumentReadJob = parsed.data;
  const ids = { orgId: job.orgId, documentId: job.documentId };
  const ctx = INTAKE_SYSTEM_CONTEXT(job.orgId);

  // The document, and whether it already has its chunks.
  const found = await withOrgContext(deps.db, ctx, async (tx) => {
    const [doc] = await tx
      .select({
        id: documents.id,
        orgId: documents.orgId,
        kind: documents.kind,
        format: documents.format,
        status: documents.status,
        storageKey: documents.storageKey,
        recordType: documents.recordType,
        label: documents.label,
      })
      .from(documents)
      .where(whereDocument(job.orgId, job.documentId))
      .limit(1);
    if (!doc || !isReadableDocumentKind(doc.kind)) return { doc, chunkCount: 0, embedJobId: null };
    const chunkCount = await chunkCountOf(tx, job.orgId, job.documentId);
    // Already read: only make sure its embed job is queued, while it is still being processed.
    const embedJobId =
      chunkCount > 0 && doc.status === 'processing' ? await queueEmbed(deps, tx, job.orgId, job.documentId) : null;
    return { doc, chunkCount, embedJobId };
  });
  const doc: Doc | undefined = found.doc;
  if (!doc) {
    log.warn({ ...ids, code: 'document_not_found' }, 'a document read job named no document');
    return { status: 'skipped', reason: 'document_not_found' };
  }
  if (!isReadableDocumentKind(doc.kind)) {
    return { status: 'skipped', documentId: doc.id, reason: 'not_a_readable_kind' };
  }
  if (found.chunkCount > 0) {
    return { status: 'already_read', documentId: doc.id, embedJobId: found.embedJobId };
  }
  if (doc.status !== 'stored' && doc.status !== 'processing') {
    return { status: 'skipped', documentId: doc.id, reason: 'not_stored' };
  }

  // 1. The tokenizer, before the file is opened at all.
  let tokenizer: TokenCounter;
  try {
    tokenizer = await deps.tokenizer();
  } catch (err) {
    if (err instanceof TokenizerUnavailableError) {
      log.error(
        {
          ...ids,
          code: err.code,
          file: err.file,
          command: TOKENIZER_SETUP_COMMAND,
          retryInSeconds: TOKENIZER_WAIT_SECONDS,
        },
        `${err.message} Documents stay stored until then.`,
      );
      throw new RunLater(TOKENIZER_WAIT_SECONDS, err.code);
    }
    throw err;
  }

  if (!isReadableFormat(doc.format)) return fail(deps, log, doc, 'unreadable');
  const started = performance.now();

  // 2. The stored file.
  let bytes: Buffer;
  try {
    bytes = await deps.files.get(doc.orgId, doc.storageKey);
  } catch (err) {
    log.error({ ...ids, ...errorKind(err) }, 'the stored file of a document could not be read');
    throw err;
  }

  // 3. Its text, in the sandbox.
  let text: string;
  try {
    text = await readText(doc.format, bytes);
  } catch (err) {
    if (err instanceof SandboxError && isFileFailureCode(err.code)) return fail(deps, log, doc, err.code);
    log.error(
      { ...ids, ...errorKind(err), code: err instanceof SandboxError ? err.code : undefined },
      'a document read broke',
    );
    throw err;
  }
  if (typeof text !== 'string' || !/\S/.test(text)) return fail(deps, log, doc, 'no_text');

  // 4. The chunks.
  const pieces = await chunkText(text, tokenizer);
  if (pieces.length === 0) return fail(deps, log, doc, 'no_text');
  if (!isChunkRecordType(doc.recordType)) throw new Error('document reader: the document has no chunk record type');
  const recordType = doc.recordType;

  // 5. The chunks, the move to `processing` and the embed job, in one transaction.
  const saved = await withOrgContext(deps.db, ctx, async (tx) => {
    const [locked] = await tx
      .select({ status: documents.status })
      .from(documents)
      .where(whereDocument(doc.orgId, doc.id))
      .for('update');
    if (!locked) return { kind: 'gone' as const };
    if ((await chunkCountOf(tx, doc.orgId, doc.id)) > 0) {
      const embedJobId = locked.status === 'processing' ? await queueEmbed(deps, tx, doc.orgId, doc.id) : null;
      return { kind: 'already' as const, embedJobId };
    }
    if (locked.status !== 'stored' && locked.status !== 'processing') return { kind: 'not_stored' as const };

    for (let i = 0; i < pieces.length; i += CHUNK_INSERT_BATCH) {
      const rows: NewChunkRow[] = pieces.slice(i, i + CHUNK_INSERT_BATCH).map((piece) => ({
        orgId: doc.orgId,
        documentId: doc.id,
        position: piece.position,
        text: piece.text,
        tokenCount: piece.tokenCount,
        startOffset: piece.startOffset,
        endOffset: piece.endOffset,
        recordType,
        label: doc.label,
        stage: 'read',
      }));
      await tx.insert(chunks).values(rows);
    }
    await tx
      .update(documents)
      .set({ status: 'processing', failureCode: null, updatedAt: new Date() })
      .where(whereDocument(doc.orgId, doc.id));
    const embedJobId = await queueEmbed(deps, tx, doc.orgId, doc.id);
    return { kind: 'saved' as const, embedJobId };
  });

  if (saved.kind === 'gone') return { status: 'skipped', reason: 'document_not_found' };
  if (saved.kind === 'not_stored') return { status: 'skipped', documentId: doc.id, reason: 'not_stored' };
  if (saved.kind === 'already') return { status: 'already_read', documentId: doc.id, embedJobId: saved.embedJobId };

  log.info(
    {
      ...ids,
      chunkCount: pieces.length,
      tokenCount: pieces.reduce((n, p) => n + p.tokenCount, 0),
      ms: Math.round(performance.now() - started),
      embedJobId: saved.embedJobId,
    },
    'a document was read into chunks and queued for embedding',
  );
  return { status: 'processing', documentId: doc.id, chunkCount: pieces.length, embedJobId: saved.embedJobId };
}

/**
 * The handler as the worker runs it: one run of `readDocument`. When a try fails (a storage or
 * database error), the error goes back to pg-boss for D72's retries; on the last try the document
 * first ends `failed` with `read_failed`. `RunLater` (the tokenizer isn't set up) passes straight on.
 */
export async function handleDocumentRead(
  deps: DocumentReaderDeps,
  job: Pick<JobHandlerInput, 'id' | 'data' | 'isLastAttempt' | 'attempt'>,
): Promise<DocumentReadOutcome> {
  try {
    return await readDocument(deps, job.data);
  } catch (err) {
    if (err instanceof RunLater || !job.isLastAttempt) throw err;
    const parsed = documentReadJobSchema.safeParse(job.data);
    if (parsed.success) {
      const log = deps.log ?? createLogger().child({ context: 'DocumentReader' });
      const ids = { orgId: parsed.data.orgId, documentId: parsed.data.documentId, jobId: job.id };
      try {
        if (await failDocument(deps.db, parsed.data.orgId, parsed.data.documentId, 'read_failed')) {
          log.warn({ ...ids, code: 'read_failed', attempt: job.attempt }, 'a document read used its last try');
        }
      } catch (markErr) {
        log.error({ ...ids, ...errorKind(markErr) }, 'a document could not be marked failed after its last try');
      }
    }
    throw err;
  }
}

/** Registers the reader in the worker program only; the API program never opens files (D53). */
export class DocumentReaderJob implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'DocumentReader' });

  constructor(
    private readonly jobs: JobsService,
    private readonly db: Db,
    private readonly files: FileStore,
    private readonly tokenizer: BgeM3Tokenizer = new BgeM3Tokenizer(),
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    // Say at start-up when the tokenizer isn't set up; the jobs wait for it.
    try {
      await this.tokenizer.check();
    } catch (err) {
      if (err instanceof TokenizerUnavailableError) {
        this.log.error(
          { code: err.code, file: err.file, command: TOKENIZER_SETUP_COMMAND },
          `${err.message} Documents stay stored until then.`,
        );
      } else {
        this.log.error(errorKind(err), "bge-m3's tokenizer files could not be checked");
      }
    }
    const deps: DocumentReaderDeps = {
      db: this.db,
      files: this.files,
      jobs: this.jobs,
      tokenizer: () => this.tokenizer.get(),
      log: this.log,
    };
    await this.jobs.work(
      PROCESSING_QUEUES.documentRead,
      async (job) => {
        await handleDocumentRead(deps, job);
      },
      { concurrency: PROCESSING_CONCURRENCY.documentRead },
    );
  }
}
