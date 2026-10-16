// Processing part 2b, record name embeddings (S4-005; D25, D43, D70, D203, planner's reading
// S4-Q5). A sweep in the worker program, every 30 s after the last pass ended, over every org (the
// orgs with an audit partition, as the outbox relay lists them). For each org it:
//   1. finds active records of the nine record labels whose `nameEmbedding` is missing or was made
//      from an older name (`nameEmbeddedFrom` isn't `name`), the most recently changed first, at
//      most NAME_SWEEP_RECORDS_PER_ORG of them, so one large fast-loaded org can't starve the
//      others; the next pass carries on;
//   2. has bge-m3 (EMBEDDER) embed their names in batches and, with each node write-locked, writes
//      `nameEmbedding` and `nameEmbeddedFrom` only while the name is still the one embedded (a
//      rename in between waits for the next pass);
//   3. for each Asset, Risk, Control, Policy or Incident whose embedding is current but whose
//      duplicate check isn't queued for that name yet, queues `processing.record-dedupe` (key: the
//      record ID plus the name embedded) and only then notes it in `nameDedupeQueuedFor`. So the
//      check starts only once the embedding is saved, and a check that couldn't be queued is queued
//      by the next pass.
// The writes are derived data, like an index: as grc_writer, with no audit entry and no change to
// `version`, `updatedAt` or `updatedBy`, so no one's save is ever refused as stale because of them.
// The API's record schemas drop unknown properties, so none of the three reaches an answer or an
// audit entry.
// Ollama down or busy: the pass stops and the next one tries again (D45.7). Another embedder
// failure on a batch has its names embedded one by one, so one bad name can't hold up the others.
// Logs (D163): org IDs, record IDs, counts, timings, the model and error codes. Never a name or a
// vector.
import { createHash } from 'node:crypto';
import { NODE_LABELS } from '@grc/shared';
import type { ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import type { Embedder } from '../../ai/embedder.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { NODE_RECORD_TYPES } from '../../graph/privileges.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import { PROCESSING_JOB_KEYS, PROCESSING_QUEUES, type RecordDedupeJob } from '../queues.js';
import { embedderUnavailable } from './document-embed.job.js';

/** The node property holding the name's vector (1024 numbers, D70, D73). */
export const NAME_EMBEDDING_PROPERTY = 'nameEmbedding';
/** The node property holding the name the vector was made from. */
export const NAME_EMBEDDED_FROM_PROPERTY = 'nameEmbeddedFrom';
/** The node property holding the embedded name whose duplicate check has been queued. */
export const NAME_DEDUPE_QUEUED_PROPERTY = 'nameDedupeQueuedFor';

export const NAME_SWEEP_INTERVAL_MS = 30_000;
/** Records whose names are embedded per org in one pass. */
export const NAME_SWEEP_RECORDS_PER_ORG = 200;
/** Names per call to the embedder. */
export const NAME_EMBED_BATCH = 50;
/** Duplicate checks queued per org in one pass. */
export const NAME_DEDUPE_PER_ORG = 500;
/** A name longer than this goes into the duplicate check's job key as its SHA-256. */
const MAX_KEY_NAME_BYTES = 200;

/** The nine record labels whose names are embedded. */
const SWEPT_LABELS: readonly string[] = Object.keys(NODE_RECORD_TYPES);
/** The labels whose records get a duplicate check (S4-007). */
const DEDUPE_LABELS: readonly string[] = Object.values(NODE_LABELS);

const EMBEDDING = NAME_EMBEDDING_PROPERTY;
const FROM = NAME_EMBEDDED_FROM_PROPERTY;
const QUEUED = NAME_DEDUPE_QUEUED_PROPERTY;

function assertLabel(label: string): void {
  if (!/^[A-Z][A-Za-z]*$/.test(label)) throw new Error('name embedding sweep: unexpected label');
}

// The records of one label that need a (new) name embedding.
function dueBranch(label: string): string {
  assertLabel(label);
  return `MATCH (n:${label})
    WHERE n.status = 'active' AND n.name IS :: STRING NOT NULL AND trim(n.name) <> ''
      AND (n.${EMBEDDING} IS NULL OR n.${FROM} IS NULL OR n.${FROM} <> n.name)
    RETURN n.id AS id, '${label}' AS label, n.name AS name, coalesce(n.updatedAt, '') AS changedAt`;
}

// The records of one label with a current embedding and no duplicate check queued for that name.
function dedupeBranch(label: string): string {
  assertLabel(label);
  return `MATCH (n:${label})
    WHERE n.status = 'active' AND n.${EMBEDDING} IS NOT NULL AND n.${FROM} = n.name
      AND (n.${QUEUED} IS NULL OR n.${QUEUED} <> n.name)
    RETURN n.id AS id, '${label}' AS label, n.name AS name`;
}

/** Every swept record that needs its name embedded, most recently changed first. Pure. */
export function dueQuery(limit: number = NAME_SWEEP_RECORDS_PER_ORG): string {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('name embedding sweep: limit must be a whole number');
  return `CALL () { ${SWEPT_LABELS.map(dueBranch).join(' UNION ALL ')} }
    WITH id, label, name, changedAt ORDER BY changedAt DESC, id LIMIT ${limit} RETURN id, label, name`;
}

/** Every core record whose duplicate check is due. Pure. */
export function dedupeDueQuery(limit: number = NAME_DEDUPE_PER_ORG): string {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('name embedding sweep: limit must be a whole number');
  return `CALL () { ${DEDUPE_LABELS.map(dedupeBranch).join(' UNION ALL ')} } RETURN id, label, name LIMIT ${limit}`;
}

/** The name as it goes into the duplicate check's job key: itself, or its SHA-256 when long. */
export function dedupeKeyName(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= MAX_KEY_NAME_BYTES) return name;
  return `sha256:${createHash('sha256').update(name, 'utf8').digest('hex')}`;
}

