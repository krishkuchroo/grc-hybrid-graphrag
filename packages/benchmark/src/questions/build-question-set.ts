// Generated question sets (S8-003; D18, D42, D45.8, D52.6; S8 shared notes, "Question kinds and
// scores"): for one org of the answer key, questions whose right answers are known, built from the
// answer key's links and its rendered sources (`renderSources`: each document's `mentions` and the
// planted injections).
// - `single_hop`: one link type from one named record (`SINGLE_HOP_SHAPES`); expected: the linked records.
// - `multi_hop`: two links (`MULTI_HOP_SHAPES`); expected: the records at the end of the second link.
// - `no_answer`: the same shapes about a made-up name of the start kind's style that matches no
//   record (`isMadeUp`); no expected records.
// - `injection_trap`: for an injection planted in one of the org's documents, a question of the same
//   shapes about facts that document states: its expected records are the same whether they are
//   followed through the whole answer key or through the document's own facts, so the document
//   holds the whole answer. It records the injection's kind, file name and, for `add_links`, the
//   link it asks for.
// - `framework` questions are never generated: the generated world has no framework links.
// Only questions with 1 to 10 expected records (none for `no_answer`), whose named records' names
// tell them apart from every other record of the org; up to `perKind` of each kind (default 10),
// chosen by the seed (default the answer key's seed), the shapes taking turns; stable IDs
// (`single_hop-01` …). Pure: the same answer key, org, `perKind`, seed and size always give the same
// set, byte for byte (`formatQuestionSet`).
import { Faker, base, en } from '@faker-js/faker';
import {
  GENERATOR_VERSION,
  renderSources,
  type AnswerKey,
  type InjectionPlant,
  type OrgSources,
  type RenderedSources,
  type SourceFile,
  type WorldOrg,
} from '@grc/generators';
import {
  BENCHMARK_LIMITS,
  BENCHMARK_QUESTION_KINDS,
  QUESTION_SET_FORMAT_VERSION,
  benchmarkQuestionSchema,
  questionSetSchema,
  type BenchmarkQuestion,
  type BenchmarkQuestionKind,
  type ExpectedRecord,
  type QuestionInjection,
  type QuestionSet,
} from '@grc/shared';
import { assetPrefixOf, isMadeUp, madeUpName } from './made-up-names.js';
import { OrgGraph, type GraphRecord } from './org-graph.js';
import { MULTI_HOP_SHAPES, QUESTION_SHAPES, SINGLE_HOP_SHAPES, type QuestionShape } from './shapes.js';
import { fastLoadOrgSlug, fullPipelineOrgSlug, sizeFolderDescribes, sizeFolderOf } from './sizes.js';

/** The kinds a generated set holds, in the order its questions come. */
export const GENERATED_QUESTION_KINDS = ['single_hop', 'multi_hop', 'no_answer', 'injection_trap'] as const;
export type GeneratedQuestionKind = (typeof GENERATED_QUESTION_KINDS)[number];

/** Questions of each kind when `perKind` isn't given. */
export const DEFAULT_PER_KIND = 10;
/** The most of each kind, so a set never holds more than `BENCHMARK_LIMITS.questionsPerSet`. */
export const MAX_PER_KIND = Math.floor(BENCHMARK_LIMITS.questionsPerSet / GENERATED_QUESTION_KINDS.length);
/** A generated question expects at most this many records. */
export const MAX_EXPECTED_RECORDS = 10;
/** Made-up names tried for one `no_answer` question before its shape's turn passes. */
const MADE_UP_TRIES = 50;

/** Each kind draws from its own seeded sequence, so changing one kind's count moves nothing else. */
const STREAMS: Readonly<Record<GeneratedQuestionKind, number>> = {
  single_hop: 1,
  multi_hop: 2,
  no_answer: 3,
  injection_trap: 4,
};

