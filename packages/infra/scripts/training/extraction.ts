// The `extraction` job's rows (TR-001; D18, D39, D52.1, D52.3, D52.4, D71, D234, D248): for every
// generated document, each chunk as the worker cuts it, the app's own request for that chunk, and
// the correct answer from the answer key, the document's mentions and the plants.
//
// Reading and chunking, as the worker does: `readDocumentText(fileBytesOf(file), format,
// MAX_DOCUMENT_TEXT_LENGTH)`, then `chunkText(text, counter)` with its default options (500 tokens,
// 50 overlap). Only the kinds and formats the reader reads.
//
// The correct answer for one chunk (pure: `extractionAnswers`):
// - Records: every answer-key record of the org whose name appears in the chunk's text exactly
//   (case-sensitive), or a typo of it planted in this file. Longest names are matched first and
//   matches don't overlap. A name is matched with any run of white space where it has a space, as
//   a sentence is (PDF text breaks lines inside names), and written as it appears in the chunk.
//   Each record is reported once, with its kind, the name at its first appearance and refs r1, r2
//   … in order of first appearance. No `details`.
// - Links: each mention of the document whose sentence lies whole inside the chunk (found with
//   runs of white space counting as one space, and copied from the chunk's own text), from and to
//   the refs of the fact's two ends in the link type's direction; one link per type and pair of
//   ends, in the order the sentences appear. A plant (a false positive's `notAFact`, an add-links
//   injection's `proposedLink`) never gives a link; the records its sentence names are reported.
// - A chunk that names nothing gets {"records":[],"links":[]}.
// - Nothing unsure is guessed: a chunk is left out, and counted, when a mention's sentence is cut
//   by its edge (`sentence_cut`), a name matches two records (`ambiguous_name`) or a link's end is
//   not among its records (`end_not_named`); a whole document is left out when a mention's
//   sentence lies whole in none of its chunks (`sentence_not_found`).
// Every answer must pass EXTRACTION_ANSWER_SHAPE and be kept whole by `readExtractionAnswer`;
// anything else is a bug (TrainingDataBug).
import { isDeepStrictEqual } from 'node:util';
import type { TextRequest } from '../../../api/src/ai/text-model.js';
import {
  EXTRACTION_ANSWER_SHAPE,
  EXTRACTION_PROMPT_VERSION,
  extractionRequest,
} from '../../../api/src/processing/extract/prompt.js';
import { chunkText } from '../../../api/src/processing/reader/chunker.js';
import { MAX_DOCUMENT_TEXT_LENGTH } from '../../../api/src/processing/reader/document-read.job.js';
import { readDocumentText } from '../../../api/src/processing/reader/document-text.js';
import { isReadableDocumentKind, isReadableFormat } from '../../../api/src/processing/reader/readable-kinds.js';
import { fileBytesOf, type Fact, type Mention, type TypoPlant, type WorldOrg } from '../../../generators/src/index.js';
import { readExtractionAnswer, type LinkType, type RecordKind } from '../../../shared/src/index.js';
import {
  TrainingDataBug,
  type BuildContext,
  type JobBuilder,
  type TrainingExample,
  type TrainingWorld,
  type WorldExamples,
} from './rows.js';

/** Why a chunk (or a whole document's chunks) is left out, in the order they are reported. */
export const EXTRACTION_DROP_REASONS = [
  'sentence_cut',
  'end_not_named',
  'ambiguous_name',
  'sentence_not_found',
] as const;
export type ExtractionDropReason = (typeof EXTRACTION_DROP_REASONS)[number];

/** An answer-key record: its key, kind and name. */
export interface NamedRecord {
  key: string;
  kind: RecordKind;
  name: string;
}

/** A name a record is written under in one file: a planted typo of its name. */
export interface NameVariant {
  name: string;
  key: string;
}

/** A chunk of a document: `text` is `documentText.slice(startOffset, endOffset)`. */
export interface ChunkSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

/** One document, read and chunked, with what the answer key and the plants say about it. */
export interface ExtractionDocument {
  /** The document's text as the reader gives it. */
  text: string;
  chunks: readonly ChunkSpan[];
  /** Every answer-key record of the document's org. */
  records: readonly NamedRecord[];
  /** The typo'd names planted in this file. */
  typoNames: readonly NameVariant[];
  /** The facts the document states, each with its sentence. */
  mentions: readonly Mention[];
  /** The links the file's plants name and the answer key doesn't have: never an answer's link. */
  plantedLinks: readonly Fact[];
}

