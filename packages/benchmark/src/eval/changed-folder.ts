// The changed-data folder (EV-003; D45.8, D261 track A, item 4): a copy of a dataset folder with some
// records renamed and some links deleted, so an answer that still shows an old name or a deleted
// link shows it came from training memory, not from the data. `pnpm eval:changed` reads and writes
// the files (packages/infra/scripts/eval-changed.ts); everything here is pure.
// - Renames: risks, controls, policies and incidents, taken round-robin in that order (assets never:
//   their names come from the asset lists and sit inside incident names). A record may be renamed
//   when it isn't a fixed template's record or an end of a plant's link, and its normalised name
//   neither holds nor sits inside another record's name as whole words. The records are a seeded
//   pick; each new name is `madeUpName`'s, retried until it is new and `isMadeUp` holds against
//   every old and new name. Every text (the documents, the asset lists, the facts' sentences, the
//   plants' texts) and every JSON string (record names, facts' `from`/`to`, framework mappings'
//   `control`, provenance names …) has each occurrence of an old name, exactly or case-insensitively
//   with the same spacing and as whole words, changed to the new name. The framework catalogs'
//   own names (a mapping's `requirement` and its crosswalk names) are left alone.
// - Deletions: MITIGATED_BY, GOVERNED_BY, IMPACTS and EXPOSES, taken round-robin in that order. A
//   link may be deleted when each sentence stating it states no other link (no other fact gives the
//   same file and sentence, or a sentence holding it or held in it), neither end is a fixed
//   template's record, a plant's end or a renamed record, and the question side (the risk, the
//   policy, the asset and the incident) still has a link of that type after all the deletions. The
//   link leaves the answer key, the facts and the provenance links, and each stating sentence leaves
//   its file (with one following space or line break, if there is one).
// - The checks (`checkChangedFiles`): no old name left by normalised whole words (except a control's
//   name right after its 800-53 code), every deleted sentence gone, every kept sentence still there.
// The same folder, seed and counts always give the same changes and the same files (D45.8).
import { Faker, base, en } from '@faker-js/faker';
import { formatOfFileName, isByteFormat } from '@grc/generators';
import { normaliseName, type LinkType, type RecordKind } from '@grc/shared';
import { DATASET_FILES, type DatasetFolder } from '../dataset/folder.js';
import { assetPrefixOf, isMadeUp, madeUpName } from '../questions/made-up-names.js';
import { OrgGraph, type GraphRecord } from '../questions/org-graph.js';
import type { EvalPlant } from './build-eval-set.js';
import {
  CHANGES_FILE,
  CHANGES_FORMAT_VERSION,
  DELETED_LINK_TYPES,
  MAX_DELETIONS,
  MAX_RENAMES,
  RENAMED_KINDS,
  type ChangeDeletion,
  type ChangeRename,
  type ChangeSentence,
  type ChangesFile,
  type ChangesFileProblem,
  type DeletedLinkType,
  type RenamedKind,
} from './changes-file.js';
import { fixedQuestionKeys } from './fixed-questions.js';

/** The defaults of `pnpm eval:changed`. */
export const CHANGED_DEFAULT_SEED = 1;
export const CHANGED_DEFAULT_RENAMES = 8;
export const CHANGED_DEFAULT_DELETIONS = 20;

/** The changed folder's default slug and org name. */
export function changedSlugOf(slug: string): string {
  return `${slug}-changed`;
}
export function changedOrgNameOf(name: string): string {
  return `${name} (changed)`;
}

/** For each deleted type, the end its single-hop question starts from. */
export const QUESTION_SIDE: Readonly<Record<DeletedLinkType, 'from' | 'to'>> = Object.freeze({
  MITIGATED_BY: 'from', // the risk
  GOVERNED_BY: 'to', // the policy
  IMPACTS: 'to', // the asset
  EXPOSES: 'from', // the incident
});

/** Made-up names tried for one record before the next eligible record of its kind is taken. */
const NAME_TRIES = 200;

/** The seeded streams: one per renamed kind, one per deleted type, and one for the new names. */
const RENAME_STREAM = 301;
const DELETE_STREAM = 311;
const NAME_STREAM = 321;

function fakerFor(seed: number, stream: number): Faker {
  const faker = new Faker({ locale: [en, base] });
  faker.seed([seed, stream, 0]);
  return faker;
}