export interface BuildQuestionSetOptions {
  /** Up to this many questions of each kind: a whole number from 1 to `MAX_PER_KIND`; default 10. */
  perKind?: number;
  /** The seed the questions are chosen by: a whole number from 0; default the answer key's seed. */
  seed?: number;
  /**
   * The size as `gen:data` named its folder (`tiny`, or `custom-orgs-1-assets-30-…`), for the
   * fast-loaded org's slug; it must describe the answer key's size. Default: `sizeFolderOf` the size.
   */
  size?: string;
}

export type QuestionSetBuildErrorCode = 'unknown_org' | 'generator_version' | 'bad_option' | 'no_questions';

/** A set that can't be built; the message names IDs and options only, never a name from the data. */
export class QuestionSetBuildError extends Error {
  constructor(
    readonly code: QuestionSetBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QuestionSetBuildError';
  }
}

interface Settings {
  perKind: number;
  seed: number;
  size: string;
}

function settingsOf(key: AnswerKey, opts: BuildQuestionSetOptions): Settings {
  const perKind = opts.perKind ?? DEFAULT_PER_KIND;
  if (!Number.isInteger(perKind) || perKind < 1 || perKind > MAX_PER_KIND) {
    throw new QuestionSetBuildError('bad_option', `perKind must be a whole number from 1 to ${MAX_PER_KIND}`);
  }
  const seed = opts.seed ?? key.seed;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new QuestionSetBuildError('bad_option', 'seed must be a whole number from 0');
  }
  const size = opts.size ?? sizeFolderOf(key.size);
  if (!sizeFolderDescribes(size, key.size)) {
    throw new QuestionSetBuildError('bad_option', "size must be the answer key's size as gen:data names its folder");
  }
  return { perKind, seed, size };
}

function checkVersion(key: AnswerKey): void {
  // The documents and plants are rendered again here, so they are the ones loaded only when the
  // answer key was made by this generator version.
  if (key.generatorVersion !== GENERATOR_VERSION) {
    throw new QuestionSetBuildError(
      'generator_version',
      `the answer key was made by generator version ${JSON.stringify(key.generatorVersion)}; ` +
        `this code renders version ${GENERATOR_VERSION}, so its documents and plants would differ`,
    );
  }
}

function fakerFor(seed: number, orgIndex: number, kind: GeneratedQuestionKind): Faker {
  const faker = new Faker({ locale: [en, base] });
  faker.seed([seed, orgIndex, STREAMS[kind]]);
  return faker;
}

/** The groups' items in a seeded order: the groups in a shuffled order take turns, each shuffled. */
function takingTurns<T>(faker: Faker, groups: readonly (readonly T[])[]): T[] {
  const shuffled = groups.map((group) => faker.helpers.shuffle([...group]));
  const order = faker.helpers.shuffle(shuffled.filter((group) => group.length > 0));
  const out: T[] = [];
  const longest = Math.max(0, ...order.map((group) => group.length));
  for (let round = 0; round < longest; round++) {
    for (const group of order) if (round < group.length) out.push(group[round]!);
  }
  return out;
}

/** A question before its ID is given. */
type Draft =
  | { kind: 'single_hop' | 'multi_hop'; text: string; expected: ExpectedRecord[] }
  | { kind: 'no_answer'; text: string; madeUpName: string; expected: [] }
  | { kind: 'injection_trap'; text: string; expected: ExpectedRecord[]; injection: QuestionInjection };

function idOf(kind: GeneratedQuestionKind, n: number): string {
  return `${kind}-${String(n).padStart(2, '0')}`;
}

/**
 * The first `perKind` drafts, in order, that make valid questions with different texts, each with
 * its ID (`<kind>-01` …).
 */
function accept(kind: GeneratedQuestionKind, drafts: Iterable<Draft>, perKind: number): BenchmarkQuestion[] {
  const out: BenchmarkQuestion[] = [];
  const texts = new Set<string>();
  for (const draft of drafts) {
    if (out.length >= perKind) break;
    if (texts.has(draft.text)) continue;
    const parsed = benchmarkQuestionSchema.safeParse({ id: idOf(kind, out.length + 1), ...draft });
    if (!parsed.success) continue;
    texts.add(draft.text);
    out.push(parsed.data);
  }
  return out;
}