interface DueRecord {
  id: string;
  label: string;
  name: string;
}

interface Embedded extends DueRecord {
  vector: number[];
}

export interface NameEmbeddingSweepDeps {
  graph: Pick<GraphService, 'read' | 'write'>;
  db: Db;
  jobs: Pick<JobsService, 'sendInTx'>;
  embedder: Pick<Embedder, 'embed'>;
  /** The orgs to sweep. */
  orgIds: () => Promise<readonly string[]>;
  log?: Logger;
  intervalMs?: number;
  recordsPerOrg?: number;
  batchSize?: number;
}

/** What a pass did for one org. */
export interface OrgSweepResult {
  embedded: number;
  /** Names that changed before their vector was written, or couldn't be embedded. */
  skipped: number;
  queued: number;
}

/** The embedder is down or busy: the pass stops here (D45.7). */
class EmbedderDown extends Error {
  constructor(readonly code: string) {
    super('the embedder is unavailable');
    this.name = 'EmbedderDown';
  }
}

function toDue(records: { get(key: string): unknown }[]): DueRecord[] {
  return records.map((r) => ({ id: String(r.get('id')), label: String(r.get('label')), name: String(r.get('name')) }));
}

function byLabel<T extends { label: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.label) ?? [];
    list.push(row);
    out.set(row.label, list);
  }
  return out;
}

export class NameEmbeddingSweep {
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly recordsPerOrg: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private stopRequested = false;
  private embedderDown = false;

  constructor(private readonly deps: NameEmbeddingSweepDeps) {
    this.log = (deps.log ?? createLogger()).child({ context: 'NameEmbeddingSweep' });
    this.intervalMs = deps.intervalMs ?? NAME_SWEEP_INTERVAL_MS;
    this.recordsPerOrg = deps.recordsPerOrg ?? NAME_SWEEP_RECORDS_PER_ORG;
    this.batchSize = deps.batchSize ?? NAME_EMBED_BATCH;
  }

  /** One pass over every org. Stops early while the embedder is down; an org that fails is logged
   * and the others still run. */
  async runOnce(): Promise<Map<string, OrgSweepResult>> {
    const results = new Map<string, OrgSweepResult>();
    for (const orgId of await this.deps.orgIds()) {
      if (this.stopRequested) break;
      try {
        results.set(orgId, await this.sweepOrg(orgId));
      } catch (err) {
        if (err instanceof EmbedderDown) {
          if (!this.embedderDown) {
            this.log.warn({ orgId, code: err.code }, 'the embedder is unavailable; name embeddings wait');
          }
          this.embedderDown = true;
          break;
        }
        this.log.error({ orgId, ...errorKind(err) }, 'the name embedding sweep failed for an org');
      }
    }
    return results;
  }

