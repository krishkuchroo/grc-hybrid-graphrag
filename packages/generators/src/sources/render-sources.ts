// The dummy sources (D18): every file a real connector would deliver for each org of the answer key,
// with the mess real data has, and every planted trap written down in `plants` so the benchmark can
// score it. Pure: the same answer key and options always give byte-identical files (D45.8), and
// nothing here touches the network, the filesystem or the environment.
import { MAX_UPLOAD_BYTES, type FileFormat, type UploadKind } from '@grc/shared';
import type { AnswerKey } from '../world/index.js';
import { renderAssetLists, type DuplicateVariant } from './cmdb.js';
import { draftAuditReports } from './audit-reports.js';
import { plantInjections, type InjectionKind } from './injections.js';
import {
  DEFAULT_RATES,
  OrgWorld,
  STREAMS,
  fakerFor,
  plantFalsePositives,
  plantProseTypos,
  type DocDraft,
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
  body: string;
  mentions: Mention[];
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

const encoder = new TextEncoder();

function checkSize(file: SourceFile): void {
  if (encoder.encode(file.body).byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`source file ${file.fileName} is over the ${MAX_UPLOAD_BYTES}-byte upload limit`);
  }
}

function toSourceFile(draft: DocDraft): SourceFile {
  const body = draft.render();
  const mentions: Mention[] = [];
  for (const paragraph of draft.paragraphs) {
    for (const sentence of paragraph.sentences) {
      if (sentence.kind !== 'fact') continue;
      if (!body.includes(sentence.text)) throw new Error(`a fact sentence of ${draft.fileName} is not in its body`);
      mentions.push({ fact: { ...sentence.fact }, sentence: sentence.text });
    }
  }
  return { source: draft.source, kind: draft.kind, fileName: draft.fileName, format: draft.format, body, mentions };
}

/**
 * Writes every org's asset lists (CMDB exports, `CMDB_SOURCES`) and documents (policies, SOC tickets
 * and audit reports as text) from the answer key, then plants the mess at the given rates. The answer
 * key is only read.
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
    plantFalsePositives(world, drafts, stream(STREAMS.falsePositives), rates.falsePositiveRate, plants);
    plantInjections(world, drafts, stream(STREAMS.injections), rates.injectionRate, plants);
    plantProseTypos(world, drafts, stream(STREAMS.proseTypos), rates.typoRate, plants);
    const documents = drafts.map(toSourceFile);

    for (const file of [...assetLists, ...documents]) checkSize(file);
    return { orgKey: org.key, assetLists, documents };
  });
  return { orgs, plants };
}