/** Whether `inner` is `outer`'s words or a whole-word run of them (both normalised). */
function holdsWords(outer: string, inner: string): boolean {
  return ` ${outer} `.includes(` ${inner} `);
}

export interface ChangeOptions {
  /** A whole number from 0. */
  seed: number;
  /** Records to rename: 0 to `MAX_RENAMES`. */
  renames: number;
  /** Links to delete: 0 to `MAX_DELETIONS`. */
  deletions: number;
  /** Records never changed; default `fixedQuestionKeys()`. */
  fixedKeys?: ReadonlySet<string>;
}

/** What was asked for and what could be made, counts only (D164). */
export interface ChangeCounts {
  renamesAsked: number;
  deletionsAsked: number;
  renamesPerKind: Record<RenamedKind, number>;
  deletionsPerType: Record<DeletedLinkType, number>;
  /** Records each kind could have renamed, and links each type could have deleted. */
  eligibleRenames: Record<RenamedKind, number>;
  eligibleDeletions: Record<DeletedLinkType, number>;
}

export type ChangePlanErrorCode = 'bad_option';

/** Changes that can't be planned; the message names options and counts only, never a name. */
export class ChangePlanError extends Error {
  constructor(
    readonly code: ChangePlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChangePlanError';
  }
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

function checkOptions(opts: ChangeOptions): void {
  if (!Number.isSafeInteger(opts.seed) || opts.seed < 0) {
    throw new ChangePlanError('bad_option', 'seed must be a whole number from 0');
  }
  if (!Number.isInteger(opts.renames) || opts.renames < 0 || opts.renames > MAX_RENAMES) {
    throw new ChangePlanError('bad_option', `renames must be a whole number from 0 to ${MAX_RENAMES}`);
  }
  if (!Number.isInteger(opts.deletions) || opts.deletions < 0 || opts.deletions > MAX_DELETIONS) {
    throw new ChangePlanError('bad_option', `deletions must be a whole number from 0 to ${MAX_DELETIONS}`);
  }
}

/** A sentence's identity in one file. */
function sentenceId(file: string, sentence: string): string {
  return `${file}\u0000${sentence}`;
}

/** The records a plant's link names (by normalised name, of any kind). */
function plantEndKeys(graph: OrgGraph, plants: readonly EvalPlant[]): Set<string> {
  const names = new Set<string>();
  for (const plant of plants) {
    if (plant.link === undefined) continue;
    names.add(normaliseName(plant.link.from));
    names.add(normaliseName(plant.link.to));
  }
  names.delete('');
  return new Set(graph.records.filter((r) => names.has(r.normalised)).map((r) => r.key));
}

/** A control's 800-53 code: its `nist_800_53` framework mapping's, else the answer key's `code`. */
function controlCode(folder: DatasetFolder, key: string): string | undefined {
  const mapped = folder.frameworkMappings.find((m) => m.controlKey === key && m.framework === 'nist_800_53');
  if (mapped !== undefined && mapped.code.trim() !== '') return mapped.code.trim();
  const record = folder.answerOrg.controls.find((c) => c.key === key) as { code?: unknown } | undefined;
  const code = record?.code;
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : undefined;
}

/**
 * The records of one kind that may be renamed: not held back, a name that isn't empty once
 * normalised, and neither holding nor held in another record's name as whole words.
 */
function renameCandidates(graph: OrgGraph, kind: RenamedKind, heldBack: ReadonlySet<string>): GraphRecord[] {
  return graph
    .ofKind(kind)
    .filter(
      (r) =>
        !heldBack.has(r.key) &&
        r.normalised !== '' &&
        graph.records.every(
          (o) =>
            o.key === r.key ||
            o.normalised === '' ||
            (!holdsWords(o.normalised, r.normalised) && !holdsWords(r.normalised, o.normalised)),
        ),
    );
}

// ---- Text and JSON changes -----------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A renamer: every occurrence of an old name (any case, the same spacing, whole words) → its new one. */
export class Renamer {
  private readonly pattern: RegExp | null;
  private readonly byLower = new Map<string, string>();
  private readonly singles: { test: RegExp; to: string }[];

