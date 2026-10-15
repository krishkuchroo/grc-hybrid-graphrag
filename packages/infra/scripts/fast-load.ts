// Fast-load mode's writes (S3-019; D42, D45.4, D45.5, D45.8, D48, D56, D57, D163, D164, D213 (7)):
// the batches of `planFastLoad` (packages/generators/src/fast-load/) written straight into Neo4j,
// Postgres and the org's bucket, through the api's own services. `pnpm gen:data --mode fast` runs
// it (gen-data.ts); nothing here starts a job or touches Gemma or bge-m3.
//
// - Graph batches: one Neo4j write transaction per batch, as `grc_writer` in `org-<orgId>`, through
//   `AuditOutbox.withAuditedWrite`. It write-locks the batch's record counters, finds which of the
//   batch's records are already there, takes the numbers of the new ones per kind in one go (the
//   same `(:RecordCounter {kind})` nodes S1's creates use, so each kind's numbers run on unbroken),
//   creates them (origin `import`, `sourceIds` `[answer-key:<key>]`, owner the org's Admin, created
//   by `system:fast-load`), draws the batch's links that aren't there yet (MERGE, origin `import`),
//   and saves one outbox entry `generator.loaded` (actor `system` `fast-load`, target the org,
//   `meta { recordIds, counts: { records, links }, generatorVersion, seed }`). The relay copies it
//   into the org's hash chain like any entry. A record's ID is derived from its org and answer-key
//   key (a name-based UUID), so a record is never made twice, even by two runs at once.
// - Document batches: the files go into the org's bucket under `sha256/<hex>` (only when missing),
//   then one grc_app transaction under the intake system context inserts the `documents` rows
//   (status `stored`, uploader `system` / `system:fast-load`, label `internal` as an upload's
//   default) that aren't there yet, by content, and appends one `generator.loaded` entry
//   (`appendInTx`, `meta { documentIds, counts: { documents }, generatorVersion, seed }`). No
//   `processing.document-read` job is queued: S4 decides how these are chunked and embedded.
// - A batch with nothing new writes nothing and no entry, so a re-run adds nothing. A batch that
//   fails keeps neither its writes nor its entry (a stored file may stay; a re-run reuses it).
// - Entries, errors and results hold IDs, codes and counts only, never a name or text (D164).
import { createHash, randomUUID } from 'node:crypto';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import type { AuditService } from '../../api/src/audit/audit.service.js';
import { OutboxRelay } from '../../api/src/audit/outbox-relay.job.js';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../../api/src/audit/outbox.js';
import type { Db } from '../../api/src/db/client.js';
import { withOrgContext } from '../../api/src/db/org-context.js';
import type { GraphService } from '../../api/src/graph/graph.service.js';
import { AUDIT_OUTBOX_LABEL } from '../../api/src/graph/privileges.js';
import { documents, type NewDocumentRow } from '../../api/src/intake/intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../api/src/intake/queues.js';
import { sniffFileFormat } from '../../api/src/intake/uploads/sniff.js';
import { DEFAULT_UPLOAD_LABEL, storageKeyFor } from '../../api/src/intake/uploads/store-upload.js';
import { NUMBER_CLASH_ATTEMPTS, RECORD_COUNTER_LABEL, isNumberClash } from '../../api/src/records/record-numbers.js';
import type { FileStore } from '../../api/src/storage/file-store.js';
import type {
  DocumentBatch,
  FastLoadDocument,
  FastLoadLink,
  FastLoadPlan,
  FastLoadRecord,
  GraphBatch,
  OrgFastLoadPlan,
} from '../../generators/src/index.js';
import { FIRST_NUMBER, NODE_LABELS, formatNumber, isAllowedLink, type RecordKind } from '../../shared/src/index.js';

/** The audit action of every fast-load batch (D213 (7)). */
export const GENERATOR_LOADED = 'generator.loaded';
/** Who fast-load's audit entries name. */
export const FAST_LOAD_ACTOR: AuditActor = Object.freeze({ actorType: 'system', actorId: 'fast-load' });
/** `createdBy` and `updatedBy` on fast-loaded records and links, and the documents' uploader. */
export const FAST_LOAD_AUTHOR = 'system:fast-load';
/** Files put into the bucket at once. */
export const FILE_CONCURRENCY = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The fixed namespace of fast-loaded record IDs (UUID v5, RFC 9562).
const RECORD_ID_NAMESPACE = '5e0f8a2c-9d41-4b6e-a3f7-2c8d1e6b9a40';

