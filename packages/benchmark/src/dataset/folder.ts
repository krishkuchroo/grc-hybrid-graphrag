// A dataset folder in `gen:data`'s answer-key format, read and checked whole before anything is
// made (FT-001; D45.7, D163, D164, D234, D235, D238 (b)). `docs/datasets/company-x/` is the first
// such folder, but nothing here names it: any folder in the format loads (D238 (b)). Both
// `pnpm dataset:load` and `pnpm dataset:score` read their folder through `readDatasetFolder`.
//
// The files (README of `docs/datasets/company-x/`):
//   manifest.json            `org: { name, slug }` (the slug leaves room for `-fast`)
//   answer-key.json          `parseAnswerKey`'s format, with exactly one org
//   documents.json           `[{ file, kind, label }]`, the files under `sources/documents/`
//   import-mappings.json     `[{ source, file, fields }]`, the files under `sources/asset-lists/`;
//                            `{ source, fields }` checked with `importMappingSchema`
//   framework-mappings.json  `[{ controlKey, requirement: { framework, code } }]`
//   facts.json               `[{ type, fromKey, toKey, origin, statedIn: [{ file, sentence }] }]`
//   duplicates.json          `{ scannerRows: [{ file, sourceId, sameAs }] }`
//   normalisation.json       `[{ file, sourceId, field, expected }]`
//   provenance.json          `{ links: [{ type, fromKey, toKey, origin }] }`
// Other fields are left alone (`about`, `origin`, `alsoReachedThroughNistCrosswalks`,
// `kevNamingVariants`, provenance's `records` …).
//
// Refused, each problem naming the file and the field, never a value: a file that is missing, too
// big, not JSON or not valid; an answer key without exactly one org; a document or asset list
// `file` that isn't a plain file name under `sources/` (or is missing, empty, too big, or not what
// its extension says); an asset list whose mapped columns its header lacks; a document kind that
// doesn't take its file's format; a framework mapping whose control key isn't a control of the
// answer key; facts, duplicates and normalisation rows naming keys or asset lists the folder
// doesn't have. A document labelled anything but `internal` is refused by its file name: both load
// paths store documents at `internal` only.
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  DATASET_DOCUMENT_KINDS,
  csvRows,
  formatOfFileName,
  isByteFormat,
  parseCsvRecords,
  type AnswerKey,
  type DatasetAssetList,
  type DatasetDocument,
  type DatasetFrameworkMapping,
  type WorldOrg,
} from '@grc/generators';
import {
  FRAMEWORK_KEYS,
  KIND_FORMATS,
  LABELS,
  LINK_TYPES,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  answerKeyKeySchema,
  benchmarkOrgSlugSchema,
  createSchemas,
  importMappingSchema,
  type Label,
  type LinkType,
  type RecordKind,
} from '@grc/shared';
import { z } from 'zod';
import { AnswerKeyError, fieldOf, parseAnswerKey } from '../questions/answer-key.js';

/** The folder's JSON files. */
export const DATASET_FILES = Object.freeze({
  manifest: 'manifest.json',
  answerKey: 'answer-key.json',
  documents: 'documents.json',
  importMappings: 'import-mappings.json',
  frameworkMappings: 'framework-mappings.json',
  facts: 'facts.json',
  duplicates: 'duplicates.json',
  normalisation: 'normalisation.json',
  provenance: 'provenance.json',
} as const);

/** Where the asset lists and the documents sit, under the folder. */
export const DATASET_SOURCES_DIR = 'sources';
export const DATASET_ASSET_LISTS_DIR = 'asset-lists';
export const DATASET_DOCUMENTS_DIR = 'documents';

/** A JSON file over this size is refused unread. */
export const MAX_DATASET_JSON_BYTES = 64 * 1024 * 1024;

/** The fast-load org's slug ends in this (`company-x-fast`). */
export const FAST_ORG_SUFFIX = '-fast';
/** The longest manifest slug: its fast-load slug must still be a benchmark org slug (100). */
export const MAX_DATASET_SLUG_LENGTH = 100 - FAST_ORG_SUFFIX.length;