  constructor(renames: readonly Pick<ChangeRename, 'from' | 'to'>[]) {
    const olds = [...renames].sort((a, b) => b.from.length - a.from.length || (a.from < b.from ? -1 : 1));
    for (const r of olds) this.byLower.set(r.from.toLowerCase(), r.to);
    this.singles = olds.map((r) => ({ test: new RegExp(`^${escapeRegExp(r.from)}$`, 'iu'), to: r.to }));
    this.pattern =
      olds.length === 0
        ? null
        : new RegExp(
            `(?<![\\p{L}\\p{N}\\p{M}])(?:${olds.map((r) => escapeRegExp(r.from)).join('|')})(?![\\p{L}\\p{N}\\p{M}])`,
            'giu',
          );
  }

  /** The text with every old name changed to its new name. */
  text(text: string): string {
    if (this.pattern === null) return text;
    return text.replace(this.pattern, (match) => {
      const to = this.byLower.get(match.toLowerCase()) ?? this.singles.find((s) => s.test.test(match))?.to;
      return to ?? match;
    });
  }

  /**
   * The JSON value with `text` applied to every string in it (object keys are left alone), except
   * under the paths `skip` names.
   */
  json(value: unknown, skip: (path: readonly (string | number)[]) => boolean = () => false): unknown {
    const walk = (v: unknown, path: (string | number)[]): unknown => {
      if (skip(path)) return v;
      if (typeof v === 'string') return this.text(v);
      if (Array.isArray(v)) return v.map((item, i) => walk(item, [...path, i]));
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v)) out[k] = walk(item, [...path, k]);
        return out;
      }
      return v;
    };
    return walk(value, []);
  }
}

/** The forms a sentence may take in a file: as it is, and, in a JSON file, as a JSON string's text. */
function sentenceForms(fileName: string, sentence: string): string[] {
  const forms = [sentence];
  if (formatOfFileName(fileName) === 'json') {
    const escaped = JSON.stringify(sentence).slice(1, -1);
    if (escaped !== sentence) forms.push(escaped);
  }
  return forms;
}

/**
 * The text with every occurrence of each sentence taken out, each with one following space or line
 * break (`\r\n` or `\n`) if there is one; and how many were taken out.
 */
export function removeSentences(
  text: string,
  sentences: readonly string[],
  fileName = '',
): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  const forms = [...new Set(sentences.flatMap((s) => sentenceForms(fileName, s)))]
    .filter((s) => s !== '')
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  for (const form of forms) {
    const pattern = new RegExp(`${escapeRegExp(form)}(?:\\r\\n|\\n| )?`, 'gu');
    out = out.replace(pattern, () => {
      removed += 1;
      return '';
    });
  }
  return { text: out, removed };
}

// ---- The plan --------------------------------------------------------------------------------------

/**
 * The renames and deletions for a folder (see the top of the file), as `changes.json` holds them.
 * The deletions' sentences are as the changed files hold them (after the renames).
 */