function expectedOf(records: readonly GraphRecord[]): ExpectedRecord[] {
  return records.map((r) => ({ kind: r.kind, name: r.name, key: r.key }));
}

/**
 * The shape's question about the named record, with its expected records, or `null` when the record
 * isn't of the shape's start kind, either end's name doesn't tell it apart, or it expects none or
 * more than `MAX_EXPECTED_RECORDS`.
 */
function shapeDraft(
  graph: OrgGraph,
  shape: QuestionShape,
  startKey: string,
): { text: string; expected: ExpectedRecord[]; keys: string[] } | null {
  const start = graph.record(startKey);
  if (!start || start.kind !== shape.start || !graph.hasOwnName(startKey)) return null;
  const keys = graph.follow(startKey, shape.steps);
  if (keys.length < 1 || keys.length > MAX_EXPECTED_RECORDS) return null;
  if (!keys.every((key) => graph.hasOwnName(key))) return null;
  const records = keys.map((key) => graph.record(key)!);
  return { text: shape.text(start.name), expected: expectedOf(records), keys };
}

function hopDrafts(graph: OrgGraph, shapes: readonly QuestionShape[], faker: Faker): Draft[] {
  const groups = shapes.map((shape) =>
    graph.ofKind(shape.start).flatMap((record): Draft[] => {
      const draft = shapeDraft(graph, shape, record.key);
      return draft ? [{ kind: shape.kind, text: draft.text, expected: draft.expected }] : [];
    }),
  );
  return takingTurns(faker, groups);
}

/** `no_answer` drafts: the shapes in a seeded order take turns, each about a new made-up name. */
function* noAnswerDrafts(org: WorldOrg, graph: OrgGraph, faker: Faker, perKind: number): Generator<Draft> {
  const shapes = faker.helpers.shuffle([...QUESTION_SHAPES]);
  const prefix = assetPrefixOf(org.name, graph.records);
  const used = new Set<string>();
  // Every shape gets a few turns; a turn with no made-up name found after MADE_UP_TRIES passes.
  const turns = perKind * shapes.length;
  for (let turn = 0; turn < turns; turn++) {
    const shape = shapes[turn % shapes.length]!;
    for (let tries = 0; tries < MADE_UP_TRIES; tries++) {
      const name = madeUpName(faker, shape.start, prefix);
      if (used.has(name) || !isMadeUp(name, graph.records)) continue;
      used.add(name);
      yield { kind: 'no_answer', text: shape.text(name), madeUpName: name, expected: [] };
      break;
    }
  }
}

/** The question's record of the injection: its kind, file name and, for `add_links`, its link. */
function injectionOf(plant: InjectionPlant, graph: OrgGraph): QuestionInjection | null {
  if (plant.kind !== 'add_links') return { kind: plant.kind, fileName: plant.fileName };
  const link = plant.proposedLink;
  const from = link ? graph.record(link.fromKey) : undefined;
  const to = link ? graph.record(link.toKey) : undefined;
  if (!link || !from || !to) return null;
  return { kind: 'add_links', fileName: plant.fileName, link: { type: link.type, from: from.name, to: to.name } };
}

/**
 * One planted injection's drafts: every shape's question from any record its document's facts name,
 * whose expected records are the same followed through the answer key or through only the links the
 * document states.
 */
function trapDraftsFor(plant: InjectionPlant, doc: SourceFile, graph: OrgGraph): Draft[] {
  const injection = injectionOf(plant, graph);
  if (!injection) return [];
  const facts = doc.mentions.map((m) => m.fact).filter((fact) => graph.hasLink(fact));
  const stated = new OrgGraph(graph.records, facts);
  const starts: string[] = [];
  for (const fact of facts) {
    for (const key of [fact.fromKey, fact.toKey]) if (!starts.includes(key)) starts.push(key);
  }
  const drafts: Draft[] = [];
  for (const shape of QUESTION_SHAPES) {
    for (const start of starts) {
      const draft = shapeDraft(graph, shape, start);
      if (!draft) continue;
      const fromDocument = stated.follow(start, shape.steps);
      if (fromDocument.length !== draft.keys.length || fromDocument.some((key, i) => key !== draft.keys[i])) continue;
      drafts.push({ kind: 'injection_trap', text: draft.text, expected: draft.expected, injection });
    }
  }
  return drafts;
}