/** Where a link of the answer key came from (D234). */
export const DATASET_LINK_ORIGINS = ['public', 'derived', 'synthetic'] as const;
export type DatasetLinkOrigin = (typeof DATASET_LINK_ORIGINS)[number];

/** The asset fields `normalisation.json` may name: the name and the asset's own create fields. */
export const NORMALISED_FIELDS = Object.freeze([
  'name',
  ...Object.keys(createSchemas.asset.shape).filter((f) => !['name', 'owner', 'label'].includes(f)),
]) as readonly string[];

/** The fast-load org's slug for a manifest slug. */
export function fastOrgSlugOf(slug: string): string {
  return `${slug}${FAST_ORG_SUFFIX}`;
}

/** One problem: the file, the field (`3.file`, or `(the whole file)`) and what is wrong. */
export interface DatasetFolderProblem {
  file: string;
  field: string;
  message: string;
}

/** The folder can't be used; `problems` names each file and field that's wrong. */
export class DatasetFolderError extends Error {
  constructor(readonly problems: readonly DatasetFolderProblem[]) {
    const first = problems[0];
    super(first ? `${first.file}: ${first.field}: ${first.message}` : 'the dataset folder is not valid');
    this.name = 'DatasetFolderError';
  }
}

/** A problem as one line: `<file>: <field>: <message>`. */
export function datasetProblemLine(problem: DatasetFolderProblem): string {
  return `${problem.file}: ${problem.field}: ${problem.message}`;
}

export interface DatasetFact {
  type: LinkType;
  fromKey: string;
  toKey: string;
  origin: DatasetLinkOrigin;
  statedIn: { file: string; sentence: string }[];
}

export interface DatasetScannerRow {
  /** The asset list it is a row of (an `import-mappings.json` file). */
  file: string;
  sourceId: string;
  /** The answer-key asset it is. */
  sameAs: string;
}

export interface DatasetNormalisationRow {
  file: string;
  sourceId: string;
  field: string;
  expected: string;
}

export interface DatasetProvenanceLink {
  type: LinkType;
  fromKey: string;
  toKey: string;
  origin: DatasetLinkOrigin;
}

/** A document of `documents.json` with its content and its label (always `internal`). */
export interface DatasetFolderDocument extends DatasetDocument {
  label: Label;
}

export interface DatasetFolder {
  /** The folder's absolute path. */
  dir: string;
  org: { name: string; slug: string };
  key: AnswerKey;
  /** The answer key's one org. */
  answerOrg: WorldOrg;
  /** `import-mappings.json`'s rows, in order, each with its asset list's text. */
  assetLists: DatasetAssetList[];
  /** `documents.json`'s rows, in order, each with its content. */
  documents: DatasetFolderDocument[];
  frameworkMappings: DatasetFrameworkMapping[];
  facts: DatasetFact[];
  duplicates: DatasetScannerRow[];
  normalisation: DatasetNormalisationRow[];
  provenanceLinks: DatasetProvenanceLink[];
}

// ---- The files' shapes -----------------------------------------------------------------------

/** A plain file name: no folder part, not `.` or `..`, no control character. */
const plainFileName = z
  .string()
  .min(1)
  .max(MAX_FILE_NAME_LENGTH)
  .refine(
    // eslint-disable-next-line no-control-regex
    (s) => !/[/\\\u0000-\u001f\u007f]/.test(s) && s !== '.' && s !== '..' && s === s.trim(),
    'must be a plain file name under sources/ (no folder part)',
  );

const recordKey = answerKeyKeySchema;
const LINK_TYPE_NAMES = LINK_TYPES.map((row) => row.type) as [LinkType, ...LinkType[]];

const manifestSchema = z.object({
  org: z.object({
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => s === s.trim(), 'must have no spaces around it'),
    slug: benchmarkOrgSlugSchema.max(MAX_DATASET_SLUG_LENGTH),
  }),
});

// Each list file is an array checked row by row, so one bad row doesn't hide the others' problems.
const documentRowSchema = z.object({
  file: plainFileName,
  kind: z.enum(DATASET_DOCUMENT_KINDS),
  label: z.enum(LABELS),
});