export function planChanges(
  folder: DatasetFolder,
  plants: readonly EvalPlant[],
  opts: ChangeOptions,
): { changes: ChangesFile; counts: ChangeCounts } {
  checkOptions(opts);
  const graph = OrgGraph.ofOrg(folder.answerOrg);
  const fixed = opts.fixedKeys ?? fixedQuestionKeys();
  const plantEnds = plantEndKeys(graph, plants);
  const heldBack = new Set([...fixed, ...plantEnds]);

  // ---- Renames: each kind's eligible records in a seeded order, the kinds taking turns ----------
  const queues = RENAMED_KINDS.map((kind, i) =>
    fakerFor(opts.seed, RENAME_STREAM + i).helpers.shuffle(renameCandidates(graph, kind, heldBack)),
  );
  const eligibleRenames = zeroes(RENAMED_KINDS);
  RENAMED_KINDS.forEach((kind, i) => (eligibleRenames[kind] = queues[i]!.length));
  const prefix = assetPrefixOf(folder.answerOrg.name, graph.records);
  const nameFaker = fakerFor(opts.seed, NAME_STREAM);
  const taken: GraphRecord[] = [...graph.records];
  const newName = (kind: RecordKind): string | null => {
    for (let tries = 0; tries < NAME_TRIES; tries++) {
      const candidate = madeUpName(nameFaker, kind, prefix);
      if (isMadeUp(candidate, taken)) return candidate;
    }
    return null;
  };
  const renames: ChangeRename[] = [];
  let turn = 0;
  while (renames.length < opts.renames && queues.some((q) => q.length > 0)) {
    const i = turn % RENAMED_KINDS.length;
    turn += 1;
    const queue = queues[i]!;
    while (queue.length > 0) {
      const record = queue.shift()!;
      const to = newName(record.kind);
      if (to === null) continue;
      taken.push({ key: `${record.key} (new)`, kind: record.kind, name: to, normalised: normaliseName(to) });
      const code = record.kind === 'control' ? controlCode(folder, record.key) : undefined;
      renames.push({
        key: record.key,
        kind: RENAMED_KINDS[i]!,
        from: record.name,
        to,
        ...(code !== undefined ? { code } : {}),
      });
      break;
    }
  }
  const renamed = new Set(renames.map((r) => r.key));
  const renamer = new Renamer(renames);

  // ---- Deletions ------------------------------------------------------------------------------------
  // The facts' sentences as the changed files hold them.
  const stated = folder.facts.map((fact) =>
    fact.statedIn.map((s) => ({ file: s.file, sentence: renamer.text(s.sentence) })),
  );
  const uses = new Map<string, number>();
  const byFile = new Map<string, Set<string>>();
  stated.forEach((list) => {
    for (const s of list) {
      uses.set(sentenceId(s.file, s.sentence), (uses.get(sentenceId(s.file, s.sentence)) ?? 0) + 1);
      if (!byFile.has(s.file)) byFile.set(s.file, new Set());
      byFile.get(s.file)!.add(s.sentence);
    }
  });
  /** Whether the sentence states only its own link: no other fact gives it, holds it or is held in it. */
  const statesOnlyItself = (s: ChangeSentence): boolean =>
    s.sentence !== '' &&
    uses.get(sentenceId(s.file, s.sentence)) === 1 &&
    [...(byFile.get(s.file) ?? [])].every(
      (other) => other === s.sentence || (!other.includes(s.sentence) && !s.sentence.includes(other)),
    );

  const linksLeft = new Map<string, number>();
  const sideKey = (type: DeletedLinkType, link: { fromKey: string; toKey: string }): string =>
    `${type}|${QUESTION_SIDE[type] === 'from' ? link.fromKey : link.toKey}`;
  for (const link of folder.answerOrg.links) {
    if (!(DELETED_LINK_TYPES as readonly LinkType[]).includes(link.type)) continue;
    const id = sideKey(link.type as DeletedLinkType, link);
    linksLeft.set(id, (linksLeft.get(id) ?? 0) + 1);
  }

  const seenLinks = new Set<string>();
  const candidates = DELETED_LINK_TYPES.map((type) =>
    folder.facts
      .map((fact, i) => ({ fact, sentences: stated[i]! }))
      .filter(({ fact, sentences }) => {
        if (fact.type !== type) return false;
        const id = OrgGraph.linkId(fact);
        if (seenLinks.has(id) || !graph.hasLink(fact)) return false;
        seenLinks.add(id);
        if ([fact.fromKey, fact.toKey].some((k) => heldBack.has(k) || renamed.has(k))) return false;
        if (graph.record(fact.fromKey) === undefined || graph.record(fact.toKey) === undefined) return false;
        return sentences.every(statesOnlyItself);
      }),
  );
  const eligibleDeletions = zeroes(DELETED_LINK_TYPES);
  const dQueues = DELETED_LINK_TYPES.map((type, i) => {
    eligibleDeletions[type] = candidates[i]!.length;
    return fakerFor(opts.seed, DELETE_STREAM + i).helpers.shuffle(candidates[i]!);
  });
  const deletions: ChangeDeletion[] = [];
  turn = 0;
  while (deletions.length < opts.deletions && dQueues.some((q) => q.length > 0)) {
    const i = turn % DELETED_LINK_TYPES.length;
    turn += 1;
    const type = DELETED_LINK_TYPES[i]!;
    const queue = dQueues[i]!;
    while (queue.length > 0) {
      const { fact, sentences } = queue.shift()!;
      const side = sideKey(type, fact);
      if ((linksLeft.get(side) ?? 0) < 2) continue;
      linksLeft.set(side, linksLeft.get(side)! - 1);
      deletions.push({
        type,
        fromKey: fact.fromKey,
        toKey: fact.toKey,
        from: graph.record(fact.fromKey)!.name,
        to: graph.record(fact.toKey)!.name,
        sentences: sentences.map((s) => ({ file: s.file, sentence: s.sentence })),
      });
      break;
    }
  }

  const renamesPerKind = zeroes(RENAMED_KINDS);
  for (const r of renames) renamesPerKind[r.kind] += 1;
  const deletionsPerType = zeroes(DELETED_LINK_TYPES);
  for (const d of deletions) deletionsPerType[d.type] += 1;
  return {
    changes: {
      version: CHANGES_FORMAT_VERSION,
      from: { slug: folder.org.slug, answerKeyVersion: folder.key.generatorVersion },
      seed: opts.seed,
      renames,
      deletions,
    },
    counts: {
      renamesAsked: opts.renames,
      deletionsAsked: opts.deletions,
      renamesPerKind,
      deletionsPerType,
      eligibleRenames,
      eligibleDeletions,
    },
  };
}

