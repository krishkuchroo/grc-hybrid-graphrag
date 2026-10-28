// The generated evaluation set (EV-001; D1, D45.8, D52.6, D261 track A, items 1 and 2): from a
// dataset folder's answer key, a question set `pnpm bench:run` runs as it is, and its checks file
// (each question's fact, fine kind, wording, target kinds and correct graph query).
// - Facts, from the answer key through `OrgGraph`, as `build-company-x.ts` builds the hand-written
//   set: `mitigated_by` (a risk → its controls), `impacts` (an asset → the incidents that impacted
//   it), `governs` (a policy → the controls it governs), `two_step` (asset → risks → controls,
//   incident → risks → controls, risk → controls → policies, taking turns), `framework` (a control →
//   its 800-53 requirement and the CSF and ISO ones NIST's crosswalks reach), `no_answer` (a made-up
//   risk or asset, alternating) and `injection` (one per planted injection whose document is in the
//   folder). A fact's start record's name tells it apart (`hasOwnName`), and its count of expected
//   records is within its kind's bounds (`EVAL_EXPECTED_BOUNDS`).
// - The mix: the fixed templates first (`FIXED_QUESTIONS`), then `floor((count − fixed) / 3)`
//   groups of three wordings, shared out by `EVAL_MIX`'s weights; a kind short of facts takes all
//   it has and the rest passes round-robin to `SHORTFALL_ORDER`'s kinds while they have facts left.
//   Within a kind the facts come in a seeded order, each kind on its own stream (`EVAL_STREAMS`).
// - Every text in the set is distinct: a group whose texts aren't is dropped and the next fact taken.
// Pure: the same folder, extras, count and seed always give the same set and checks, byte for byte
// (`formatQuestionSet`, `formatEvalChecks`).
import { Faker, base, en } from '@faker-js/faker';
import {
  QUESTION_SET_FORMAT_VERSION,
  SEARCH_LINK_TYPES,
  answerKeyKeySchema,
  benchmarkFileNameSchema,
  benchmarkQuestionSchema,
  benchmarkRecordNameSchema,
  questionSetSchema,
  type BenchmarkQuestion,
  type ExpectedRecord,
  type QuestionInjection,
  type QuestionSet,
  type RecordKind,
  type SearchLinkType,
  type SearchRecordKind,
} from '@grc/shared';
import { z } from 'zod';
import {
  DATASET_FILES,
  DatasetFolderError,
  fastOrgSlugOf,
  type DatasetFolder,
  type DatasetFolderProblem,
} from '../dataset/folder.js';
import { fieldOf } from '../questions/answer-key.js';
import { assetPrefixOf, isMadeUp, madeUpName } from '../questions/made-up-names.js';
import { OrgGraph, compareKeys, type LinkStep } from '../questions/org-graph.js';
import {
  EVAL_CHECKS_FORMAT_VERSION,
  evalChecksSchema,
  type EvalCheckQuestion,
  type EvalChecks,
} from './checks-file.js';
import { FIXED_QUESTIONS, type FixedQuestion } from './fixed-questions.js';
import {
  exposedToQuery,
  frameworkQuery,
  governsQuery,
  impactsQuery,
  mitigatedByQuery,
  twoStepQuery,
  type TwoStepShape,
} from './gold-queries.js';
import {
  EVAL_EXPECTED_BOUNDS,
  EVAL_MAX_COUNT,
  EVAL_MIN_COUNT,
  EVAL_MIX,
  EVAL_QUESTION_KINDS,
  EVAL_SET_KIND,
  EVAL_STREAMS,
  EVAL_WORDINGS,
  GROUP_WORDINGS,
  SHORTFALL_ORDER,
  evalGroupId,
  evalQuestionId,
  evalShares,
  fixedGroupId,
  type EvalQuestionKind,
  type EvalWording,
  type GeneratedEvalKind,
} from './kinds.js';
import { groupTexts, shortFormOf, type WordingShape } from './wordings.js';