const importMappingRowSchema = z.object({ source: z.unknown(), file: plainFileName, fields: z.unknown() });

const frameworkMappingRowSchema = z.object({
  controlKey: recordKey,
  requirement: z.object({ framework: z.enum(FRAMEWORK_KEYS), code: z.string().trim().min(1).max(100) }),
});

const factRowSchema = z.object({
  type: z.enum(LINK_TYPE_NAMES),
  fromKey: recordKey,
  toKey: recordKey,
  origin: z.enum(DATASET_LINK_ORIGINS),
  statedIn: z.array(z.object({ file: z.string(), sentence: z.string() })),
});

const scannerRowSchema = z.object({ file: plainFileName, sourceId: z.string().trim().min(1), sameAs: recordKey });

const normalisationRowSchema = z.object({
  file: plainFileName,
  sourceId: z.string().trim().min(1),
  field: z.enum(NORMALISED_FIELDS as [string, ...string[]]),
  expected: z.string(),
});

const provenanceLinkSchema = z.object({
  type: z.enum(LINK_TYPE_NAMES),
  fromKey: recordKey,
  toKey: recordKey,
  origin: z.enum(DATASET_LINK_ORIGINS),
});

// ---- Reading ---------------------------------------------------------------------------------

const WHOLE_FILE = '(the whole file)';

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
}

/** Reads and parses one JSON file of the folder; null (with a problem) when it can't be. */
async function readJson(dir: string, file: string, problems: DatasetFolderProblem[]): Promise<unknown> {
  const path = join(dir, file);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      problems.push({ file, field: WHOLE_FILE, message: 'is missing (not a file)' });
      return null;
    }
    if (info.size > MAX_DATASET_JSON_BYTES) {
      problems.push({ file, field: WHOLE_FILE, message: `is over ${MAX_DATASET_JSON_BYTES} bytes` });
      return null;
    }
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = errorCode(err);
    problems.push({ file, field: WHOLE_FILE, message: code === 'ENOENT' ? 'is missing' : `can't be read (${code})` });
    return null;
  }
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) as unknown;
  } catch {
    // Never JSON's own message: it quotes the text around the mistake.
    problems.push({ file, field: WHOLE_FILE, message: 'is not valid JSON' });
    return null;
  }
}

/** The value checked against a schema; null (with its problems) when it doesn't fit. */
function parsed<T>(file: string, schema: z.ZodType<T>, value: unknown, problems: DatasetFolderProblem[]): T | null {
  if (value === null) return null;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) problems.push({ file, field: fieldOf(issue.path), message: issue.message });
  return null;
}

/**
 * An array checked row by row: the rows that fit, each with its place, or null (with a problem) when
 * the value isn't an array. `at` is the array's own path in the file (`scannerRows`), if any.
 */
function parsedRows<T>(
  file: string,
  schema: z.ZodType<T>,
  value: unknown,
  problems: DatasetFolderProblem[],
  at: readonly PropertyKey[] = [],
): { i: number; row: T }[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    problems.push({ file, field: at.length === 0 ? WHOLE_FILE : fieldOf(at), message: 'must be a list' });
    return null;
  }
  const rows: { i: number; row: T }[] = [];
  value.forEach((item: unknown, i) => {
    const result = schema.safeParse(item);
    if (result.success) rows.push({ i, row: result.data });
    else {
      for (const issue of result.error.issues) {
        problems.push({ file, field: fieldOf([...at, i, ...issue.path]), message: issue.message });
      }
    }
  });
  return rows;
}

/** `a` or `an` before a word. */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (a DOCX is a zip)

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

type SourceContent = { text: string } | { bytes: Uint8Array };

/**
 * Reads a file under `sources/<sub>/`: it must stay inside `sources/` (no link out of it), be a
 * file of 1 byte to the upload limit, and be what its format says (UTF-8 text with no NUL, valid
 * JSON for `.json`, a PDF's or a zip's first bytes). Null (with a problem) when it isn't.
 */
