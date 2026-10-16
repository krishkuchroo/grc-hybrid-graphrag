// Fast-load mode's batch plan (D42, D45.8, D213 (7)): the answer key's records, links and documents
// cut into the batches `pnpm gen:data --mode fast` writes, each batch in one transaction with one
// `generator.loaded` audit entry (packages/infra/scripts/fast-load.ts does the writes).
//
// - Graph batches: every org's records in kind order (assets, risks, controls, policies,
//   incidents), each kind in the answer key's order, cut into runs of at most `batchSize` (500 by
//   default). So, on a fresh org, each kind's numbers run on unbroken from the first (AST0001001 for
//   AST-0001, …). A link goes into the batch that writes the later of its two ends, so both ends
//   exist when it is drawn, and every link is in exactly one batch.
// - Document batches: the org's documents (policies, SOC tickets, audit reports), in file order, cut
//   into runs of at most `batchSize`, each with the bytes an upload would carry (PDF and DOCX as
//   written, the others as UTF-8 text) and its format. Files are identified by their content
//   (D45.5): a file whose content an earlier file of the same org already has is left out and
//   counted as a repeat.
// - Everything is checked before anything is written: record keys unique in their org, labels and
//   field values plain, every link's ends known and its type allowed between their kinds
//   (`isAllowedLink`), every document's kind, format, name and size as an upload's would be.
//
// Pure: the same answer key, sources and batch size always give the same plan, and nothing here
// touches the network, the filesystem or the environment. Errors name keys, kinds and counts only,
// never a name or text from the data (D164).
import { createHash } from 'node:crypto';
import {
  DOCUMENT_RECORD_TYPE,
  FORMAT_CONTENT_TYPES,
  KIND_FORMATS,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  NODE_LABELS,
  RECORD_KINDS,
  defaultLabel,
  isAllowedLink,
  isDocumentKind,
  isLabel,
  sourceNameSchema,
  type DocumentKind,
  type FileFormat,
  type Label,
  type LinkType,
  type NodeLabel,
  type RecordKind,
  type RecordType,
} from '@grc/shared';
import { fileBytesOf, type RenderedSources, type SourceFile } from '../sources/index.js';
import type { AnswerKey, WorldOrg, WorldRecord } from '../world/index.js';

/** At most this many records (with their links) per graph batch, and documents per document batch. */
export const MAX_FAST_LOAD_BATCH = 500;

/** The source fast-loaded records name in their `sourceIds`: `answer-key:<key>`. */
export const ANSWER_KEY_SOURCE = 'answer-key';

/** A fast-loaded record's source ID: its answer-key key under `ANSWER_KEY_SOURCE`. */
export function fastLoadSourceId(key: string): string {
  return `${ANSWER_KEY_SOURCE}:${key}`;
}

/** A thrown plan problem: a code and where (an org key, a record key, a link's or file's place). */
export class FastLoadPlanError extends Error {
  constructor(
    readonly code:
      | 'bad_batch_size'
      | 'org_without_sources'
      | 'sources_without_org'
      | 'duplicate_org'
      | 'duplicate_key'
      | 'bad_label'
      | 'bad_field'
      | 'unknown_link_end'
      | 'link_not_allowed'
      | 'bad_document',
    readonly where: string,
  ) {
    super(`fast load plan: ${code} (${where})`);
    this.name = 'FastLoadPlanError';
  }
}

/** One record to write: its kind and graph label, its key and source ID, its label and its fields. */
export interface FastLoadRecord {
  kind: RecordKind;
  nodeLabel: NodeLabel;
  key: string;
  sourceId: string;
  label: Label;
  /** `name` and the kind's own fields, as S1's create schema has them (never `label` or `owner`). */
  fields: Record<string, string | number>;
}

/** One link to draw, between two records of the same org, named by their keys. */
export interface FastLoadLink {
  type: LinkType;
  fromKey: string;
  fromKind: RecordKind;
  toKey: string;
  toKind: RecordKind;
}

export interface GraphBatch {
  /** The batch's number in its org, from 1. */
  n: number;
  records: FastLoadRecord[];
  links: FastLoadLink[];
}

/** One document to store, as an upload of its kind would be stored. */
export interface FastLoadDocument {
  kind: DocumentKind;
  recordType: RecordType;
  fileName: string;
  format: FileFormat;
  contentType: string;
  /** The file's bytes, stored as they are: PDF and DOCX as written, the others as UTF-8 text. */
  bytes: Uint8Array;
  sizeBytes: number;
  /** The lowercase hex SHA-256 of the bytes. */
  contentHash: string;
  /** An asset list's source; null for every other kind. */
  source: string | null;
}