/** The injection kinds a question can carry. */
const INJECTION_KINDS = [
  'ignore_instructions',
  'leak_data',
  'add_links',
] as const satisfies readonly QuestionInjection['kind'][];

/** A planted injection, as `plants.json` gives it (only these fields are read). */
export interface EvalPlant {
  kind: QuestionInjection['kind'];
  fileName: string;
  /** For `add_links`: the link the injection asks for, by its ends' names. */
  link?: { type: SearchLinkType; from: string; to: string };
}

/** What the generator reads besides the folder `readDatasetFolder` gives. */
export interface EvalExtra {
  /**
   * Per control key, the requirement names it reaches: each `framework-mappings.json` row's own
   * requirement name, then its `alsoReachedThroughNistCrosswalks`.
   */
  crosswalks: ReadonlyMap<string, readonly string[]>;
  plants: readonly EvalPlant[];
}

/** The folder's file of planted injections (not one `readDatasetFolder` reads). */
export const EVAL_PLANTS_FILE = 'plants.json';

const frameworkMappingRows = z.array(
  z.object({
    controlKey: answerKeyKeySchema,
    requirement: z.object({ name: benchmarkRecordNameSchema }),
    alsoReachedThroughNistCrosswalks: z.array(benchmarkRecordNameSchema).optional(),
  }),
);

const plantRows = z.array(
  z.object({
    kind: z.enum(INJECTION_KINDS),
    fileName: benchmarkFileNameSchema,
    link: z
      .object({ type: z.enum(SEARCH_LINK_TYPES), from: benchmarkRecordNameSchema, to: benchmarkRecordNameSchema })
      .optional(),
  }),
);

/**
 * The extras from the parsed `framework-mappings.json` and `plants.json`, reading only
 * `[{ controlKey, requirement: { name }, alsoReachedThroughNistCrosswalks? }]` and
 * `[{ kind, fileName, link?: { type, from, to } }]` (other fields are left alone). Throws a
 * `DatasetFolderError` naming each file and field that's wrong, never a value.
 */
export function parseEvalExtra(frameworkMappings: unknown, plants: unknown): EvalExtra {
  const problems: DatasetFolderProblem[] = [];
  const parse = <T>(file: string, schema: z.ZodType<T>, value: unknown): T | null => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues)
      problems.push({ file, field: fieldOf(issue.path), message: issue.message });
    return null;
  };
  const mappings = parse(DATASET_FILES.frameworkMappings, frameworkMappingRows, frameworkMappings);
  const plantList = parse(EVAL_PLANTS_FILE, plantRows, plants);
  if (mappings === null || plantList === null) throw new DatasetFolderError(problems);
  const crosswalks = new Map<string, string[]>();
  for (const row of mappings) {
    const names = crosswalks.get(row.controlKey) ?? [];
    names.push(row.requirement.name, ...(row.alsoReachedThroughNistCrosswalks ?? []));
    crosswalks.set(row.controlKey, names);
  }
  return {
    crosswalks,
    plants: plantList.map((p) => ({
      kind: p.kind,
      fileName: p.fileName,
      ...(p.link !== undefined ? { link: { type: p.link.type, from: p.link.from, to: p.link.to } } : {}),
    })),
  };
}

export interface EvalSetOptions {
  /** Questions asked for: a whole number from `EVAL_MIN_COUNT` to `EVAL_MAX_COUNT`. */
  count: number;
  /** A whole number from 0. */
  seed: number;
  /** The fixed templates; default `FIXED_QUESTIONS`. */
  fixed?: readonly FixedQuestion[];
}

/** Why a group was dropped: its texts weren't distinct (among themselves or from earlier ones), or a
 * question didn't fit the question-set format. */
export const EVAL_DROP_REASONS = ['same_texts', 'invalid'] as const;
export type EvalDropReason = (typeof EVAL_DROP_REASONS)[number];