// ---- The files ---------------------------------------------------------------------------------------

/** One file under `sources/`: its path there (`documents/x.txt`) and its text or bytes. */
export interface SourceFile {
  path: string;
  content: { text: string } | { bytes: Uint8Array };
}

/** A folder's files: the JSON files at its top, parsed, by file name, and the files under `sources/`. */
export interface FolderFiles {
  json: Record<string, unknown>;
  sources: SourceFile[];
}

/** Whether a file under `sources/` is read as text (`.txt`, `.csv`, `.json`); others are copied as bytes. */
export function isTextSource(path: string): boolean {
  const format = formatOfFileName(path.slice(path.lastIndexOf('/') + 1));
  return format !== null && !isByteFormat(format);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function linkIdOf(v: unknown): string | null {
  if (v === null || typeof v !== 'object') return null;
  const { type, fromKey, toKey } = v as { type?: unknown; fromKey?: unknown; toKey?: unknown };
  return typeof type === 'string' && typeof fromKey === 'string' && typeof toKey === 'string'
    ? `${type}|${fromKey}|${toKey}`
    : null;
}

/** The changed folder's files: the renames and deletions applied, the manifest's org changed. */
export function applyChanges(
  files: FolderFiles,
  changes: ChangesFile,
  org: { slug: string; name: string },
): FolderFiles {
  const renamer = new Renamer(changes.renames);
  const deleted = new Set(changes.deletions.map((d) => `${d.type}|${d.fromKey}|${d.toKey}`));
  const keep = (v: unknown): boolean => {
    const id = linkIdOf(v);
    return id === null || !deleted.has(id);
  };
  const json: Record<string, unknown> = {};
  for (const [file, value] of Object.entries(files.json)) {
    if (file === DATASET_FILES.manifest) {
      json[file] = changedManifest(value, changes, org);
      continue;
    }
    // The framework catalogs' own names stay as the catalogs have them.
    const skip =
      file === DATASET_FILES.frameworkMappings
        ? (path: readonly (string | number)[]) =>
            path.length >= 2 && (path[1] === 'requirement' || path[1] === 'alsoReachedThroughNistCrosswalks')
        : undefined;
    let changed = renamer.json(value, skip);
    if (file === DATASET_FILES.facts && Array.isArray(changed)) changed = changed.filter(keep);
    if (file === DATASET_FILES.answerKey) changed = withoutKeyLinks(changed, keep);
    if (file === DATASET_FILES.provenance) changed = withoutProvenanceLinks(changed, keep);
    json[file] = changed;
  }
  const sentencesByFile = new Map<string, string[]>();
  for (const d of changes.deletions) {
    for (const s of d.sentences) sentencesByFile.set(s.file, [...(sentencesByFile.get(s.file) ?? []), s.sentence]);
  }
  const sources = files.sources.map((source): SourceFile => {
    if (!('text' in source.content)) return source;
    const renamedText = renamer.text(source.content.text);
    const sentences = sentencesByFile.get(baseName(source.path)) ?? [];
    const text = removeSentences(renamedText, sentences, baseName(source.path)).text;
    return { path: source.path, content: { text } };
  });
  return { json, sources };
}

function withoutKeyLinks(key: unknown, keep: (v: unknown) => boolean): unknown {
  if (key === null || typeof key !== 'object' || !Array.isArray((key as { orgs?: unknown }).orgs)) return key;
  const k = key as { orgs: unknown[] };
  return {
    ...k,
    orgs: k.orgs.map((org) =>
      org !== null && typeof org === 'object' && Array.isArray((org as { links?: unknown }).links)
        ? { ...org, links: (org as { links: unknown[] }).links.filter(keep) }
        : org,
    ),
  };
}

function withoutProvenanceLinks(provenance: unknown, keep: (v: unknown) => boolean): unknown {
  if (provenance === null || typeof provenance !== 'object') return provenance;
  const p = provenance as { links?: unknown };
  return Array.isArray(p.links) ? { ...p, links: p.links.filter(keep) } : provenance;
}

/** The manifest with the new org and every other field kept, plus a short `changed` note. */
function changedManifest(value: unknown, changes: ChangesFile, org: { slug: string; name: string }): unknown {
  const manifest = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const oldOrg = manifest.org !== null && typeof manifest.org === 'object' ? manifest.org : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    out[k] = k === 'org' ? { ...oldOrg, name: org.name, slug: org.slug } : v;
  }
  if (!('org' in out)) out.org = { name: org.name, slug: org.slug };
  out.changed = {
    fromSlug: changes.from.slug,
    seed: changes.seed,
    renames: changes.renames.length,
    deletions: changes.deletions.length,
    details: CHANGES_FILE,
  };
  return out;
}