export interface DocumentBatch {
  /** The batch's number in its org, from 1. */
  n: number;
  documents: FastLoadDocument[];
}

export interface OrgFastLoadPlan {
  orgKey: string;
  graphBatches: GraphBatch[];
  documentBatches: DocumentBatch[];
  counts: {
    records: number;
    links: number;
    documents: number;
    /** Files left out because an earlier file of the org has the same content. */
    repeatedDocuments: number;
    /** Links the answer key gives twice (drawn once). */
    repeatedLinks: number;
  };
}

export interface FastLoadPlan {
  generatorVersion: string;
  seed: number;
  batchSize: number;
  orgs: OrgFastLoadPlan[];
}

export interface PlanFastLoadOptions {
  /** Records or documents per batch, from 1 to `MAX_FAST_LOAD_BATCH` (the default). */
  batchSize?: number;
}

/** The answer-key org's records of each kind, in kind order. */
function recordsOf(org: WorldOrg): Array<{ kind: RecordKind; record: WorldRecord }> {
  const byKind: Record<RecordKind, readonly WorldRecord[]> = {
    asset: org.assets,
    risk: org.risks,
    control: org.controls,
    policy: org.policies,
    incident: org.incidents,
  };
  return RECORD_KINDS.flatMap((kind) => (byKind[kind] ?? []).map((record) => ({ kind, record })));
}

const NOT_FIELDS = new Set(['key', 'label', 'owner']);

function toRecord(orgKey: string, kind: RecordKind, record: WorldRecord): FastLoadRecord {
  const where = `${orgKey} ${record.key}`;
  const given = record as unknown as Record<string, unknown>;
  const fields: Record<string, string | number> = {};
  for (const [field, value] of Object.entries(given)) {
    if (NOT_FIELDS.has(field) || value === undefined) continue;
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) fields[field] = value;
    else throw new FastLoadPlanError('bad_field', `${where} ${field}`);
  }
  if (typeof fields['name'] !== 'string' || fields['name'].trim() === '') {
    throw new FastLoadPlanError('bad_field', `${where} name`);
  }
  const label =
    given['label'] === undefined ? defaultLabel(kind, given as { dataClassification?: Label }) : given['label'];
  if (!isLabel(label)) throw new FastLoadPlanError('bad_label', where);
  return { kind, nodeLabel: NODE_LABELS[kind], key: record.key, sourceId: fastLoadSourceId(record.key), label, fields };
}

/** A stored file name as an upload's: the last path segment, no control characters, trimmed. */
function fileNameOf(fileName: string): string | null {
  const base = (fileName.split(/[/\\]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (base === '' || base === '.' || base === '..' || [...base].length > MAX_FILE_NAME_LENGTH) return null;
  return base;
}

function toDocument(orgKey: string, index: number, file: SourceFile): FastLoadDocument {
  const where = `${orgKey} document ${index + 1}`;
  const kind: unknown = file.kind;
  if (!isDocumentKind(kind)) throw new FastLoadPlanError('bad_document', `${where} kind`);
  if (!(KIND_FORMATS[kind] as readonly string[]).includes(file.format)) {
    throw new FastLoadPlanError('bad_document', `${where} format`);
  }
  const fileName = typeof file.fileName === 'string' ? fileNameOf(file.fileName) : null;
  if (fileName === null) throw new FastLoadPlanError('bad_document', `${where} file name`);
  if (typeof file.body !== 'string') throw new FastLoadPlanError('bad_document', `${where} body`);
  if (file.bytes !== undefined && !(file.bytes instanceof Uint8Array)) {
    throw new FastLoadPlanError('bad_document', `${where} body`);
  }
  // A copy, so the plan's bytes are its own.
  let bytes: Uint8Array;
  try {
    bytes = fileBytesOf(file);
  } catch {
    throw new FastLoadPlanError('bad_document', `${where} body`);
  }
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES)
    throw new FastLoadPlanError('bad_document', `${where} size`);
  let source: string | null = null;
  if (kind === 'asset_list') {
    const parsed = sourceNameSchema.safeParse(file.source);
    if (!parsed.success) throw new FastLoadPlanError('bad_document', `${where} source`);
    source = parsed.data;
  }
  return {
    kind,
    recordType: DOCUMENT_RECORD_TYPE[kind],
    fileName,
    format: file.format,
    contentType: FORMAT_CONTENT_TYPES[file.format],
    bytes,
    sizeBytes: bytes.length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    source,
  };
}

/** Cuts items into runs of at most `size`, numbered from 1. */
function cut<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += size) runs.push(items.slice(i, i + size));
  return runs;
}