/** What was written, counts only (D164). */
export interface EvalSetCounts {
  /** Questions asked for. */
  asked: number;
  /** Questions written. */
  questions: number;
  /** Generated groups asked for: `floor((asked − fixed written) / 3)`. */
  groupsWanted: number;
  /** Generated groups written. */
  groups: number;
  /** Questions per fine kind. */
  perKind: Record<EvalQuestionKind, number>;
  /** Questions per wording. */
  perWording: Record<EvalWording, number>;
  /** Each kind's share of the groups, by weight. */
  shares: Record<GeneratedEvalKind, number>;
  /** Groups written per kind (its share, less a shortfall, plus what was passed on to it). */
  groupsPerKind: Record<GeneratedEvalKind, number>;
  /** The kinds that made fewer groups than their share. */
  shortfalls: { kind: GeneratedEvalKind; share: number; made: number }[];
  /** Groups each kind took over from a shortfall. */
  passedOn: Record<GeneratedEvalKind, number>;
  /** Groups no kind could make. */
  unfilled: number;
  /** Groups dropped, by reason. */
  dropped: Record<EvalDropReason, number>;
  fixed: { written: number; leftOut: number };
}

export type EvalSetBuildErrorCode = 'bad_option' | 'no_questions';

/** A set that can't be built; the message names options and counts only, never a name. */
export class EvalSetBuildError extends Error {
  constructor(
    readonly code: EvalSetBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvalSetBuildError';
  }
}

/** Made-up names tried for one `no_answer` fact before the kind counts as out of facts. */
const MADE_UP_TRIES = 50;
/** The most made-up names one set draws, so a run always ends. */
const MAX_MADE_UP_FACTS = 1_000;

/** One fact, ready to be worded. */
interface Fact {
  kind: GeneratedEvalKind;
  shape: WordingShape;
  /** The start record's name, or the made-up name. */
  name: string;
  /** The name's short form, or the made-up name as it is. */
  short: string;
  expected: ExpectedRecord[];
  targetKinds: SearchRecordKind[];
  goldQuery: string;
  madeUpName?: string;
  injection?: QuestionInjection;
}

/** One group's questions and their checks, before its ID is given. */
interface Draft {
  kind: GeneratedEvalKind;
  texts: Record<(typeof GROUP_WORDINGS)[number], string>;
  fact: Fact;
}

function fakerFor(seed: number, stream: number, part: number): Faker {
  const faker = new Faker({ locale: [en, base] });
  faker.seed([seed, stream, part]);
  return faker;
}

function within(n: number, [lo, hi]: readonly [number, number]): boolean {
  return n >= lo && n <= hi;
}

const OUT = (type: LinkStep['types'][number]): LinkStep => ({ types: [type], direction: 'out' });
const IN = (type: LinkStep['types'][number]): LinkStep => ({ types: [type], direction: 'in' });

/** The facts of one link pattern from each record of `start`'s kind, in the answer key's order. */
function linkFacts(
  graph: OrgGraph,
  kind: 'mitigated_by' | 'impacts' | 'governs' | 'two_step',
  shape: WordingShape,
  start: RecordKind,
  steps: readonly LinkStep[],
  target: RecordKind,
  query: (name: string) => string,
): Fact[] {
  const names = graph.ofKind(start).map((r) => r.name);
  const facts: Fact[] = [];
  for (const record of graph.ofKind(start)) {
    if (!graph.hasOwnName(record.key)) continue;
    const keys = graph.follow(record.key, steps);
    if (!within(keys.length, EVAL_EXPECTED_BOUNDS[kind])) continue;
    facts.push({
      kind,
      shape,
      name: record.name,
      short: shortFormOf(record.name, names),
      expected: keys.map((key) => {
        const r = graph.record(key)!;
        return { kind: r.kind, name: r.name, key: r.key };
      }),
      targetKinds: [target],
      goldQuery: query(record.name),
    });
  }
  return facts;
}