async function readSource(
  dir: string,
  sub: string,
  fileName: string,
  format: ReturnType<typeof formatOfFileName>,
  where: { file: string; field: string },
  problems: DatasetFolderProblem[],
): Promise<SourceContent | null> {
  const problem = (message: string): null => {
    problems.push({ ...where, message });
    return null;
  };
  if (format === null) return problem('must end in .pdf, .docx, .csv, .json or .txt');
  const sourcesDir = join(dir, DATASET_SOURCES_DIR);
  const path = join(sourcesDir, sub, fileName);
  let bytes: Uint8Array;
  try {
    const [realSources, realFile] = await Promise.all([realpath(sourcesDir), realpath(path)]);
    const inside = relative(realSources, realFile);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return problem('is not under sources/');
    const info = await stat(realFile);
    if (!info.isFile()) return problem(`is not a file under ${DATASET_SOURCES_DIR}/${sub}/`);
    if (info.size === 0) return problem('names an empty file');
    if (info.size > MAX_UPLOAD_BYTES) return problem(`names a file over the ${MAX_UPLOAD_BYTES}-byte upload limit`);
    bytes = new Uint8Array(await readFile(realFile));
  } catch (err) {
    const code = errorCode(err);
    return problem(
      code === 'ENOENT' ? `names a file missing from ${DATASET_SOURCES_DIR}/${sub}/` : `can't be read (${code})`,
    );
  }
  if (isByteFormat(format)) {
    if (format === 'pdf' && !startsWith(bytes, PDF_MAGIC)) return problem('names a .pdf file that is not a PDF');
    if (format === 'docx' && !startsWith(bytes, ZIP_MAGIC)) return problem('names a .docx file that is not a DOCX');
    return { bytes };
  }
  let text: string;
  try {
    // The BOM, when there is one, is kept, so the text gives back the file's own bytes.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return problem('names a file that is not UTF-8 text');
  }
  if (text.includes('\u0000')) return problem('names a file holding a NUL character');
  if (format === 'json') {
    try {
      JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
    } catch {
      return problem('names a .json file that is not valid JSON');
    }
  }
  return { text };
}