/** Every file the changed folder holds besides `sources/`, written as JSON text. */
export function formatFolderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---- The checks ------------------------------------------------------------------------------------

/** One failed check: the file, how many times it failed there, and which check. */
export interface ChangedFolderProblem {
  file: string;
  count: number;
  check: 'old_name_left' | 'deleted_sentence_left' | 'kept_sentence_missing';
}

/** The old names to look for, normalised, each with its control's normalised code, if any. */
function oldNamesOf(changes: ChangesFile): { name: string; after: string | null }[] {
  return changes.renames
    .map((r) => ({ name: normaliseName(r.from), after: r.code !== undefined ? normaliseName(r.code) : null }))
    .filter((o) => o.name !== '');
}

/** How many old names a text holds as whole words, after normalising. */
export function oldNameHits(text: string, olds: readonly { name: string; after: string | null }[]): number {
  if (olds.length === 0) return 0;
  const t = ` ${normaliseName(text)} `;
  let hits = 0;
  for (const old of olds) {
    const needle = ` ${old.name} `;
    for (let at = t.indexOf(needle); at !== -1; at = t.indexOf(needle, at + 1)) {
      if (old.after !== null && old.after !== '' && t.slice(0, at + 1).endsWith(` ${old.after} `)) continue;
      hits += 1;
    }
  }
  return hits;
}

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

function factsOf(value: unknown): { type: string; fromKey: string; toKey: string; statedIn: ChangeSentence[] }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const id = linkIdOf(v);
    const statedIn = (v as { statedIn?: unknown }).statedIn;
    if (id === null || !Array.isArray(statedIn)) return [];
    const sentences = statedIn.filter(
      (s): s is ChangeSentence =>
        s !== null &&
        typeof s === 'object' &&
        typeof (s as ChangeSentence).file === 'string' &&
        typeof (s as ChangeSentence).sentence === 'string',
    );
    const f = v as { type: string; fromKey: string; toKey: string };
    return [{ type: f.type, fromKey: f.fromKey, toKey: f.toKey, statedIn: sentences }];
  });
}

/** The text sources by file name (a name may sit in more than one sub-folder). */
function textsByName(files: FolderFiles): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of files.sources) {
    if (!('text' in s.content)) continue;
    out.set(baseName(s.path), [...(out.get(baseName(s.path)) ?? []), s.content.text]);
  }
  return out;
}

/**
 * The checks on the changed folder's files against the folder they came from (see the top of the
 * file). Problems name the file and a count only, never a name or a sentence (D164).
 */