const TWO_STEP: Readonly<
  Record<TwoStepShape, { shape: WordingShape; steps: readonly LinkStep[]; target: RecordKind }>
> = Object.freeze({
  asset: { shape: 'two_step:asset', steps: [OUT('EXPOSED_TO'), OUT('MITIGATED_BY')], target: 'control' },
  incident: { shape: 'two_step:incident', steps: [OUT('EXPOSES'), OUT('MITIGATED_BY')], target: 'control' },
  risk: { shape: 'two_step:risk', steps: [OUT('MITIGATED_BY'), OUT('GOVERNED_BY')], target: 'policy' },
});

/** The groups' items in a seeded order: the groups, in a shuffled order, take turns, each shuffled. */
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

function frameworkFacts(graph: OrgGraph, crosswalks: ReadonlyMap<string, readonly string[]>): Fact[] {
  const names = graph.ofKind('control').map((r) => r.name);
  const facts: Fact[] = [];
  for (const control of graph.ofKind('control')) {
    const reached = crosswalks.get(control.key);
    if (reached === undefined || !graph.hasOwnName(control.key)) continue;
    const distinct = [...new Set(reached.map((name) => name.trim()).filter((name) => name !== ''))];
    if (!within(distinct.length, EVAL_EXPECTED_BOUNDS.framework)) continue;
    facts.push({
      kind: 'framework',
      shape: 'framework',
      name: control.name,
      short: shortFormOf(control.name, names),
      expected: distinct.map((name) => ({ kind: 'requirement', name })),
      targetKinds: ['requirement'],
      goldQuery: frameworkQuery(control.name),
    });
  }
  return facts;
}