/** The answer's objects, keys in EXTRACTION_ANSWER_SHAPE's order. */
export interface AnswerRecord {
  ref: string;
  kind: RecordKind;
  name: string;
}

export interface AnswerLink {
  type: LinkType;
  from: string;
  to: string;
  sentence: string;
}

export interface ExtractionAnswerValue {
  records: AnswerRecord[];
  links: AnswerLink[];
}

/** One chunk's outcome: its correct answer, or why it is left out. */
export type ChunkOutcome = { answer: ExtractionAnswerValue } | { dropped: ExtractionDropReason };

const KIND_LISTS = [
  ['asset', 'assets'],
  ['risk', 'risks'],
  ['control', 'controls'],
  ['policy', 'policies'],
  ['incident', 'incidents'],
] as const satisfies readonly (readonly [RecordKind, keyof WorldOrg])[];

/** Every record of an answer-key org, kind by kind, in the answer key's order. */
export function recordsOf(org: WorldOrg): NamedRecord[] {
  return KIND_LISTS.flatMap(([kind, list]) =>
    org[list].map((record) => ({ key: record.key, kind, name: record.name })),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** The text's words: its runs of non-space characters. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '');
}

/** A pattern for the text with any run of white space where it has one; null for a blank text. */
function spacedPattern(text: string): RegExp | null {
  const words = wordsOf(text);
  return words.length === 0 ? null : new RegExp(words.map(escapeRegExp).join('\\s+'), 'g');
}

/**
 * The typo'd names planted in one file, each with its record: an asset row's misspelt name as a
 * whole; a misspelt word of a prose sentence, in every record name that holds the word (a whole
 * run of letters), one place at a time.
 */
export function typoNamesOf(records: readonly NamedRecord[], typos: readonly TypoPlant[]): NameVariant[] {
  const out: NameVariant[] = [];
  for (const typo of typos) {
    if (typo.where === 'asset_name') {
      if (typo.recordKey !== undefined && typo.typo !== '') out.push({ name: typo.typo, key: typo.recordKey });
      continue;
    }
    if (typo.original === '' || typo.original === typo.typo) continue;
    for (const record of records) {
      for (const run of record.name.matchAll(/[A-Za-z]+/g)) {
        if (run[0] !== typo.original) continue;
        const at = run.index;
        out.push({
          name: record.name.slice(0, at) + typo.typo + record.name.slice(at + run[0].length),
          key: record.key,
        });
      }
    }
  }
  return out;
}

/** A name to look for, and the records it names (more than one: ambiguous). */
interface Candidate {
  /** The name with its runs of white space made one space. */
  name: string;
  firstWord: string;
  pattern: RegExp;
  records: NamedRecord[];
}

function candidatesOf(records: readonly NamedRecord[], variants: readonly NameVariant[]): Candidate[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const byName = new Map<string, Map<string, NamedRecord>>();
  const add = (name: string, record: NamedRecord): void => {
    const normal = wordsOf(name).join(' ');
    if (normal === '') return;
    const named = byName.get(normal) ?? new Map<string, NamedRecord>();
    named.set(record.key, record);
    byName.set(normal, named);
  };
  for (const record of records) add(record.name, record);
  for (const variant of variants) {
    const record = byKey.get(variant.key);
    if (record === undefined) throw new TrainingDataBug('a planted typo names a record the answer key does not have');
    add(variant.name, record);
  }
  const candidates: Candidate[] = [];
  for (const [name, named] of byName) {
    candidates.push({
      name,
      firstWord: wordsOf(name)[0]!,
      pattern: spacedPattern(name)!,
      records: [...named.values()],
    });
  }
  // Longest first; equal lengths in a fixed order.
  return candidates.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

interface NameMatch {
  start: number;
  end: number;
  records: NamedRecord[];
}

/** The names in a text: longest first, never overlapping, in the order they appear. */
function matchNames(text: string, candidates: readonly Candidate[]): NameMatch[] {
  const matches: NameMatch[] = [];
  const overlaps = (start: number, end: number): boolean => matches.some((m) => start < m.end && end > m.start);
  for (const candidate of candidates) {
    if (!text.includes(candidate.firstWord)) continue;
    const pattern = candidate.pattern;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
      const start = found.index;
      const end = start + found[0].length;
      if (overlaps(start, end)) {
        // Another place may start inside this one.
        pattern.lastIndex = start + 1;
        continue;
      }
      matches.push({ start, end, records: candidate.records });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Where a mention's sentence is in the document's text, and the facts it states. */
interface Occurrence {
  start: number;
  end: number;
  facts: Fact[];
}

function factIdentity(fact: Fact): string {
  return `${fact.type}|${fact.fromKey}|${fact.toKey}`;
}

/**
 * Every place each mention's sentence is in the text, and whether every sentence lies whole in
 * one of the chunks at least.
 */
function occurrencesOf(
  text: string,
  mentions: readonly Mention[],
  chunks: readonly ChunkSpan[],
): { occurrences: Occurrence[]; allFound: boolean } {
  const bySentence = new Map<string, Map<string, Fact>>();
  for (const mention of mentions) {
    const normal = wordsOf(mention.sentence).join(' ');
    if (normal === '') return { occurrences: [], allFound: false };
    const facts = bySentence.get(normal) ?? new Map<string, Fact>();
    facts.set(factIdentity(mention.fact), mention.fact);
    bySentence.set(normal, facts);
  }
  const occurrences: Occurrence[] = [];
  let allFound = true;
  for (const [sentence, facts] of bySentence) {
    const pattern = spacedPattern(sentence)!;
    const found: Occurrence[] = [];
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      found.push({ start: m.index, end: m.index + m[0].length, facts: [...facts.values()] });
    }
    if (!found.some((o) => chunks.some((chunk) => isInside(o, chunk)))) allFound = false;
    occurrences.push(...found);
  }
  return { occurrences: occurrences.sort((a, b) => a.start - b.start), allFound };
}

function isInside(o: { start: number; end: number }, chunk: ChunkSpan): boolean {
  return o.start >= chunk.startOffset && o.end <= chunk.endOffset;
}

function isCut(o: { start: number; end: number }, chunk: ChunkSpan): boolean {
  return o.start < chunk.endOffset && o.end > chunk.startOffset && !isInside(o, chunk);
}

/** One chunk's correct answer, or why it is left out. */
function chunkOutcome(
  chunk: ChunkSpan,
  candidates: readonly Candidate[],
  occurrences: readonly Occurrence[],
): ChunkOutcome {
  if (occurrences.some((o) => isCut(o, chunk))) return { dropped: 'sentence_cut' };

  const refs = new Map<string, string>();
  const records: AnswerRecord[] = [];
  for (const match of matchNames(chunk.text, candidates)) {
    if (match.records.length !== 1) return { dropped: 'ambiguous_name' };
    const record = match.records[0]!;
    if (refs.has(record.key)) continue;
    const ref = `r${refs.size + 1}`;
    refs.set(record.key, ref);
    records.push({ ref, kind: record.kind, name: chunk.text.slice(match.start, match.end) });
  }

  const links: AnswerLink[] = [];
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    if (!isInside(occurrence, chunk)) continue;
    const sentence = chunk.text.slice(occurrence.start - chunk.startOffset, occurrence.end - chunk.startOffset);
    for (const fact of occurrence.facts) {
      const from = refs.get(fact.fromKey);
      const to = refs.get(fact.toKey);
      if (from === undefined || to === undefined) return { dropped: 'end_not_named' };
      const identity = `${fact.type}|${from}|${to}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      links.push({ type: fact.type, from, to, sentence });
    }
  }
  return { answer: { records, links } };
}

/** Each chunk's correct answer, or why it is left out (see the top of the file). Pure. */
export function extractionAnswers(doc: ExtractionDocument): ChunkOutcome[] {
  for (const chunk of doc.chunks) {
    if (doc.text.slice(chunk.startOffset, chunk.endOffset) !== chunk.text) {
      throw new TrainingDataBug("a chunk's text is not its slice of the document's text");
    }
  }
  const planted = new Set(doc.plantedLinks.map(factIdentity));
  if (doc.mentions.some((mention) => planted.has(factIdentity(mention.fact)))) {
    throw new TrainingDataBug('a document states as a fact a link its plants say is not one');
  }
  const { occurrences, allFound } = occurrencesOf(doc.text, doc.mentions, doc.chunks);
  if (!allFound) return doc.chunks.map(() => ({ dropped: 'sentence_not_found' }));
  const candidates = candidatesOf(doc.records, doc.typoNames);
  return doc.chunks.map((chunk) => chunkOutcome(chunk, candidates, occurrences));
}

/**
 * Null when `value` passes EXTRACTION_ANSWER_SHAPE, `readExtractionAnswer` keeps all of it and (when
 * given) it is `expected`; else what is wrong, by field paths and counts only.
 */
export function checkExtractionAnswerValue(value: unknown, expected?: ExtractionAnswerValue): string | null {
  const shape = EXTRACTION_ANSWER_SHAPE.safeParse(value);
  if (!shape.success) {
    const where = shape.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(answer)'} ${issue.code}`)
      .join(', ');
    return `the answer does not pass EXTRACTION_ANSWER_SHAPE (${where})`;
  }
  const read = readExtractionAnswer(value);
  if (!read.readable || read.droppedRecords > 0 || read.droppedLinks > 0) {
    return `readExtractionAnswer does not keep all of the answer (${read.droppedRecords} record(s) and ${read.droppedLinks} link(s) dropped)`;
  }
  if (!isDeepStrictEqual(read.answer, shape.data)) return 'readExtractionAnswer does not keep the answer as it is';
  if (expected !== undefined && !isDeepStrictEqual(read.answer, expected)) {
    return "the answer read back is not the row's answer";
  }
  return null;
}

/** The app's request for one chunk, as the extraction job sends it to the text model. */
function requestFor(chunk: string): TextRequest<unknown> {
  const { neutralisedMarkers, ...request } = extractionRequest(chunk);
  void neutralisedMarkers;
  return request;
}

async function buildWorld(world: TrainingWorld, ctx: BuildContext): Promise<WorldExamples> {
  const examples: TrainingExample[] = [];
  const dropped: Record<string, number> = Object.fromEntries(EXTRACTION_DROP_REASONS.map((reason) => [reason, 0]));
  const { plants } = world.sources;
  for (const orgSources of world.sources.orgs) {
    const org = world.key.orgs.find((o) => o.key === orgSources.orgKey);
    if (org === undefined) throw new TrainingDataBug('the rendered sources name an org the answer key does not have');
    const records = recordsOf(org);
    for (const [docIndex, file] of orgSources.documents.entries()) {
      if (!isReadableDocumentKind(file.kind) || !isReadableFormat(file.format)) continue;
      const where = `world ${world.seed}, org ${org.key}, document ${docIndex + 1}`;
      let text: string;
      try {
        text = await readDocumentText(fileBytesOf(file), file.format, MAX_DOCUMENT_TEXT_LENGTH);
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        throw new TrainingDataBug(
          `${where}: the reader could not read it (${typeof code === 'string' ? code : 'error'})`,
        );
      }
      const chunks = await chunkText(text, ctx.counter);
      const inFile = (plant: { orgKey: string; fileName: string }): boolean =>
        plant.orgKey === org.key && plant.fileName === file.fileName;
      const plantedLinks: Fact[] = [
        ...plants.falsePositives.filter(inFile).map((plant) => plant.notAFact),
        ...plants.injections.filter(inFile).flatMap((plant) => (plant.proposedLink ? [plant.proposedLink] : [])),
      ];
      const outcomes = extractionAnswers({
        text,
        chunks,
        records,
        typoNames: typoNamesOf(records, plants.typos.filter(inFile)),
        mentions: file.mentions,
        plantedLinks,
      });
      outcomes.forEach((outcome, i) => {
        if ('dropped' in outcome) {
          dropped[outcome.dropped] = (dropped[outcome.dropped] ?? 0) + 1;
          return;
        }
        const problem = checkExtractionAnswerValue(outcome.answer);
        if (problem !== null) throw new TrainingDataBug(`${where}, chunk ${i + 1}: ${problem}`);
        const request = requestFor(chunks[i]!.text);
        examples.push({
          job: 'extraction',
          seed: world.seed,
          system: request.instructions,
          user: request.data,
          assistant: JSON.stringify(outcome.answer),
          request,
        });
      });
    }
  }
  return { examples, dropped };
}

export const extractionBuilder: JobBuilder = {
  job: 'extraction',
  promptVersion: EXTRACTION_PROMPT_VERSION,
  dropReasons: EXTRACTION_DROP_REASONS,
  build: buildWorld,
  checkAnswer(value: unknown, example: TrainingExample): string | null {
    let expected: ExtractionAnswerValue;
    try {
      expected = JSON.parse(example.assistant) as ExtractionAnswerValue;
    } catch {
      return "the row's answer is not JSON";
    }
    return checkExtractionAnswerValue(value, expected);
  },
};
