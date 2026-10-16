// The dummy sources (D18): every file a real connector would deliver for each org of the answer key,
// with the mess real data has, and every planted trap written down in `plants` so the benchmark can
// score it. Pure: the same answer key and options always give byte-identical files (D45.8), and
// nothing here touches the network, the filesystem or the environment.
//
// Documents come in the formats a customer's do (D213 (8), D53; S8-007): policy documents about a
// third each as TXT, DOCX and PDF, audit reports about half PDF and half TXT, SOC tickets as JSON or
// TXT. Which document gets which format is drawn from its own seeded stream before the plants are
// placed, so the documents' text, the answer key and the plants stay as they were apart from file
// names, and every plant names its document's file as delivered.
import type { Faker } from '@faker-js/faker';
import { MAX_UPLOAD_BYTES, type FileFormat, type UploadKind } from '@grc/shared';
import type { AnswerKey } from '../world/index.js';
import { renderAssetLists, type DuplicateVariant } from './cmdb.js';
import { draftAuditReports } from './audit-reports.js';
import { pdfKeepsWordsWhole, writeDocx, writePdf } from './formats/index.js';
import { plantInjections, type InjectionKind } from './injections.js';
import {
  DEFAULT_RATES,
  OrgWorld,
  STREAMS,
  fakerFor,
  plantFalsePositives,
  plantProseTypos,
  type DocDraft,
  type DocFormat,
  type Fact,
  type MessRates,
} from './mess.js';
import { draftPolicies } from './policies.js';
import { draftSocTickets } from './soc-tickets.js';

/** A fact a document states, with the sentence that states it (it names both ends). */
export interface Mention {
  fact: Fact;
  sentence: string;
}

/** One file as a connector would deliver it. `mentions` lists every fact a document states. */
export interface SourceFile {
  source: string;
  kind: UploadKind;
  fileName: string;
  format: FileFormat;
  /** The file's text: for CSV, JSON and TXT the whole file; for PDF and DOCX the text it lays out. */
  body: string;
  /** The file's bytes, for PDF and DOCX only (`fileBytesOf` gives any file's bytes). */
  bytes?: Uint8Array;
  mentions: Mention[];
}

/** The formats written as bytes rather than text. */
export const BINARY_FORMATS: readonly FileFormat[] = ['pdf', 'docx'];

const encoder = new TextEncoder();

/**
 * The bytes a connector delivers for the file, as a new copy each call (so a reader that takes over
 * or changes its buffer leaves the file as it was): its `bytes` for PDF and DOCX, its text as UTF-8
 * for the others. A PDF or DOCX file without its bytes is an error.
 */
export function fileBytesOf(file: Pick<SourceFile, 'format' | 'body' | 'bytes'>): Uint8Array {
  if (file.bytes !== undefined) return new Uint8Array(file.bytes);
  if (BINARY_FORMATS.includes(file.format)) throw new Error(`a ${file.format} source file has no bytes`);
  return encoder.encode(file.body);
}

export interface OrgSources {
  orgKey: string;
  assetLists: SourceFile[];
  documents: SourceFile[];
}

/** An asset row written a second time: under a spelling variant, or in a second source system. */
export interface DuplicatePlant {
  orgKey: string;
  recordKey: string;
  variant: DuplicateVariant;
  source: string;
  fileName: string;
  sourceId: string;
  name: string;
  /** The asset's own row, which the duplicate repeats. */
  original: { source: string; fileName: string; sourceId: string; name: string };
}

/** A misspelling: an asset row's name, or one word of a prose sentence in a document. */
export interface TypoPlant {
  orgKey: string;
  fileName: string;
  where: 'asset_name' | 'prose';
  /** For an asset name: the record and its row. */
  recordKey?: string;
  source?: string;
  sourceId?: string;
  /** The right spelling and the one written (a whole name, or one word of a sentence). */
  original: string;
  typo: string;
  /** For prose: the sentence as written. */
  sentence?: string;
}

/** A sentence that names two records the answer key does not link: "not a fact". */
export interface FalsePositivePlant {
  orgKey: string;
  fileName: string;
  sentence: string;
  notAFact: Fact;
}

/** Text that tells a model to ignore its instructions, leak data or add links (D52.6). */
export interface InjectionPlant {
  orgKey: string;
  fileName: string;
  kind: InjectionKind;
  text: string;
  /** For `add_links`: the link it asks for, which the answer key does not have. */
  proposedLink?: Fact;
}

export interface Plants {
  duplicates: DuplicatePlant[];
  typos: TypoPlant[];
  falsePositives: FalsePositivePlant[];
  injections: InjectionPlant[];
}

export interface RenderSourcesOptions {
  /** The seed for the mess and the wording; the answer key's own seed when not given. */
  seed?: number;
  duplicateRate?: number;
  typoRate?: number;
  falsePositiveRate?: number;
  injectionRate?: number;
}

export interface RenderedSources {
  orgs: OrgSources[];
  plants: Plants;
}