/** The asset an injection's question asks about, or null when there is none. */
function injectionAsset(plant: EvalPlant, folder: DatasetFolder, graph: OrgGraph): string | null {
  const assets = graph.ofKind('asset');
  if (plant.kind === 'add_links') {
    const from = plant.link?.from;
    return from === undefined ? null : (assets.find((a) => a.name === from)?.key ?? null);
  }
  // The asset with the most EXPOSED_TO facts stated in the plant's file; on a tie, the first key.
  const stated = new Map<string, number>();
  for (const fact of folder.facts) {
    if (fact.type !== 'EXPOSED_TO' || !fact.statedIn.some((s) => s.file === plant.fileName)) continue;
    stated.set(fact.fromKey, (stated.get(fact.fromKey) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const key of [...stated.keys()].sort(compareKeys)) {
    if (best === null || stated.get(key)! > stated.get(best)!) best = key;
  }
  return best;
}

function injectionFacts(folder: DatasetFolder, plants: readonly EvalPlant[], graph: OrgGraph): Fact[] {
  const files = new Set(folder.documents.map((d) => d.file));
  const names = graph.ofKind('asset').map((r) => r.name);
  const facts: Fact[] = [];
  for (const plant of plants) {
    if (!files.has(plant.fileName)) continue;
    if (plant.kind === 'add_links' && plant.link === undefined) continue;
    const key = injectionAsset(plant, folder, graph);
    if (key === null || !graph.hasOwnName(key)) continue;
    const asset = graph.record(key)!;
    const keys = graph.follow(key, [OUT('EXPOSED_TO')]);
    if (!within(keys.length, EVAL_EXPECTED_BOUNDS.injection)) continue;
    const injection: QuestionInjection =
      plant.kind === 'add_links'
        ? { kind: 'add_links', fileName: plant.fileName, link: plant.link! }
        : { kind: plant.kind, fileName: plant.fileName };
    facts.push({
      kind: 'injection',
      shape: 'injection',
      name: asset.name,
      short: shortFormOf(asset.name, names),
      expected: keys.map((k) => {
        const r = graph.record(k)!;
        return { kind: r.kind, name: r.name, key: r.key };
      }),
      targetKinds: ['risk'],
      goldQuery: exposedToQuery(asset.name),
      injection,
    });
  }
  return facts;
}

/** `no_answer` facts: made-up names, a risk then an asset in turn, each new and matching no record. */
function* noAnswerFacts(folder: DatasetFolder, graph: OrgGraph, faker: Faker): Generator<Fact> {
  const prefix = assetPrefixOf(folder.answerOrg.name, graph.records);
  const used = new Set<string>();
  for (let n = 0; n < MAX_MADE_UP_FACTS; n++) {
    const kind: RecordKind = n % 2 === 0 ? 'risk' : 'asset';
    let name: string | null = null;
    for (let tries = 0; tries < MADE_UP_TRIES && name === null; tries++) {
      const candidate = madeUpName(faker, kind, prefix);
      if (!used.has(candidate) && isMadeUp(candidate, graph.records)) name = candidate;
    }
    if (name === null) return;
    used.add(name);
    yield kind === 'risk'
      ? {
          kind: 'no_answer',
          shape: 'no_answer:risk',
          name,
          short: name,
          expected: [],
          targetKinds: ['control'],
          goldQuery: mitigatedByQuery(name),
          madeUpName: name,
        }
      : {
          kind: 'no_answer',
          shape: 'no_answer:asset',
          name,
          short: name,
          expected: [],
          targetKinds: ['risk'],
          goldQuery: exposedToQuery(name),
          madeUpName: name,
        };
  }
}

/** Each kind's facts, in its seeded order. */
function factSources(
  folder: DatasetFolder,
  extra: EvalExtra,
  graph: OrgGraph,
  seed: number,
): Record<GeneratedEvalKind, Iterator<Fact>> {
  const shuffle = (kind: GeneratedEvalKind, facts: Fact[]): Iterator<Fact> =>
    fakerFor(seed, EVAL_STREAMS[kind], 0).helpers.shuffle(facts)[Symbol.iterator]();
  const twoStep = (['asset', 'incident', 'risk'] as const).map((start) =>
    linkFacts(graph, 'two_step', TWO_STEP[start].shape, start, TWO_STEP[start].steps, TWO_STEP[start].target, (n) =>
      twoStepQuery(start, n),
    ),
  );
  return {
    mitigated_by: shuffle(
      'mitigated_by',
      linkFacts(graph, 'mitigated_by', 'mitigated_by', 'risk', [OUT('MITIGATED_BY')], 'control', mitigatedByQuery),
    ),
    impacts: shuffle(
      'impacts',
      linkFacts(graph, 'impacts', 'impacts', 'asset', [IN('IMPACTS')], 'incident', impactsQuery),
    ),
    governs: shuffle(
      'governs',
      linkFacts(graph, 'governs', 'governs', 'policy', [IN('GOVERNED_BY')], 'control', governsQuery),
    ),
    two_step: takingTurns(fakerFor(seed, EVAL_STREAMS.two_step, 0), twoStep)[Symbol.iterator](),
    framework: shuffle('framework', frameworkFacts(graph, extra.crosswalks)),
    no_answer: noAnswerFacts(folder, graph, fakerFor(seed, EVAL_STREAMS.no_answer, 0)),
    injection: shuffle('injection', injectionFacts(folder, extra.plants, graph)),
  };
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

const GENERATED_KINDS = EVAL_MIX.map((row) => row.kind);

function checkOptions(opts: EvalSetOptions): void {
  if (!Number.isInteger(opts.count) || opts.count < EVAL_MIN_COUNT || opts.count > EVAL_MAX_COUNT) {
    throw new EvalSetBuildError(
      'bad_option',
      `count must be a whole number from ${EVAL_MIN_COUNT} to ${EVAL_MAX_COUNT} (the question-set limit)`,
    );
  }
  if (!Number.isSafeInteger(opts.seed) || opts.seed < 0) {
    throw new EvalSetBuildError('bad_option', 'seed must be a whole number from 0');
  }
}

/** The question of one wording of a fact, or null when it doesn't fit the format. */
function questionOf(fact: Fact, id: string, text: string): BenchmarkQuestion | null {
  const parsed = benchmarkQuestionSchema.safeParse({
    id,
    kind: EVAL_SET_KIND[fact.kind],
    text,
    expected: fact.expected,
    ...(fact.madeUpName !== undefined ? { madeUpName: fact.madeUpName } : {}),
    ...(fact.injection !== undefined ? { injection: fact.injection } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A fixed template's question and its check, or null when it can't be asked of this folder: a key
 * or an expected record that isn't a record of the folder, no target kind, or a question that
 * doesn't fit the format.
 */
function fixedQuestionOf(
  fq: FixedQuestion,
  graph: OrgGraph,
): { question: BenchmarkQuestion; check: EvalCheckQuestion } | null {
  const nameOf = (key: string): string => {
    const record = graph.record(key);
    if (record === undefined) throw new Error('not a record of the folder');
    return record.name;
  };
  try {
    const expected = fq.expected(graph).map((e) => ({ kind: e.kind, name: nameOf(e.key), key: e.key }));
    const goldQuery = fq.goldQuery(nameOf);
    const group = fixedGroupId(fq.name);
    const parsed = benchmarkQuestionSchema.safeParse({
      id: evalQuestionId(group, 'reported'),
      kind: fq.setKind,
      text: fq.text,
      expected,
    });
    if (!parsed.success || fq.targetKinds.length === 0) return null;
    return {
      question: parsed.data,
      check: {
        id: parsed.data.id,
        group,
        kind: 'fixed',
        wording: 'reported',
        targetKinds: [...fq.targetKinds],
        goldQuery,
        forbidden: [],
      },
    };
  } catch {
    return null;
  }
}

/** The set, its checks and the counts, for a dataset folder (see the top of the file). */
export function buildEvalSet(
  folder: DatasetFolder,
  extra: EvalExtra,
  opts: EvalSetOptions,
): { set: QuestionSet; checks: EvalChecks; counts: EvalSetCounts } {
  checkOptions(opts);
  const { count, seed } = opts;
  const graph = OrgGraph.ofOrg(folder.answerOrg);
  const texts = new Set<string>();
  const questions: BenchmarkQuestion[] = [];
  const checks: EvalCheckQuestion[] = [];

  // ---- The fixed templates first ---------------------------------------------------------------
  let fixedLeftOut = 0;
  for (const fq of opts.fixed ?? FIXED_QUESTIONS) {
    if (questions.length >= count || !fq.keys.every((key) => graph.record(key) !== undefined)) {
      fixedLeftOut += 1;
      continue;
    }
    const made = fixedQuestionOf(fq, graph);
    if (made === null || texts.has(made.question.text)) {
      fixedLeftOut += 1;
      continue;
    }
    texts.add(made.question.text);
    questions.push(made.question);
    checks.push(made.check);
  }
  const fixedWritten = questions.length;

  // ---- The generated groups --------------------------------------------------------------------
  const groupsWanted = Math.max(0, Math.floor((count - fixedWritten) / GROUP_WORDINGS.length));
  const shares = evalShares(groupsWanted);
  const sources = factSources(folder, extra, graph, seed);
  const wordingFakers = Object.fromEntries(
    GENERATED_KINDS.map((kind) => [kind, fakerFor(seed, EVAL_STREAMS[kind], 1)]),
  ) as Record<GeneratedEvalKind, Faker>;
  const drafts = Object.fromEntries(GENERATED_KINDS.map((kind) => [kind, [] as Draft[]])) as Record<
    GeneratedEvalKind,
    Draft[]
  >;
  const dropped = zeroes(EVAL_DROP_REASONS);

  /** Up to `n` more groups of the kind; how many were made. */
  const take = (kind: GeneratedEvalKind, n: number): number => {
    let made = 0;
    while (made < n) {
      const next = sources[kind].next();
      if (next.done) break;
      const fact = next.value;
      const worded = groupTexts(fact.shape, fact.name, fact.short, wordingFakers[kind]);
      const all = GROUP_WORDINGS.map((w) => worded[w].trim());
      if (new Set(all).size !== all.length || all.some((t) => texts.has(t))) {
        dropped.same_texts += 1;
        continue;
      }
      if (GROUP_WORDINGS.some((w) => questionOf(fact, evalQuestionId('check', w), worded[w]) === null)) {
        dropped.invalid += 1;
        continue;
      }
      for (const t of all) texts.add(t);
      drafts[kind].push({ kind, texts: worded, fact });
      made += 1;
    }
    return made;
  };

  const shortfalls: EvalSetCounts['shortfalls'] = [];
  let deficit = 0;
  for (const kind of GENERATED_KINDS) {
    const made = take(kind, shares[kind]);
    if (made < shares[kind]) {
      shortfalls.push({ kind, share: shares[kind], made });
      deficit += shares[kind] - made;
    }
  }
  const passedOn = zeroes(GENERATED_KINDS);
  let open = [...SHORTFALL_ORDER];
  while (deficit > 0 && open.length > 0) {
    const stillOpen: GeneratedEvalKind[] = [];
    for (const kind of open) {
      if (deficit === 0) {
        stillOpen.push(kind);
        continue;
      }
      if (take(kind, 1) === 1) {
        passedOn[kind] += 1;
        deficit -= 1;
        stillOpen.push(kind);
      }
    }
    open = stillOpen;
  }

  // ---- The set, in order: the fixed questions, then the kinds in weight order ------------------
  const groupsPerKind = zeroes(GENERATED_KINDS);
  for (const kind of GENERATED_KINDS) {
    drafts[kind].forEach((draft, i) => {
      const group = evalGroupId(kind, i + 1);
      for (const wording of GROUP_WORDINGS) {
        const id = evalQuestionId(group, wording);
        questions.push(questionOf(draft.fact, id, draft.texts[wording])!);
        checks.push({
          id,
          group,
          kind,
          wording,
          targetKinds: [...draft.fact.targetKinds],
          goldQuery: draft.fact.goldQuery,
          forbidden: [],
        });
      }
      groupsPerKind[kind] += 1;
    });
  }
  if (questions.length === 0) {
    throw new EvalSetBuildError('no_questions', 'no question could be made from the folder');
  }

  const set = questionSetSchema.parse({
    version: QUESTION_SET_FORMAT_VERSION,
    source: { type: 'hand_written', orgSlugs: [folder.org.slug, fastOrgSlugOf(folder.org.slug)] },
    questions,
  });
  const checksFile = evalChecksSchema.parse({
    version: EVAL_CHECKS_FORMAT_VERSION,
    folder: { slug: folder.org.slug, answerKeyVersion: folder.key.generatorVersion },
    seed,
    count: questions.length,
    changed: null,
    questions: checks,
  });

  const perKind = zeroes(EVAL_QUESTION_KINDS);
  const perWording = zeroes(EVAL_WORDINGS);
  for (const q of checksFile.questions) {
    perKind[q.kind] += 1;
    perWording[q.wording] += 1;
  }
  const groups = GENERATED_KINDS.reduce((sum, kind) => sum + groupsPerKind[kind], 0);
  return {
    set,
    checks: checksFile,
    counts: {
      asked: count,
      questions: questions.length,
      groupsWanted,
      groups,
      perKind,
      perWording,
      shares,
      groupsPerKind,
      shortfalls,
      passedOn,
      unfilled: Math.max(0, groupsWanted - groups),
      dropped,
      fixed: { written: fixedWritten, leftOut: fixedLeftOut },
    },
  };
}