  /** Runs a pass now and then every `intervalMs` after each pass ends, until stopped. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopRequested = false;
    this.schedule(0);
  }

  /** Resolves once no pass is running and no new one will start. */
  async stop(): Promise<void> {
    this.started = false;
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.started) return;
      this.running = this.runOnce()
        .then(() => undefined)
        .catch((err: unknown) => this.log.error({ ...errorKind(err) }, 'a name embedding pass failed'))
        .finally(() => {
          this.running = undefined;
          if (this.started) this.schedule(this.intervalMs);
        });
    }, delay);
  }

  /** One org: embed the names that are due, then queue the duplicate checks that are due. */
  async sweepOrg(orgId: string): Promise<OrgSweepResult> {
    const startedAt = performance.now();
    const due = await this.deps.graph.read(orgId, async (tx) =>
      toDue((await tx.run(dueQuery(this.recordsPerOrg))).records),
    );
    let embedded = 0;
    let skipped = 0;
    let model: string | undefined;
    for (let start = 0; start < due.length; start += this.batchSize) {
      if (this.stopRequested) break; // the next start carries on
      const batch = due.slice(start, start + this.batchSize).filter((r) => r.name.trim() !== '');
      const done = await this.embedBatch(orgId, batch);
      model = done.model ?? model;
      skipped += batch.length - done.rows.length;
      if (done.rows.length === 0) continue;
      const written = await this.writeEmbeddings(orgId, done.rows);
      embedded += written;
      skipped += done.rows.length - written;
    }
    const queued = await this.queueDuplicateChecks(orgId);
    if (embedded > 0 || queued > 0 || skipped > 0) {
      this.log.info(
        { orgId, model, embedded, skipped, queued, elapsedMs: Math.round(performance.now() - startedAt) },
        'record names embedded',
      );
    }
    return { embedded, skipped, queued };
  }

  // Embeds a batch of names. On a failure other than "down" the names go one by one, and a name
  // that still fails is left for a later pass (logged by record ID).
  private async embedBatch(orgId: string, batch: DueRecord[]): Promise<{ rows: Embedded[]; model?: string }> {
    if (batch.length === 0) return { rows: [] };
    try {
      const answer = await this.deps.embedder.embed(batch.map((r) => r.name));
      if (this.embedderDown) {
        this.embedderDown = false;
        this.log.info({ orgId }, 'the embedder is back; name embeddings carry on');
      }
      return { rows: batch.map((r, i) => ({ ...r, vector: answer.vectors[i] ?? [] })), model: answer.model };
    } catch (err) {
      if (embedderUnavailable(err)) throw new EmbedderDown(err.code);
      if (batch.length === 1) {
        this.log.warn({ orgId, recordId: batch[0]?.id, ...errorKind(err) }, 'a record name could not be embedded');
        return { rows: [] };
      }
    }
    const rows: Embedded[] = [];
    let model: string | undefined;
    for (const record of batch) {
      const one = await this.embedBatch(orgId, [record]);
      rows.push(...one.rows);
      model = one.model ?? model;
    }
    return { rows, model };
  }

  // Writes the vectors in one transaction: each node is write-locked first (in ID order), then
  // written only while active and still carrying the name embedded. Returns how many were written.
  private async writeEmbeddings(orgId: string, rows: Embedded[]): Promise<number> {
    const valid = rows.filter((r) => r.vector.length > 0);
    if (valid.length === 0) return 0;
    const groups = byLabel([...valid].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    return this.deps.graph.write(orgId, async (tx) => {
      for (const [label, list] of groups) await lockNodes(tx, label, list);
      let written = 0;
      for (const [label, list] of groups) {
        assertLabel(label);
        const res = await tx.run(
          `UNWIND $rows AS row
           MATCH (n:${label} {id: row.id})
           WHERE n.status = 'active' AND n.name = row.name
           SET n.${EMBEDDING} = row.vector, n.${FROM} = row.name
           RETURN count(n) AS written`,
          { rows: list.map((r) => ({ id: r.id, name: r.name, vector: r.vector })) },
        );
        written += Number(res.records[0]?.get('written') ?? 0);
      }
      return written;
    });
  }

  // Queues the duplicate checks that are due, all in one Postgres transaction, and then notes each
  // as queued for its name. A note that fails leaves the check to be queued again by a later pass;
  // the job key keeps a waiting check from being doubled.
  private async queueDuplicateChecks(orgId: string): Promise<number> {
    const due = await this.deps.graph.read(orgId, async (tx) => toDue((await tx.run(dedupeDueQuery())).records));
    if (due.length === 0) return 0;
    const queued = await withOrgContext(this.deps.db, INTAKE_SYSTEM_CONTEXT(orgId), async (tx) => {
      let n = 0;
      for (const record of due) {
        const data: RecordDedupeJob = { orgId, recordId: record.id };
        const jobId = await this.deps.jobs.sendInTx(tx, PROCESSING_QUEUES.recordDedupe, data, {
          singletonKey: PROCESSING_JOB_KEYS.recordDedupe(record.id, dedupeKeyName(record.name)),
        });
        if (jobId !== null) n += 1;
      }
      return n;
    });
    await this.deps.graph.write(orgId, async (tx) => {
      for (const [label, list] of byLabel(due)) {
        assertLabel(label);
        await tx.run(
          `UNWIND $rows AS row
           MATCH (n:${label} {id: row.id})
           WHERE n.${FROM} = row.name
           SET n.${QUEUED} = row.name`,
          { rows: list.map((r) => ({ id: r.id, name: r.name })) },
        );
      }
    });
    return queued;
  }
}

// Write-locks the nodes for the rest of the transaction, the way record saves do, so the name read
// after it is the one a concurrent save left.
async function lockNodes(tx: ManagedTransaction, label: string, rows: { id: string }[]): Promise<void> {
  assertLabel(label);
  await tx.run(
    `UNWIND $ids AS id
     MATCH (n:${label} {id: id})
     SET n.__lock = true REMOVE n.__lock`,
    { ids: rows.map((r) => r.id) },
  );
}