function ratesOf(opts: RenderSourcesOptions): MessRates {
  const rates: MessRates = {
    duplicateRate: opts.duplicateRate ?? DEFAULT_RATES.duplicateRate,
    typoRate: opts.typoRate ?? DEFAULT_RATES.typoRate,
    falsePositiveRate: opts.falsePositiveRate ?? DEFAULT_RATES.falsePositiveRate,
    injectionRate: opts.injectionRate ?? DEFAULT_RATES.injectionRate,
  };
  for (const [name, value] of Object.entries(rates)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be from 0 to 1`);
  }
  return rates;
}

function checkSize(file: SourceFile): void {
  const size = file.bytes?.byteLength ?? encoder.encode(file.body).byteLength;
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`source file ${file.fileName} is over the ${MAX_UPLOAD_BYTES}-byte upload limit`);
  }
}

/** The formats each kind of document is written in, in equal shares; kinds not listed keep theirs. */
export const DOCUMENT_FORMAT_MIX: readonly (readonly [UploadKind, readonly DocFormat[]])[] = [
  ['policy_document', ['txt', 'docx', 'pdf']],
  ['audit_report', ['pdf', 'txt']],
];

/** The file name with its extension swapped for the format's. */
function withExtension(fileName: string, format: DocFormat): string {
  const dot = fileName.lastIndexOf('.');
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.${format}`;
}

/**
 * Gives each text document of a kind in `DOCUMENT_FORMAT_MIX` its format: the kind's formats in
 * turn from a seeded start, as even as the count allows, in a seeded order; its file name follows.
 */
export function assignDocumentFormats(drafts: readonly DocDraft[], faker: Faker): void {
  for (const [kind, mix] of DOCUMENT_FORMAT_MIX) {
    const ofKind = drafts.filter((draft) => draft.kind === kind);
    if (ofKind.length === 0) continue;
    const start = faker.number.int({ min: 0, max: mix.length - 1 });
    const formats = faker.helpers.shuffle(ofKind.map((_, i) => mix[(start + i) % mix.length]!));
    ofKind.forEach((draft, i) => {
      const format = formats[i]!;
      if (format === draft.format) return;
      if (draft.format !== 'txt' || !draft.layout) throw new Error(`${draft.fileName} can't be laid out as ${format}`);
      draft.format = format;
      draft.fileName = withExtension(draft.fileName, format);
    });
  }
}

function toSourceFile(draft: DocDraft): SourceFile {
  const body = draft.render();
  const binary = draft.format === 'pdf' || draft.format === 'docx';
  const layout = binary ? draft.layout?.() : undefined;
  if (binary && !layout) throw new Error(`${draft.fileName} has no layout`);
  const mentions: Mention[] = [];
  for (const paragraph of draft.paragraphs) {
    for (const sentence of paragraph.sentences) {
      if (sentence.kind !== 'fact') continue;
      if (!body.includes(sentence.text)) throw new Error(`a fact sentence of ${draft.fileName} is not in its body`);
      // Within one paragraph of the layout, a sentence is wrapped only at spaces, so it reads back
      // whole, as long as a PDF can show all of it and none of its words is cut.
      if (layout && !layout.paragraphs.some((p) => p.includes(sentence.text))) {
        throw new Error(`a fact sentence of ${draft.fileName} is not in one paragraph`);
      }
      if (draft.format === 'pdf' && !pdfKeepsWordsWhole(sentence.text)) {
        throw new Error(`a fact sentence of ${draft.fileName} would not read back whole from a PDF`);
      }
      mentions.push({ fact: { ...sentence.fact }, sentence: sentence.text });
    }
  }
  const file: SourceFile = {
    source: draft.source,
    kind: draft.kind,
    fileName: draft.fileName,
    format: draft.format,
    body,
    mentions,
  };
  if (layout) file.bytes = draft.format === 'pdf' ? writePdf(layout) : writeDocx(layout);
  return file;
}

/**
 * Writes every org's asset lists (CMDB exports, `CMDB_SOURCES`) and documents (policies, SOC tickets
 * and audit reports, in the formats of `DOCUMENT_FORMAT_MIX`) from the answer key, then plants the
 * mess at the given rates. The answer key is only read.
 */
export function renderSources(key: AnswerKey, opts: RenderSourcesOptions = {}): RenderedSources {
  const rates = ratesOf(opts);
  const seed = opts.seed ?? key.seed;
  if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a whole number');

  const plants: Plants = { duplicates: [], typos: [], falsePositives: [], injections: [] };
  const orgs = key.orgs.map((org, index): OrgSources => {
    const world = new OrgWorld(org, index);
    const stream = (s: number) => fakerFor(seed, index, s);

    const assetLists = renderAssetLists(world, {
      faker: stream(STREAMS.cmdb),
      duplicateFaker: stream(STREAMS.duplicates),
      typoFaker: stream(STREAMS.cmdbTypos),
      duplicateRate: rates.duplicateRate,
      typoRate: rates.typoRate,
      plants,
    });

    const drafts: DocDraft[] = [
      ...draftPolicies(world, stream(STREAMS.policies)),
      ...draftSocTickets(world, stream(STREAMS.socTickets)),
      ...draftAuditReports(world, stream(STREAMS.auditReports)),
    ];
    // Before the plants, so each plant records its document's file name as delivered.
    assignDocumentFormats(drafts, stream(STREAMS.formats));
    plantFalsePositives(world, drafts, stream(STREAMS.falsePositives), rates.falsePositiveRate, plants);
    plantInjections(world, drafts, stream(STREAMS.injections), rates.injectionRate, plants);
    plantProseTypos(world, drafts, stream(STREAMS.proseTypos), rates.typoRate, plants);
    const documents = drafts.map(toSourceFile);

    for (const file of [...assetLists, ...documents]) checkSize(file);
    return { orgKey: org.key, assetLists, documents };
  });
  return { orgs, plants };
}
