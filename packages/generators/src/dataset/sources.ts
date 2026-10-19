// A dataset folder's files as the sources the dummy connectors deliver (FT-001; D18, D42, D234,
// D235, D238 (b)): a folder in `gen:data`'s answer-key format (`docs/datasets/company-x/` is the
// first) turned into one org's `OrgSources` and the column mappings its asset lists are pushed
// with, so `runFullPipeline` and `planFastLoad` take it like a generated org.
// - Asset lists: one per `import-mappings.json` row, in that file's order (so the first source's
//   assets are pushed first and are the older ones a merge keeps), each `kind: 'asset_list'`,
//   `format: 'csv'`, its `source` from the row and no mentions. The mapping list is the rows'
//   `{ source, fields }`, in the same order.
// - Documents: one per `documents.json` row, in that file's order, with the row's kind and the
//   format its file name's extension gives. Text formats carry their text; PDF and DOCX their
//   bytes.
// Pure: the command reads the files (packages/infra/scripts/dataset-load.ts) and passes them in;
// nothing here touches the filesystem. Errors name a file's place and the rule, never a value.
import { KIND_FORMATS, type FileFormat, type ImportMapping } from '@grc/shared';
import type { OrgSources, SourceFile } from '../sources/index.js';

/** The kinds a dataset's documents may have: every upload kind but asset lists, which come from
 * `import-mappings.json`. */
export const DATASET_DOCUMENT_KINDS = ['policy_document', 'soc_ticket', 'audit_report'] as const;
export type DatasetDocumentKind = (typeof DATASET_DOCUMENT_KINDS)[number];

/** The `source` a dataset document's `SourceFile` names (only an asset list's source is sent). */
export const DATASET_DOCUMENT_SOURCE = 'dataset';

/** The file name extensions and the format each gives. */
const EXTENSION_FORMATS: Readonly<Record<string, FileFormat>> = Object.freeze({
  pdf: 'pdf',
  docx: 'docx',
  csv: 'csv',
  json: 'json',
  txt: 'txt',
});

/** The formats whose files are bytes rather than text. */
const BYTE_FORMATS: readonly FileFormat[] = ['pdf', 'docx'];

/** The format a file name's extension gives (case ignored), or null for any other extension. */
export function formatOfFileName(fileName: string): FileFormat | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return EXTENSION_FORMATS[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/** Whether a format's files are read as bytes (PDF, DOCX) rather than as UTF-8 text. */
export function isByteFormat(format: FileFormat): boolean {
  return BYTE_FORMATS.includes(format);
}

/** One `import-mappings.json` row with its asset list's text. */
export interface DatasetAssetList {
  source: string;
  /** The file's name under `sources/asset-lists/`. */
  file: string;
  fields: ImportMapping['fields'];
  /** The CSV file's text. */
  text: string;
}

/** One `documents.json` row with its file's content: text for TXT, JSON and CSV, bytes for PDF and DOCX. */
export interface DatasetDocument {
  /** The file's name under `sources/documents/`. */
  file: string;
  kind: DatasetDocumentKind;
  text?: string;
  bytes?: Uint8Array;
}

export interface DatasetSourcesInput {
  /** The answer key's one org key (`ORG-01`). */
  orgKey: string;
  /** `import-mappings.json`'s rows, in its order. */
  assetLists: readonly DatasetAssetList[];
  /** `documents.json`'s rows, in its order. */
  documents: readonly DatasetDocument[];
}

export interface DatasetSources {
  org: OrgSources;
  /** Each asset list source's column mapping, in `import-mappings.json`'s order. */
  mappings: ImportMapping[];
}

/** Input the folder check should have refused: a code and where (a list and a place), never a value. */
export class DatasetSourcesError extends Error {
  constructor(
    readonly code: 'source_twice' | 'not_csv' | 'bad_format' | 'no_content',
    readonly where: string,
  ) {
    super(`dataset sources: ${code} (${where})`);
    this.name = 'DatasetSourcesError';
  }
}

/** The folder's files as one org's sources and the mappings its asset lists are pushed with. */
export function datasetSources(input: DatasetSourcesInput): DatasetSources {
  const seen = new Set<string>();
  const assetLists: SourceFile[] = input.assetLists.map((list, i) => {
    const where = `import-mappings.json row ${i + 1}`;
    if (seen.has(list.source)) throw new DatasetSourcesError('source_twice', where);
    seen.add(list.source);
    if (formatOfFileName(list.file) !== 'csv') throw new DatasetSourcesError('not_csv', where);
    if (typeof list.text !== 'string') throw new DatasetSourcesError('no_content', where);
    return {
      source: list.source,
      kind: 'asset_list',
      fileName: list.file,
      format: 'csv',
      body: list.text,
      mentions: [],
    };
  });
  const mappings: ImportMapping[] = input.assetLists.map((list) => ({
    source: list.source,
    fields: { ...list.fields },
  }));

  const documents: SourceFile[] = input.documents.map((doc, i) => {
    const where = `documents.json row ${i + 1}`;
    const format = formatOfFileName(doc.file);
    if (format === null || !KIND_FORMATS[doc.kind].includes(format)) throw new DatasetSourcesError('bad_format', where);
    if (isByteFormat(format)) {
      if (!(doc.bytes instanceof Uint8Array)) throw new DatasetSourcesError('no_content', where);
      return {
        source: DATASET_DOCUMENT_SOURCE,
        kind: doc.kind,
        fileName: doc.file,
        format,
        body: '',
        bytes: new Uint8Array(doc.bytes),
        mentions: [],
      };
    }
    if (typeof doc.text !== 'string') throw new DatasetSourcesError('no_content', where);
    return {
      source: DATASET_DOCUMENT_SOURCE,
      kind: doc.kind,
      fileName: doc.file,
      format,
      body: doc.text,
      mentions: [],
    };
  });

  return { org: { orgKey: input.orgKey, assetLists, documents }, mappings };
}
