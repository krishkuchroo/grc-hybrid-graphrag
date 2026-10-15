// Full-pipeline mode (D18, D42): the generators act as dummy connectors and push every org's
// sources through the real API, exactly as a customer's connector would, so extraction accuracy can
// be measured later on known data. For each target org, in order:
//   1. saves the column mapping of each source its asset lists come from (`CMDB_SOURCES`);
//   2. pushes the asset lists' rows, source by source in file order, in batches of at most 1,000
//      rows (and under the API's 1 MB body cap), with batch IDs
//      `<generatorVersion>:<seed>:<orgKey>:<source>:<n>` (n from 1 per source), so a re-run sends
//      the same batch IDs and the API answers each `duplicate: true` (D45.5, D47);
//   3. uploads each document (policies, SOC tickets, audit reports), which the API stores once by
//      content, so a re-run's uploads are `duplicate: true` too.
// One org at a time, one request at a time, so the order is always the same (D45.8). It returns
// counts and the IDs the API answered with, never anything from the data.
import type { ImportMapping } from '@grc/shared';
import { CMDB_SOURCES, type OrgSources, type RenderedSources, type SourceFile } from '../sources/index.js';
import type { AnswerKey } from '../world/index.js';
import { ApiClient, type ConnectorClient, type FetchLike, type PushBatchInput } from './api-client.js';
import { assetRows, type AssetRow } from './asset-rows.js';

/** At most this many rows in one push batch. */
export const MAX_BATCH_ROWS = 1000;

/** At most this many bytes of JSON in one push body: under the API's 1 MB cap (1,048,576, D64). */
export const MAX_BATCH_BYTES = 1_000_000;

/** The push API's batch ID rules (`pushBatchSchema`). */
const BATCH_ID_CHARS = /[^A-Za-z0-9._:-]/g;
const MAX_BATCH_ID_LENGTH = 200;

/** Where one org's sources go: the org's key in the answer key, the API and the org's API key. */
export interface FullPipelineTarget {
  orgKey: string;
  baseUrl: string;
  apiKey: string;
}

export interface RunFullPipelineInput {
  key: AnswerKey;
  sources: RenderedSources;
  targets: readonly FullPipelineTarget[];
  /** Makes a target's client; an `ApiClient` over `fetch` when not given. */
  client?: (target: FullPipelineTarget) => ConnectorClient;
  /** The `fetch` the default client uses. */
  fetch?: FetchLike;
  /** Called when an org is done, with its counts only. */
  onOrgDone?: (counts: OrgPipelineResult) => void;
}

/** One planned push batch. */
export interface PlannedBatch extends PushBatchInput {
  /** The batch's number within its source, from 1. */
  n: number;
}

export interface OrgPipelineResult {
  orgKey: string;
  mappings: { saved: number; unchanged: number };
  batches: { pushed: number; duplicate: number; rows: number };
  documents: { uploaded: number; duplicate: number };
  /** The batch IDs sent, in order. */
  batchIds: string[];
  /** The imports the API answered with (one per new batch, or the earlier one for a repeat). */
  importIds: string[];
  /** The documents the API answered with, in upload order. */
  documentIds: string[];
}

export interface FullPipelineResult {
  orgs: OrgPipelineResult[];
  totals: {
    orgs: number;
    mappingsSaved: number;
    mappingsUnchanged: number;
    batchesPushed: number;
    batchesDuplicate: number;
    rows: number;
    documentsUploaded: number;
    documentsDuplicate: number;
  };
}

/** A part of a batch ID: the push API's characters only (sources are told apart by the API). */
function idPart(text: string): string {
  return text.replace(BATCH_ID_CHARS, '_');
}

/** The batch ID of a source's n-th batch: `<generatorVersion>:<seed>:<orgKey>:<source>:<n>`. */
export function batchIdOf(
  key: Pick<AnswerKey, 'generatorVersion' | 'seed'>,
  orgKey: string,
  source: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('a batch number is a whole number from 1');
  const id = [key.generatorVersion, String(key.seed), orgKey, source, String(n)].map(idPart).join(':');
  if (id.length > MAX_BATCH_ID_LENGTH) throw new RangeError(`a batch ID is longer than ${MAX_BATCH_ID_LENGTH}`);
  return id;
}

/** The saved mapping a source's asset lists are pushed with. */
export function mappingOf(source: string): ImportMapping {
  const found = CMDB_SOURCES.find((s) => s.source === source);
  if (!found) throw new Error(`no column mapping is known for the asset list source ${source}`);
  return found.mapping;
}

/** The sources an org's asset lists come from, first seen first. */
export function assetSourcesOf(org: OrgSources): string[] {
  return [...new Set(org.assetLists.map((f) => f.source))];
}