function planOrg(org: WorldOrg, files: readonly SourceFile[], batchSize: number): OrgFastLoadPlan {
  // Records, in kind order, and the batch each one is written in.
  const records = recordsOf(org).map(({ kind, record }) => toRecord(org.key, kind, record));
  const batchOf = new Map<string, number>();
  const kindOf = new Map<string, RecordKind>();
  records.forEach((r, i) => {
    if (batchOf.has(r.key)) throw new FastLoadPlanError('duplicate_key', `${org.key} ${r.key}`);
    batchOf.set(r.key, Math.floor(i / batchSize));
    kindOf.set(r.key, r.kind);
  });
  const graphBatches: GraphBatch[] = cut(records, batchSize).map((run, i) => ({ n: i + 1, records: run, links: [] }));

  // Links, each in the batch of its later end, in the answer key's order; a repeat is drawn once.
  const seen = new Set<string>();
  let repeatedLinks = 0;
  org.links.forEach((link, i) => {
    const fromKind = kindOf.get(link.fromKey);
    const toKind = kindOf.get(link.toKey);
    if (fromKind === undefined || toKind === undefined) {
      throw new FastLoadPlanError('unknown_link_end', `${org.key} link ${i + 1}`);
    }
    if (!isAllowedLink(link.type, fromKind, toKind)) {
      throw new FastLoadPlanError('link_not_allowed', `${org.key} link ${i + 1}`);
    }
    const id = `${link.type}|${link.fromKey}|${link.toKey}`;
    if (seen.has(id)) {
      repeatedLinks += 1;
      return;
    }
    seen.add(id);
    const batch = Math.max(batchOf.get(link.fromKey)!, batchOf.get(link.toKey)!);
    graphBatches[batch]!.links.push({ type: link.type, fromKey: link.fromKey, fromKind, toKey: link.toKey, toKind });
  });

  // Documents, once per content.
  const hashes = new Set<string>();
  const documents: FastLoadDocument[] = [];
  let repeatedDocuments = 0;
  files.forEach((file, i) => {
    const doc = toDocument(org.key, i, file);
    if (hashes.has(doc.contentHash)) {
      repeatedDocuments += 1;
      return;
    }
    hashes.add(doc.contentHash);
    documents.push(doc);
  });
  const documentBatches: DocumentBatch[] = cut(documents, batchSize).map((run, i) => ({ n: i + 1, documents: run }));

  return {
    orgKey: org.key,
    graphBatches,
    documentBatches,
    counts: {
      records: records.length,
      links: seen.size,
      documents: documents.length,
      repeatedDocuments,
      repeatedLinks,
    },
  };
}

/**
 * Plans the fast load of every org of the answer key (see the top of the file). `sources` must
 * have exactly the answer key's orgs (its documents are stored; its asset lists are not, because
 * the assets come straight from the answer key). Throws a `FastLoadPlanError` for anything that
 * would not load, before anything is written.
 */
export function planFastLoad(
  key: AnswerKey,
  sources: Pick<RenderedSources, 'orgs'>,
  opts: PlanFastLoadOptions = {},
): FastLoadPlan {
  const batchSize = opts.batchSize ?? MAX_FAST_LOAD_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_FAST_LOAD_BATCH) {
    throw new FastLoadPlanError('bad_batch_size', `1 to ${MAX_FAST_LOAD_BATCH}`);
  }
  const filesOf = new Map<string, readonly SourceFile[]>();
  for (const org of sources.orgs) {
    if (filesOf.has(org.orgKey)) throw new FastLoadPlanError('duplicate_org', org.orgKey);
    filesOf.set(org.orgKey, org.documents);
  }
  const orgKeys = new Set<string>();
  for (const org of key.orgs) {
    if (orgKeys.has(org.key)) throw new FastLoadPlanError('duplicate_org', org.key);
    orgKeys.add(org.key);
    if (!filesOf.has(org.key)) throw new FastLoadPlanError('org_without_sources', org.key);
  }
  for (const orgKey of filesOf.keys()) {
    if (!orgKeys.has(orgKey)) throw new FastLoadPlanError('sources_without_org', orgKey);
  }
  return {
    generatorVersion: key.generatorVersion,
    seed: key.seed,
    batchSize,
    orgs: key.orgs.map((org) => planOrg(org, filesOf.get(org.key)!, batchSize)),
  };
}