export function checkChangedFiles(
  before: FolderFiles,
  after: FolderFiles,
  changes: ChangesFile,
): ChangedFolderProblem[] {
  const problems: ChangedFolderProblem[] = [];
  const olds = oldNamesOf(changes);

  // No old name left anywhere.
  for (const [file, value] of Object.entries(after.json)) {
    const hits = stringsOf(value).reduce((sum, s) => sum + oldNameHits(s, olds), 0);
    if (hits > 0) problems.push({ file, count: hits, check: 'old_name_left' });
  }
  for (const source of after.sources) {
    if (!('text' in source.content)) continue;
    const hits = oldNameHits(source.content.text, olds);
    if (hits > 0) problems.push({ file: `sources/${source.path}`, count: hits, check: 'old_name_left' });
  }

  // Every deleted sentence gone from its file.
  const afterTexts = textsByName(after);
  const gone = new Map<string, number>();
  for (const d of changes.deletions) {
    for (const s of d.sentences) {
      const forms = sentenceForms(s.file, s.sentence);
      if ((afterTexts.get(s.file) ?? []).some((t) => forms.some((f) => t.includes(f)))) {
        gone.set(s.file, (gone.get(s.file) ?? 0) + 1);
      }
    }
  }
  for (const [file, count] of gone) problems.push({ file, count, check: 'deleted_sentence_left' });

  // Every kept sentence its file held is still there, exactly (as renamed).
  const renamer = new Renamer(changes.renames);
  const deleted = new Set(changes.deletions.map((d) => `${d.type}|${d.fromKey}|${d.toKey}`));
  const beforeTexts = textsByName(before);
  const missing = new Map<string, number>();
  for (const fact of factsOf(before.json[DATASET_FILES.facts])) {
    if (deleted.has(`${fact.type}|${fact.fromKey}|${fact.toKey}`)) continue;
    for (const s of fact.statedIn) {
      if (s.sentence === '') continue;
      const wasThere = (beforeTexts.get(s.file) ?? []).some((t) =>
        sentenceForms(s.file, s.sentence).some((f) => t.includes(f)),
      );
      if (!wasThere) continue;
      const now = renamer.text(s.sentence);
      const isThere = (afterTexts.get(s.file) ?? []).some((t) => sentenceForms(s.file, now).some((f) => t.includes(f)));
      if (!isThere) missing.set(s.file, (missing.get(s.file) ?? 0) + 1);
    }
  }
  for (const [file, count] of missing) problems.push({ file, count, check: 'kept_sentence_missing' });
  return problems;
}

/** How many sentences the deletions took out of the files. */
export function sentencesRemoved(before: FolderFiles, changes: ChangesFile): number {
  const renamer = new Renamer(changes.renames);
  const byFile = new Map<string, string[]>();
  for (const d of changes.deletions) {
    for (const s of d.sentences) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s.sentence]);
  }
  let removed = 0;
  for (const source of before.sources) {
    if (!('text' in source.content)) continue;
    const sentences = byFile.get(baseName(source.path));
    if (sentences === undefined) continue;
    removed += removeSentences(renamer.text(source.content.text), sentences, baseName(source.path)).removed;
  }
  return removed;
}

// ---- A changed folder's changes, against the folder ------------------------------------------------

/**
 * The problems of a changes file against the folder it sits in: a renamed record that isn't a record
 * of the folder of that kind with the new name, a deleted link whose ends aren't records of the
 * folder with those names or that is still in the answer key, or a `from` slug that is the folder's.
 */
export function checkChangesFitFolder(changes: ChangesFile, folder: DatasetFolder): ChangesFileProblem[] {
  const problems: ChangesFileProblem[] = [];
  const graph = OrgGraph.ofOrg(folder.answerOrg);
  if (changes.from.slug === folder.org.slug) {
    problems.push({ field: 'from.slug', message: "must not be the folder's own slug" });
  }
  changes.renames.forEach((r, i) => {
    const record = graph.record(r.key);
    if (record === undefined || record.kind !== r.kind) {
      problems.push({ field: `renames.${i}.key`, message: `is not a ${r.kind} of the folder's answer key` });
    } else if (record.name !== r.to) {
      problems.push({ field: `renames.${i}.to`, message: "is not the record's name in the folder" });
    }
  });
  changes.deletions.forEach((d, i) => {
    const from = graph.record(d.fromKey);
    const to = graph.record(d.toKey);
    if (from === undefined || from.name !== d.from) {
      problems.push({ field: `deletions.${i}.fromKey`, message: 'is not a record of the folder with that name' });
    }
    if (to === undefined || to.name !== d.to) {
      problems.push({ field: `deletions.${i}.toKey`, message: 'is not a record of the folder with that name' });
    }
    if (graph.hasLink({ type: d.type, fromKey: d.fromKey, toKey: d.toKey })) {
      problems.push({ field: `deletions.${i}`, message: "is still a link of the folder's answer key" });
    }
  });
  return problems;
}