const encoder = new TextEncoder();
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/** Splits rows into runs of at most `MAX_BATCH_ROWS` rows whose push body stays under `MAX_BATCH_BYTES`. */
function chunkRows(rows: readonly AssetRow[], wrapperBytes: number): AssetRow[][] {
  const chunks: AssetRow[][] = [];
  let current: AssetRow[] = [];
  let size = wrapperBytes;
  for (const [i, row] of rows.entries()) {
    const rowBytes = bytesOf(row) + 1; // and its comma
    if (wrapperBytes + rowBytes > MAX_BATCH_BYTES) {
      throw new RangeError(`asset row ${i + 1} alone is over the push API's body limit`);
    }
    if (current.length === MAX_BATCH_ROWS || size + rowBytes > MAX_BATCH_BYTES) {
      chunks.push(current);
      current = [];
      size = wrapperBytes;
    }
    current.push(row);
    size += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * An org's push batches, in the order they are sent: source by source (first seen first), each
 * source's files in order, cut into batches numbered from 1 per source.
 */
export function planPushBatches(key: Pick<AnswerKey, 'generatorVersion' | 'seed'>, org: OrgSources): PlannedBatch[] {
  const batches: PlannedBatch[] = [];
  for (const source of assetSourcesOf(org)) {
    const files = org.assetLists.filter((f) => f.source === source);
    const rows = files.flatMap((f: SourceFile) => assetRows(f.format, f.body));
    // The wrapper with the longest batch ID this source can have, so every body is measured high.
    const wrapperBytes = bytesOf({ batchId: 'x'.repeat(MAX_BATCH_ID_LENGTH), source, rows: [] });
    chunkRows(rows, wrapperBytes).forEach((chunk, i) => {
      const n = i + 1;
      batches.push({ n, batchId: batchIdOf(key, org.orgKey, source, n), source, rows: chunk });
    });
  }
  return batches;
}

async function runOrg(
  client: ConnectorClient,
  key: Pick<AnswerKey, 'generatorVersion' | 'seed'>,
  org: OrgSources,
): Promise<OrgPipelineResult> {
  const result: OrgPipelineResult = {
    orgKey: org.orgKey,
    mappings: { saved: 0, unchanged: 0 },
    batches: { pushed: 0, duplicate: 0, rows: 0 },
    documents: { uploaded: 0, duplicate: 0 },
    batchIds: [],
    importIds: [],
    documentIds: [],
  };
  const batches = planPushBatches(key, org);

  for (const source of assetSourcesOf(org)) {
    const saved = await client.saveMapping(mappingOf(source));
    if (saved.changed) result.mappings.saved += 1;
    else result.mappings.unchanged += 1;
  }

  for (const batch of batches) {
    const answer = await client.pushBatch({ batchId: batch.batchId, source: batch.source, rows: batch.rows });
    result.batchIds.push(batch.batchId);
    if (answer.importId !== null) result.importIds.push(answer.importId);
    if (answer.duplicate) result.batches.duplicate += 1;
    else result.batches.pushed += 1;
    result.batches.rows += batch.rows.length;
  }

  for (const doc of org.documents) {
    const answer = await client.uploadDocument({
      kind: doc.kind,
      fileName: doc.fileName,
      format: doc.format,
      body: doc.body,
      ...(doc.kind === 'asset_list' ? { source: doc.source } : {}),
    });
    result.documentIds.push(answer.documentId);
    if (answer.duplicate) result.documents.duplicate += 1;
    else result.documents.uploaded += 1;
  }
  return result;
}

/**
 * Pushes each target org's sources through the API (see the top of the file). Every target names
 * an org of `sources` (once); orgs without a target are left out. Stops at the first refusal, with
 * the client's error.
 */
export async function runFullPipeline(input: RunFullPipelineInput): Promise<FullPipelineResult> {
  const { key, sources, targets } = input;
  const byKey = new Map(sources.orgs.map((org) => [org.orgKey, org]));
  const seen = new Set<string>();
  for (const target of targets) {
    if (!byKey.has(target.orgKey)) throw new Error(`target org ${target.orgKey} has no sources`);
    if (seen.has(target.orgKey)) throw new Error(`target org ${target.orgKey} is given twice`);
    seen.add(target.orgKey);
  }
  const makeClient =
    input.client ??
    ((t: FullPipelineTarget) =>
      new ApiClient({ baseUrl: t.baseUrl, apiKey: t.apiKey, ...(input.fetch ? { fetch: input.fetch } : {}) }));

  const orgs: OrgPipelineResult[] = [];
  for (const target of targets) {
    const done = await runOrg(makeClient(target), key, byKey.get(target.orgKey)!);
    orgs.push(done);
    input.onOrgDone?.(done);
  }

  const sum = (pick: (o: OrgPipelineResult) => number) => orgs.reduce((n, o) => n + pick(o), 0);
  return {
    orgs,
    totals: {
      orgs: orgs.length,
      mappingsSaved: sum((o) => o.mappings.saved),
      mappingsUnchanged: sum((o) => o.mappings.unchanged),
      batchesPushed: sum((o) => o.batches.pushed),
      batchesDuplicate: sum((o) => o.batches.duplicate),
      rows: sum((o) => o.batches.rows),
      documentsUploaded: sum((o) => o.documents.uploaded),
      documentsDuplicate: sum((o) => o.documents.duplicate),
    },
  };
}