/** Reads the dataset folder and checks it whole (see the top of the file). */
export async function readDatasetFolder(folder: string): Promise<DatasetFolder> {
  const dir = resolve(folder);
  const problems: DatasetFolderProblem[] = [];
  try {
    if (!(await stat(dir)).isDirectory())
      throw new DatasetFolderError([{ file: '.', field: WHOLE_FILE, message: 'is not a folder' }]);
  } catch (err) {
    if (err instanceof DatasetFolderError) throw err;
    throw new DatasetFolderError([{ file: '.', field: WHOLE_FILE, message: 'the folder is missing' }]);
  }

  const F = DATASET_FILES;
  const manifest = parsed(F.manifest, manifestSchema, await readJson(dir, F.manifest, problems), problems);

  let key: AnswerKey | null = null;
  const keyValue = await readJson(dir, F.answerKey, problems);
  if (keyValue !== null) {
    try {
      key = parseAnswerKey(keyValue);
    } catch (err) {
      if (!(err instanceof AnswerKeyError)) throw err;
      for (const p of err.problems) problems.push({ file: F.answerKey, field: p.field, message: p.message });
    }
  }
  if (key !== null && key.orgs.length !== 1) {
    problems.push({ file: F.answerKey, field: 'orgs', message: 'must hold exactly one org' });
    key = null;
  }
  const answerOrg = key?.orgs[0] ?? null;

  const documents = parsedRows(F.documents, documentRowSchema, await readJson(dir, F.documents, problems), problems);
  const rawMappings = parsedRows(
    F.importMappings,
    importMappingRowSchema,
    await readJson(dir, F.importMappings, problems),
    problems,
  );
  const frameworkMappings = parsedRows(
    F.frameworkMappings,
    frameworkMappingRowSchema,
    await readJson(dir, F.frameworkMappings, problems),
    problems,
  );
  const facts = parsedRows(F.facts, factRowSchema, await readJson(dir, F.facts, problems), problems);
  const duplicatesFile = parsed(
    F.duplicates,
    z.object({ scannerRows: z.unknown() }),
    await readJson(dir, F.duplicates, problems),
    problems,
  );
  const duplicates =
    duplicatesFile === null
      ? null
      : parsedRows(F.duplicates, scannerRowSchema, duplicatesFile.scannerRows ?? null, problems, ['scannerRows']);
  if (duplicatesFile !== null && duplicatesFile.scannerRows === undefined) {
    problems.push({ file: F.duplicates, field: 'scannerRows', message: 'is missing' });
  }
  const normalisation = parsedRows(
    F.normalisation,
    normalisationRowSchema,
    await readJson(dir, F.normalisation, problems),
    problems,
  );
  const provenanceFile = parsed(
    F.provenance,
    z.object({ links: z.unknown() }),
    await readJson(dir, F.provenance, problems),
    problems,
  );
  const provenance =
    provenanceFile === null
      ? null
      : parsedRows(F.provenance, provenanceLinkSchema, provenanceFile.links ?? null, problems, ['links']);
  if (provenanceFile !== null && provenanceFile.links === undefined) {
    problems.push({ file: F.provenance, field: 'links', message: 'is missing' });
  }

  // The import mappings: each `{ source, fields }` as the app saves it, each source and file once.
  const mappings: { source: string; file: string; fields: DatasetAssetList['fields'] }[] = [];
  if (rawMappings !== null) {
    const sources = new Set<string>();
    const files = new Set<string>();
    rawMappings.forEach(({ i, row }) => {
      const checked = importMappingSchema.safeParse({ source: row.source, fields: row.fields });
      if (!checked.success) {
        for (const issue of checked.error.issues) {
          problems.push({ file: F.importMappings, field: fieldOf([i, ...issue.path]), message: issue.message });
        }
        return;
      }
      if (formatOfFileName(row.file) !== 'csv') {
        problems.push({ file: F.importMappings, field: `${i}.file`, message: 'must name a .csv asset list' });
        return;
      }
      if (sources.has(checked.data.source)) {
        problems.push({ file: F.importMappings, field: `${i}.source`, message: 'each source only once' });
        return;
      }
      if (files.has(row.file)) {
        problems.push({ file: F.importMappings, field: `${i}.file`, message: 'each file only once' });
        return;
      }
      sources.add(checked.data.source);
      files.add(row.file);
      mappings.push({ source: checked.data.source, file: row.file, fields: checked.data.fields });
    });
  }
  const assetListFiles = new Set(mappings.map((m) => m.file));

  // The keys of the answer key and their kinds.
  const kindOf = new Map<string, RecordKind>();
  if (answerOrg !== null) {
    for (const r of answerOrg.assets) kindOf.set(r.key, 'asset');
    for (const r of answerOrg.risks) kindOf.set(r.key, 'risk');
    for (const r of answerOrg.controls) kindOf.set(r.key, 'control');
    for (const r of answerOrg.policies) kindOf.set(r.key, 'policy');
    for (const r of answerOrg.incidents) kindOf.set(r.key, 'incident');
  }
  const knowsKeys = answerOrg !== null;

  // Documents: each file once, a format its kind takes, and the `internal` label.
  if (documents !== null) {
    const files = new Set<string>();
    documents.forEach(({ i, row: doc }) => {
      if (files.has(doc.file)) problems.push({ file: F.documents, field: `${i}.file`, message: 'each file only once' });
      files.add(doc.file);
      const format = formatOfFileName(doc.file);
      if (format !== null && !KIND_FORMATS[doc.kind].includes(format)) {
        problems.push({ file: F.documents, field: `${i}.file`, message: `a ${doc.kind} can't be a .${format} file` });
      }
      if (doc.label !== 'internal') {
        // Named by its file, as the rule says: both load paths store documents at `internal` only.
        problems.push({
          file: F.documents,
          field: doc.file,
          message: 'label must be internal (both load paths store documents at internal only)',
        });
      }
    });
  }

  if (frameworkMappings !== null && knowsKeys) {
    frameworkMappings.forEach(({ i, row }) => {
      if (kindOf.get(row.controlKey) !== 'control') {
        problems.push({
          file: F.frameworkMappings,
          field: `${i}.controlKey`,
          message: 'is not a control of the answer key',
        });
      }
    });
  }

  if (facts !== null && knowsKeys) {
    const seen = new Set<string>();
    facts.forEach(({ i, row: fact }) => {
      const row = LINK_TYPES.find((t) => t.type === fact.type)!;
      if (kindOf.get(fact.fromKey) !== row.from) {
        problems.push({
          file: F.facts,
          field: `${i}.fromKey`,
          message: `must be ${article(row.from)} of the answer key`,
        });
      }
      if (kindOf.get(fact.toKey) !== row.to) {
        problems.push({ file: F.facts, field: `${i}.toKey`, message: `must be ${article(row.to)} of the answer key` });
      }
      const identity = `${fact.type}|${fact.fromKey}|${fact.toKey}`;
      if (seen.has(identity)) problems.push({ file: F.facts, field: String(i), message: 'repeats an earlier link' });
      seen.add(identity);
    });
  }

  if (duplicates !== null) {
    duplicates.forEach(({ i, row }) => {
      if (rawMappings !== null && !assetListFiles.has(row.file)) {
        problems.push({
          file: F.duplicates,
          field: `scannerRows.${i}.file`,
          message: `is not an asset list of ${F.importMappings}`,
        });
      }
      if (knowsKeys && kindOf.get(row.sameAs) !== 'asset') {
        problems.push({
          file: F.duplicates,
          field: `scannerRows.${i}.sameAs`,
          message: 'is not an asset of the answer key',
        });
      }
    });
  }

  if (normalisation !== null && rawMappings !== null) {
    normalisation.forEach(({ i, row }) => {
      if (!assetListFiles.has(row.file)) {
        problems.push({
          file: F.normalisation,
          field: `${i}.file`,
          message: `is not an asset list of ${F.importMappings}`,
        });
      }
    });
  }

  // The sources: every asset list and document, read and checked.
  const assetLists: DatasetAssetList[] = [];
  for (const [i, m] of mappings.entries()) {
    const where = { file: F.importMappings, field: `${i}.file` };
    const content = await readSource(dir, DATASET_ASSET_LISTS_DIR, m.file, 'csv', where, problems);
    if (content === null || !('text' in content)) continue;
    let header: string[];
    try {
      csvRows(content.text);
      header = parseCsvRecords(content.text)[0] ?? [];
    } catch {
      problems.push({ ...where, message: 'names an asset list that is not valid CSV' });
      continue;
    }
    for (const [field, column] of Object.entries(m.fields)) {
      if (column !== undefined && !header.includes(column)) {
        problems.push({
          file: F.importMappings,
          field: `${i}.fields.${field}`,
          message: "names a column the asset list's header doesn't have",
        });
      }
    }
    assetLists.push({ source: m.source, file: m.file, fields: m.fields, text: content.text });
  }

  const folderDocuments: DatasetFolderDocument[] = [];
  if (documents !== null) {
    for (const { i, row: doc } of documents) {
      const where = { file: F.documents, field: `${i}.file` };
      const format = formatOfFileName(doc.file);
      const content = await readSource(dir, DATASET_DOCUMENTS_DIR, doc.file, format, where, problems);
      if (content === null) continue;
      folderDocuments.push({ file: doc.file, kind: doc.kind, label: doc.label, ...content });
    }
  }

  if (problems.length > 0 || manifest === null || key === null || answerOrg === null) {
    throw new DatasetFolderError(problems);
  }
  return {
    dir,
    org: { name: manifest.org.name, slug: manifest.org.slug },
    key,
    answerOrg,
    assetLists,
    documents: folderDocuments,
    frameworkMappings: (frameworkMappings ?? []).map(({ row }) => ({
      controlKey: row.controlKey,
      framework: row.requirement.framework,
      code: row.requirement.code,
    })),
    facts: (facts ?? []).map(({ row }) => row),
    duplicates: (duplicates ?? []).map(({ row }) => row),
    normalisation: (normalisation ?? []).map(({ row }) => row),
    provenanceLinks: (provenance ?? []).map(({ row }) => row),
  };
}