/** A fast-loaded record's ID: a lowercase name-based UUID (v5) from its org and answer-key key. */
export function fastLoadRecordId(orgId: string, key: string): string {
  const ns = Buffer.from(RECORD_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(`${orgId}:${key}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A load that can't go on: a code and where (an org, a batch, a document's place), never a value. */
export class FastLoadError extends Error {
  constructor(
    readonly code:
      | 'bad_target'
      | 'unknown_org'
      | 'bad_record'
      | 'bad_link'
      | 'link_end_missing'
      | 'document_changed'
      | 'document_format_mismatch',
    readonly where: string,
  ) {
    super(`fast load: ${code} (${where})`);
    this.name = 'FastLoadError';
  }
}

export interface FastLoadDeps {
  /** grc_app (the restricted app account). */
  db: Db;
  graph: Pick<GraphService, 'read' | 'write'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'put' | 'exists'>;
  /** The time stamp of new records and links; now by default. */
  now?: () => string;
  /** Files put at once; `FILE_CONCURRENCY` by default. */
  fileConcurrency?: number;
}

/** Where one org of the plan goes: its org ID, and the user its records are owned by (its Admin). */
export interface FastLoadTarget {
  orgKey: string;
  orgId: string;
  ownerId: string;
}

export interface BatchDone {
  orgKey: string;
  orgId: string;
  kind: 'graph' | 'documents';
  n: number;
  /** What the batch created; 0 and no entry when everything was already there. */
  created: number;
  links: number;
  entry: boolean;
}

export interface OrgFastLoadResult {
  orgKey: string;
  orgId: string;
  records: { created: number; existing: number };
  links: { created: number };
  documents: { created: number; existing: number };
  /** The `generator.loaded` entries written (one per batch that created something). */
  entries: number;
  /** The IDs this run created, in plan order. */
  recordIds: string[];
  documentIds: string[];
}

export interface FastLoadResult {
  orgs: OrgFastLoadResult[];
  totals: {
    orgs: number;
    recordsCreated: number;
    recordsExisting: number;
    linksCreated: number;
    documentsCreated: number;
    documentsExisting: number;
    entries: number;
  };
}

export interface RunFastLoadOptions {
  onBatch?: (done: BatchDone) => void;
  onOrgDone?: (done: OrgFastLoadResult) => void;
}

interface OrgRun {
  orgKey: string;
  orgId: string;
  ownerId: string;
  generatorVersion: string;
  seed: number;
  now: () => string;
}

/** Thrown inside a batch transaction that found nothing new: it rolls back, with no entry. */
class NothingNew extends Error {
  constructor() {
    super('nothing new in this batch');
    this.name = 'NothingNew';
  }
}

/** Integers go to Neo4j as integers, not floats (as S1's records do). */
function toNeo(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === 'number' && Number.isInteger(v) ? neo4j.int(v) : v]),
  );
}

/** Write-locks the counters of these kinds that exist, so batches into one org take turns. */
async function lockCounters(tx: ManagedTransaction, kinds: readonly RecordKind[]): Promise<void> {
  await tx.run(`MATCH (c:${RECORD_COUNTER_LABEL}) WHERE c.kind IN $kinds SET c.__lock = true REMOVE c.__lock`, {
    kinds,
  });
}

const TAKE_NUMBERS = `MERGE (c:${RECORD_COUNTER_LABEL} {kind: $kind})
ON CREATE SET c.next = $first + $n - 1
ON MATCH SET c.next = c.next + $n
RETURN c.next AS last`;

/** Takes `n` numbers of `kind` from the org's counter in this transaction, lowest first. */
async function takeNumbers(tx: ManagedTransaction, kind: RecordKind, n: number): Promise<string[]> {
  const res = await tx.run(TAKE_NUMBERS, { kind, first: neo4j.int(FIRST_NUMBER), n: neo4j.int(n) });
  const last = Number(res.records[0]?.get('last'));
  if (!Number.isInteger(last)) throw new Error('fast load: the record counter gave no number');
  return Array.from({ length: n }, (_, i) => formatNumber(kind, last - n + 1 + i));
}

/** The IDs among `ids` that a node of `kind` already has. */
async function existingIds(tx: ManagedTransaction, kind: RecordKind, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await tx.run(`UNWIND $ids AS id MATCH (n:${NODE_LABELS[kind]} {id: id}) RETURN n.id AS id`, { ids });
  return new Set(res.records.map((r) => String(r.get('id'))));
}

function checkRecord(run: OrgRun, n: number, r: FastLoadRecord): void {
  if (!(r.kind in NODE_LABELS) || NODE_LABELS[r.kind] !== r.nodeLabel) {
    throw new FastLoadError('bad_record', `${run.orgKey} graph batch ${n}`);
  }
}

function checkLink(run: OrgRun, n: number, l: FastLoadLink): void {
  if (!isAllowedLink(l.type, l.fromKind, l.toKind))
    throw new FastLoadError('bad_link', `${run.orgKey} graph batch ${n}`);
}

/** Draws the links that aren't there yet; answers how many were new. */
async function drawLinks(tx: ManagedTransaction, run: OrgRun, batch: GraphBatch, now: string): Promise<number> {
  // One query per link type and pair of kinds, in the order each first appears.
  const groups = new Map<string, { link: FastLoadLink; rows: { fromId: string; toId: string }[] }>();
  for (const link of batch.links) {
    const name = `${link.type}|${link.fromKind}|${link.toKind}`;
    let group = groups.get(name);
    if (group === undefined) {
      group = { link, rows: [] };
      groups.set(name, group);
    }
    group.rows.push({
      fromId: fastLoadRecordId(run.orgId, link.fromKey),
      toId: fastLoadRecordId(run.orgId, link.toKey),
    });
  }
  let created = 0;
  for (const { link, rows } of groups.values()) {
    // The type and labels come from fixed lists (checked by `checkLink` and NODE_LABELS).
    const token = randomUUID();
    const res = await tx.run(
      `UNWIND $rows AS l
       MATCH (a:${NODE_LABELS[link.fromKind]} {id: l.fromId})
       MATCH (b:${NODE_LABELS[link.toKind]} {id: l.toId})
       MERGE (a)-[r:${link.type}]->(b)
       ON CREATE SET r.createdAt = $now, r.createdBy = $by, r.origin = 'import', r.__created = $token
       WITH r, coalesce(r.__created = $token, false) AS isNew
       REMOVE r.__created
       RETURN count(r) AS matched, sum(CASE WHEN isNew THEN 1 ELSE 0 END) AS added`,
      { rows, now, by: FAST_LOAD_AUTHOR, token },
    );
    const matched = Number(res.records[0]?.get('matched') ?? 0);
    if (matched !== rows.length) throw new FastLoadError('link_end_missing', `${run.orgKey} graph batch ${batch.n}`);
    created += Number(res.records[0]?.get('added') ?? 0);
  }
  return created;
}

interface GraphBatchResult {
  created: string[];
  existing: number;
  links: number;
  entry: boolean;
}

/** Writes one graph batch in one transaction with its one entry (see the top of the file). */
async function writeGraphBatch(deps: FastLoadDeps, run: OrgRun, batch: GraphBatch): Promise<GraphBatchResult> {
  batch.records.forEach((r) => checkRecord(run, batch.n, r));
  batch.links.forEach((l) => checkLink(run, batch.n, l));
  const kinds = [...new Set(batch.records.map((r) => r.kind))];
  const idOf = new Map(batch.records.map((r) => [r.key, fastLoadRecordId(run.orgId, r.key)]));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.outbox.withAuditedWrite(run.orgId, FAST_LOAD_ACTOR, async (tx) => {
        await lockCounters(tx, kinds);
        const there = new Set<string>();
        for (const kind of kinds) {
          const ids = batch.records.filter((r) => r.kind === kind).map((r) => idOf.get(r.key)!);
          for (const id of await existingIds(tx, kind, ids)) there.add(id);
        }
        const now = run.now();
        const fresh = batch.records.filter((r) => !there.has(idOf.get(r.key)!));
        for (const kind of kinds) {
          const rows = fresh.filter((r) => r.kind === kind);
          if (rows.length === 0) continue;
          const numbers = await takeNumbers(tx, kind, rows.length);
          const props = rows.map((r, i) =>
            toNeo({
              ...r.fields,
              id: idOf.get(r.key)!,
              number: numbers[i]!,
              sourceIds: [r.sourceId],
              sensitivity: r.label,
              status: 'active',
              owner: run.ownerId,
              version: 1,
              createdAt: now,
              createdBy: FAST_LOAD_AUTHOR,
              updatedAt: now,
              updatedBy: FAST_LOAD_AUTHOR,
              origin: 'import',
            }),
          );
          await tx.run(`UNWIND $rows AS row CREATE (n:${NODE_LABELS[kind]}) SET n = row`, { rows: props });
        }
        const links = await drawLinks(tx, run, batch, now);
        const created = fresh.map((r) => idOf.get(r.key)!);
        if (created.length === 0 && links === 0) throw new NothingNew();
        const audit: OutboxAudit = {
          action: GENERATOR_LOADED,
          targetType: 'org',
          targetId: run.orgId,
          meta: {
            recordIds: created,
            counts: { records: created.length, links },
            generatorVersion: run.generatorVersion,
            seed: run.seed,
          },
        };
        return { result: { created, existing: there.size, links, entry: true }, audit };
      });
    } catch (err) {
      if (err instanceof NothingNew) return { created: [], existing: batch.records.length, links: 0, entry: false };
      // Another writer took the same first number, or made the same record, first: decide again.
      if (isNumberClash(err) && attempt < NUMBER_CLASH_ATTEMPTS) continue;
      throw err;
    }
  }
}

/** Runs `fn` over `items`, at most `limit` at once; stops starting new ones after a failure. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** The document's bytes, checked against the plan: the same size and hash, and its format by content. */
function bytesOf(run: OrgRun, n: number, i: number, doc: FastLoadDocument): Buffer {
  const where = `${run.orgKey} document batch ${n} item ${i + 1}`;
  const body = Buffer.from(doc.body, 'utf8');
  const hash = createHash('sha256').update(body).digest('hex');
  if (body.length !== doc.sizeBytes || hash !== doc.contentHash) throw new FastLoadError('document_changed', where);
  const sniffed = sniffFileFormat(doc.fileName, body);
  if (!sniffed.ok || sniffed.format !== doc.format) throw new FastLoadError('document_format_mismatch', where);
  return body;
}

interface DocumentBatchResult {
  created: string[];
  existing: number;
  entry: boolean;
}

/** Stores one document batch: the files, then the rows and their one entry in one transaction. */
async function writeDocumentBatch(deps: FastLoadDeps, run: OrgRun, batch: DocumentBatch): Promise<DocumentBatchResult> {
  const bodies = batch.documents.map((doc, i) => bytesOf(run, batch.n, i, doc));
  await eachLimited(
    batch.documents.map((doc, i) => ({ doc, body: bodies[i]! })),
    deps.fileConcurrency ?? FILE_CONCURRENCY,
    async ({ doc, body }) => {
      const key = storageKeyFor(doc.contentHash);
      if (!(await deps.files.exists(run.orgId, key))) await deps.files.put(run.orgId, key, body, doc.contentType);
    },
  );

  const rows: NewDocumentRow[] = batch.documents.map((doc) => ({
    orgId: run.orgId,
    kind: doc.kind,
    recordType: doc.recordType,
    format: doc.format,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    contentHash: doc.contentHash,
    storageKey: storageKeyFor(doc.contentHash),
    label: DEFAULT_UPLOAD_LABEL,
    uploaderType: 'system',
    uploaderId: FAST_LOAD_AUTHOR,
    source: doc.source,
    status: 'stored',
  }));
  const order = new Map(batch.documents.map((doc, i) => [doc.contentHash, i]));

  return withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(run.orgId), async (tx) => {
    const inserted =
      rows.length === 0
        ? []
        : await tx
            .insert(documents)
            .values(rows)
            .onConflictDoNothing({ target: [documents.orgId, documents.contentHash] })
            .returning({ id: documents.id, contentHash: documents.contentHash });
    if (inserted.length === 0) return { created: [], existing: rows.length, entry: false };
    const created = inserted
      .sort((a, b) => (order.get(a.contentHash) ?? 0) - (order.get(b.contentHash) ?? 0))
      .map((row) => row.id);
    await deps.audit.appendInTx(tx, {
      orgId: run.orgId,
      ...FAST_LOAD_ACTOR,
      action: GENERATOR_LOADED,
      targetType: 'org',
      targetId: run.orgId,
      meta: {
        documentIds: created,
        counts: { documents: created.length },
        generatorVersion: run.generatorVersion,
        seed: run.seed,
      },
    });
    return { created, existing: rows.length - created.length, entry: true };
  });
}

/** Loads one org of the plan: its graph batches in order, then its document batches in order. */
export async function fastLoadOrg(
  deps: FastLoadDeps,
  plan: Pick<FastLoadPlan, 'generatorVersion' | 'seed'>,
  org: OrgFastLoadPlan,
  target: FastLoadTarget,
  opts: Pick<RunFastLoadOptions, 'onBatch'> = {},
): Promise<OrgFastLoadResult> {
  if (
    target.orgKey !== org.orgKey ||
    !UUID.test(target.orgId) ||
    typeof target.ownerId !== 'string' ||
    target.ownerId === ''
  ) {
    throw new FastLoadError('bad_target', org.orgKey);
  }
  const run: OrgRun = {
    orgKey: org.orgKey,
    orgId: target.orgId,
    ownerId: target.ownerId,
    generatorVersion: plan.generatorVersion,
    seed: plan.seed,
    now: deps.now ?? (() => new Date().toISOString()),
  };
  const result: OrgFastLoadResult = {
    orgKey: org.orgKey,
    orgId: target.orgId,
    records: { created: 0, existing: 0 },
    links: { created: 0 },
    documents: { created: 0, existing: 0 },
    entries: 0,
    recordIds: [],
    documentIds: [],
  };
  for (const batch of org.graphBatches) {
    const done = await writeGraphBatch(deps, run, batch);
    result.records.created += done.created.length;
    result.records.existing += done.existing;
    result.links.created += done.links;
    result.recordIds.push(...done.created);
    if (done.entry) result.entries += 1;
    opts.onBatch?.({
      orgKey: run.orgKey,
      orgId: run.orgId,
      kind: 'graph',
      n: batch.n,
      created: done.created.length,
      links: done.links,
      entry: done.entry,
    });
  }
  for (const batch of org.documentBatches) {
    const done = await writeDocumentBatch(deps, run, batch);
    result.documents.created += done.created.length;
    result.documents.existing += done.existing;
    result.documentIds.push(...done.created);
    if (done.entry) result.entries += 1;
    opts.onBatch?.({
      orgKey: run.orgKey,
      orgId: run.orgId,
      kind: 'documents',
      n: batch.n,
      created: done.created.length,
      links: 0,
      entry: done.entry,
    });
  }
  return result;
}

/**
 * Loads every target org of the plan, one org at a time, in target order (see the top of the
 * file). Every target names an org of the plan, once. Stops at the first failure; a re-run
 * finishes what is missing.
 */
export async function runFastLoad(
  deps: FastLoadDeps,
  plan: FastLoadPlan,
  targets: readonly FastLoadTarget[],
  opts: RunFastLoadOptions = {},
): Promise<FastLoadResult> {
  const byKey = new Map(plan.orgs.map((org) => [org.orgKey, org]));
  const seen = new Set<string>();
  for (const target of targets) {
    if (!byKey.has(target.orgKey)) throw new FastLoadError('unknown_org', target.orgKey);
    if (seen.has(target.orgKey)) throw new FastLoadError('bad_target', target.orgKey);
    seen.add(target.orgKey);
  }
  const orgs: OrgFastLoadResult[] = [];
  for (const target of targets) {
    const done = await fastLoadOrg(deps, plan, byKey.get(target.orgKey)!, target, opts);
    orgs.push(done);
    opts.onOrgDone?.(done);
  }
  const sum = (pick: (o: OrgFastLoadResult) => number) => orgs.reduce((n, o) => n + pick(o), 0);
  return {
    orgs,
    totals: {
      orgs: orgs.length,
      recordsCreated: sum((o) => o.records.created),
      recordsExisting: sum((o) => o.records.existing),
      linksCreated: sum((o) => o.links.created),
      documentsCreated: sum((o) => o.documents.created),
      documentsExisting: sum((o) => o.documents.existing),
      entries: sum((o) => o.entries),
    },
  };
}

/** How many outbox entries these orgs' databases still hold. */
export async function outboxLeft(graph: Pick<GraphService, 'read'>, orgIds: readonly string[]): Promise<number> {
  let left = 0;
  for (const orgId of orgIds) {
    left += await graph.read(orgId, async (tx) => {
      const res = await tx.run(`MATCH (o:${AUDIT_OUTBOX_LABEL}) RETURN count(o) AS n`);
      return Number(res.records[0]?.get('n') ?? 0);
    });
  }
  return left;
}

/**
 * Copies these orgs' outbox entries into their Postgres hash chains now, with the worker's own
 * relay (safe alongside the worker: an entry already copied is not copied again), until their
 * outboxes are empty or `maxPasses` passes have run. Answers the passes run and what is left.
 */
export async function relayOutbox(
  deps: { graph: Pick<GraphService, 'read' | 'write'>; audit: Pick<AuditService, 'append'> },
  orgIds: readonly string[],
  opts: { maxPasses?: number } = {},
): Promise<{ passes: number; left: number }> {
  const maxPasses = opts.maxPasses ?? 20;
  const relay = new OutboxRelay({ graph: deps.graph, audit: deps.audit, orgIds: async () => orgIds });
  let left = await outboxLeft(deps.graph, orgIds);
  let passes = 0;
  while (left > 0 && passes < maxPasses) {
    await relay.runOnce();
    passes += 1;
    left = await outboxLeft(deps.graph, orgIds);
  }
  return { passes, left };
}