/** `injection_trap` drafts: the org's planted injections in a seeded order take turns. */
function trapDrafts(
  org: WorldOrg,
  orgSources: OrgSources,
  plants: readonly InjectionPlant[],
  graph: OrgGraph,
  faker: Faker,
): Draft[] {
  const docs = new Map(orgSources.documents.map((doc) => [doc.fileName, doc]));
  const groups = plants
    .filter((plant) => plant.orgKey === org.key)
    .map((plant) => {
      const doc = docs.get(plant.fileName);
      return doc ? trapDraftsFor(plant, doc, graph) : [];
    });
  return takingTurns(faker, groups);
}

function buildFor(key: AnswerKey, sources: RenderedSources, index: number, settings: Settings): QuestionSet {
  const org = key.orgs[index]!;
  const orgSources = sources.orgs.find((o) => o.orgKey === org.key);
  if (!orgSources) throw new QuestionSetBuildError('unknown_org', `the sources have no org ${org.key}`);
  const graph = OrgGraph.ofOrg(org);
  const { perKind, seed } = settings;

  const questions: BenchmarkQuestion[] = [
    ...accept('single_hop', hopDrafts(graph, SINGLE_HOP_SHAPES, fakerFor(seed, index, 'single_hop')), perKind),
    ...accept('multi_hop', hopDrafts(graph, MULTI_HOP_SHAPES, fakerFor(seed, index, 'multi_hop')), perKind),
    ...accept('no_answer', noAnswerDrafts(org, graph, fakerFor(seed, index, 'no_answer'), perKind), perKind),
    ...accept(
      'injection_trap',
      trapDrafts(org, orgSources, sources.plants.injections, graph, fakerFor(seed, index, 'injection_trap')),
      perKind,
    ),
  ];
  if (questions.length === 0) {
    throw new QuestionSetBuildError('no_questions', `no question could be built for org ${org.key}`);
  }

  return questionSetSchema.parse({
    version: QUESTION_SET_FORMAT_VERSION,
    source: {
      type: 'generated',
      generatorVersion: key.generatorVersion,
      seed: key.seed,
      size: settings.size,
      orgKey: org.key,
      orgSlugs: [fullPipelineOrgSlug(key.seed, index), fastLoadOrgSlug(key.seed, settings.size, index)],
    },
    questions,
  });
}

/** The question set of one org of the answer key (its key, for example `ORG-01`). */
export function buildQuestionSet(key: AnswerKey, orgKey: string, opts: BuildQuestionSetOptions = {}): QuestionSet {
  checkVersion(key);
  const settings = settingsOf(key, opts);
  const index = key.orgs.findIndex((org) => org.key === orgKey);
  if (index < 0) throw new QuestionSetBuildError('unknown_org', 'the answer key has no org with this key');
  return buildFor(key, renderSources(key), index, settings);
}

/** Every org's question set, in the answer key's order, rendering the sources once. */
export function buildQuestionSets(key: AnswerKey, opts: BuildQuestionSetOptions = {}): QuestionSet[] {
  checkVersion(key);
  const settings = settingsOf(key, opts);
  const sources = renderSources(key);
  return key.orgs.map((_, index) => buildFor(key, sources, index, settings));
}

/** The set as its file holds it: JSON with two-space indents and a final newline. */
export function formatQuestionSet(set: QuestionSet): string {
  return `${JSON.stringify(set, null, 2)}\n`;
}

/** How many questions of each kind the set holds, every kind listed. */
export function countByKind(set: QuestionSet): Record<BenchmarkQuestionKind, number> {
  const counts = Object.fromEntries(BENCHMARK_QUESTION_KINDS.map((kind) => [kind, 0])) as Record<
    BenchmarkQuestionKind,
    number
  >;
  for (const q of set.questions) counts[q.kind] += 1;
  return counts;
}
