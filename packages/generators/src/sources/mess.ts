// The realistic mess (D18) and the pieces every dummy source shares: the org's link index, the document
// model the document generators fill, the fact sentences, exact-count picks for each rate,
// misspellings, spelling variants and planted false positives. Pure and seeded (D33, D45.8): no clock,
// no Math.random, no shared state.
import { Faker, base, en } from '@faker-js/faker';
import type { LinkType, RecordKind, UploadKind } from '@grc/shared';
import type { WorldLink, WorldOrg } from '../world/index.js';
import type { FalsePositivePlant, Plants, TypoPlant } from './render-sources.js';

/** A link of the answer key, as a document states it (or, for a plant, as it must not be read). */
export type Fact = WorldLink;

/** Every date the sources write is counted back from the world's fixed day, never from the clock. */
export const REFERENCE_MS = Date.UTC(2026, 8, 1);
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Each part of the output draws from its own seeded sequence, so changing one rate moves nothing else. */
export const STREAMS = {
  cmdb: 1,
  duplicates: 2,
  cmdbTypos: 3,
  policies: 4,
  socTickets: 5,
  auditReports: 6,
  falsePositives: 7,
  injections: 8,
  proseTypos: 9,
} as const;

export function fakerFor(seed: number, orgIndex: number, stream: number): Faker {
  const faker = new Faker({ locale: [en, base] });
  faker.seed([seed, orgIndex, stream]);
  return faker;
}

// ---------------------------------------------------------------------------------------------------
// Rates

export interface MessRates {
  /** Share of an org's assets written a second time, under a spelling variant or in a second source. */
  duplicateRate: number;
  /** Share of an org's asset rows whose name is misspelt, and share of its prose sentences with a misspelt word. */
  typoRate: number;
  /** False-positive sentences per fact sentence in an org's documents. */
  falsePositiveRate: number;
  /** Share of an org's documents that carry one planted prompt injection (D52.6). */
  injectionRate: number;
}

export const DEFAULT_RATES: Readonly<MessRates> = Object.freeze({
  duplicateRate: 0.05,
  typoRate: 0.02,
  falsePositiveRate: 0.05,
  injectionRate: 0.1,
});

/**
 * How many of `n` items get a plant at `rate`: the rate times n, rounded, and at least one when the
 * rate and n are both above zero, so even the smallest world carries every kind of trap.
 */
export function plantCount(rate: number, n: number): number {
  if (rate <= 0 || n <= 0) return 0;
  return Math.min(n, Math.max(1, Math.round(rate * n)));
}

/** The indices 0 … n-1 in a seeded random order. */
export function shuffledIndices(faker: Faker, n: number): number[] {
  return faker.helpers.shuffle(Array.from({ length: n }, (_, i) => i));
}

/** `count` different indices of 0 … n-1, ascending. */
export function pickIndices(faker: Faker, n: number, count: number): number[] {
  return shuffledIndices(faker, n)
    .slice(0, Math.min(count, n))
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------
// The org's records and links

export interface RecordRef {
  key: string;
  kind: RecordKind;
  name: string;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** One org of the answer key, indexed for the generators. Read only: nothing here changes the key. */
export class OrgWorld {
  private readonly records = new Map<string, RecordRef>();
  private readonly byKind = new Map<RecordKind, RecordRef[]>();
  private readonly linkedPairs = new Set<string>();
  private readonly outgoing = new Map<string, string[]>();
  private readonly incoming = new Map<string, string[]>();

  constructor(
    readonly org: WorldOrg,
    readonly index: number,
  ) {
    const add = (kind: RecordKind, list: readonly { key: string; name: string }[]) => {
      const refs = list.map((r) => ({ key: r.key, kind, name: r.name }));
      for (const ref of refs) this.records.set(ref.key, ref);
      this.byKind.set(kind, refs);
    };
    add('asset', org.assets);
    add('risk', org.risks);
    add('control', org.controls);
    add('policy', org.policies);
    add('incident', org.incidents);
    for (const link of org.links) {
      this.linkedPairs.add(pairKey(link.fromKey, link.toKey));
      const out = `${link.type}|${link.fromKey}`;
      const inc = `${link.type}|${link.toKey}`;
      this.outgoing.set(out, [...(this.outgoing.get(out) ?? []), link.toKey]);
      this.incoming.set(inc, [...(this.incoming.get(inc) ?? []), link.fromKey]);
    }
  }

  get orgKey(): string {
    return this.org.key;
  }

  ref(key: string): RecordRef {
    const ref = this.records.get(key);
    if (!ref) throw new Error(`answer key ${this.org.key}: unknown record ${key}`);
    return ref;
  }

  nameOf(key: string): string {
    return this.ref(key).name;
  }

  ofKind(kind: RecordKind): readonly RecordRef[] {
    return this.byKind.get(kind) ?? [];
  }

  /** True when any link, of any type and in either direction, joins the two records. */
  isLinked(a: string, b: string): boolean {
    return this.linkedPairs.has(pairKey(a, b));
  }

  /** The keys `fromKey` points to through links of `type`, in the answer key's order. */
  targets(type: LinkType, fromKey: string): readonly string[] {
    return this.outgoing.get(`${type}|${fromKey}`) ?? [];
  }

  /** The keys that point to `toKey` through links of `type`, in the answer key's order. */
  sources(type: LinkType, toKey: string): readonly string[] {
    return this.incoming.get(`${type}|${toKey}`) ?? [];
  }
}

/**
 * A record of `kind` that no link joins to `anchor` (and that isn't `anchor` or `exclude`), starting
 * the search at a seeded place in the list. Null when every one of them is linked.
 */
export function findUnlinked(
  faker: Faker,
  world: OrgWorld,
  anchor: string,
  kind: RecordKind,
  exclude?: string,
): RecordRef | null {
  const candidates = world.ofKind(kind);
  if (candidates.length === 0) return null;
  const start = faker.number.int({ min: 0, max: candidates.length - 1 });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[(start + i) % candidates.length]!;
    if (candidate.key === anchor || candidate.key === exclude) continue;
    if (!world.isLinked(anchor, candidate.key)) return candidate;
  }
  return null;
}

/** The kinds at the two ends of each link type (the ontology, S1's `LINK_TYPES`). */
export const LINK_ENDS: Readonly<Record<LinkType, readonly [RecordKind, RecordKind]>> = Object.freeze({
  HOSTS: ['asset', 'asset'],
  RUNS: ['asset', 'asset'],
  EXPOSED_TO: ['asset', 'risk'],
  MITIGATED_BY: ['risk', 'control'],
  GOVERNED_BY: ['control', 'policy'],
  IMPACTS: ['incident', 'asset'],
  EXPOSES: ['incident', 'risk'],
});

/**
 * A pair the answer key does not link, shaped like `like`: the same type, with one end kept and the
 * other swapped for an unlinked record of the same kind. `keep` names the end to keep when it can
 * (a seeded choice when not given). Null when no such pair exists.
 */
export function unlinkedLike(faker: Faker, world: OrgWorld, like: Fact, keep?: 'from' | 'to'): Fact | null {
  const [fromKind, toKind] = LINK_ENDS[like.type];
  const keepFrom = keep === undefined ? faker.datatype.boolean() : keep === 'from';
  const tries: (() => Fact | null)[] = [
    () => {
      const to = findUnlinked(faker, world, like.fromKey, toKind, like.toKey);
      return to ? { type: like.type, fromKey: like.fromKey, toKey: to.key } : null;
    },
    () => {
      const from = findUnlinked(faker, world, like.toKey, fromKind, like.fromKey);
      return from ? { type: like.type, fromKey: from.key, toKey: like.toKey } : null;
    },
  ];
  if (!keepFrom) tries.reverse();
  for (const attempt of tries) {
    const fact = attempt();
    if (fact) return fact;
  }
  return null;
}

/** Any pair the answer key does not link, of a seeded link type both of whose ends exist. */
export function anyUnlinked(faker: Faker, world: OrgWorld): Fact | null {
  const types = faker.helpers.shuffle(Object.keys(LINK_ENDS) as LinkType[]);
  for (const type of types) {
    const [fromKind, toKind] = LINK_ENDS[type];
    const froms = world.ofKind(fromKind);
    if (froms.length === 0) continue;
    const start = faker.number.int({ min: 0, max: froms.length - 1 });
    for (let i = 0; i < froms.length; i++) {
      const from = froms[(start + i) % froms.length]!;
      const to = findUnlinked(faker, world, from.key, toKind);
      if (to) return { type, fromKey: from.key, toKey: to.key };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Text

/** Fills `{name}` placeholders; a placeholder without a value is a bug. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`template value "${name}" is missing`);
    return value;
  });
}

export function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** `network_device` → `Network Device`. */
export function titleCase(value: string): string {
  return value
    .split('_')
    .map((word) => capitalise(word))
    .join(' ');
}

/** A lowercase file-name slug: letters, digits and single dashes. */
export function fileSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A person's work address at the org's made-up domain (the reserved `.example` top-level domain). */
export function workEmail(faker: Faker, domain: string): string {
  const first = faker.person
    .firstName()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const last = faker.person
    .lastName()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return `${first}.${last}@${domain}`;
}

export function emailDomain(orgName: string): string {
  const first = orgName.split(/[^A-Za-z]+/).find((word) => word.length > 0) ?? 'org';
  return `${first.toLowerCase().slice(0, 20)}.example`;
}

/** A sentence's words (letters only) of at least `minLength`, with where each starts. */
function wordsOf(text: string, minLength: number): { word: string; at: number }[] {
  const found: { word: string; at: number }[] = [];
  const pattern = new RegExp(`[A-Za-z]{${minLength},}`, 'g');
  for (const match of text.matchAll(pattern)) found.push({ word: match[0], at: match.index });
  return found;
}

const VOWELS = 'aeiou';

/**
 * A believable misspelling of one word (letters only): two neighbouring letters swapped, one letter
 * dropped, one doubled, or a vowel changed. Always differs from the word.
 */
export function misspell(faker: Faker, word: string): string {
  if (word.length === 0) throw new Error('misspell: empty word');
  for (let tries = 0; tries < 12; tries++) {
    const op = faker.number.int({ min: 0, max: 3 });
    let out = word;
    if (op === 0 && word.length >= 4) {
      const i = faker.number.int({ min: 1, max: word.length - 3 });
      out = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    } else if (op === 1 && word.length >= 4) {
      const i = faker.number.int({ min: 1, max: word.length - 2 });
      out = word.slice(0, i) + word.slice(i + 1);
    } else if (op === 2) {
      const i = faker.number.int({ min: 0, max: word.length - 1 });
      out = word.slice(0, i + 1) + word[i] + word.slice(i + 1);
    } else {
      const places = [...word].flatMap((c, i) => (VOWELS.includes(c.toLowerCase()) ? [i] : []));
      if (places.length > 0) {
        const i = faker.helpers.arrayElement(places);
        const current = word[i]!;
        const others = [...VOWELS].filter((v) => v !== current.toLowerCase());
        const next = faker.helpers.arrayElement(others);
        out = word.slice(0, i) + (current === current.toUpperCase() ? next.toUpperCase() : next) + word.slice(i + 1);
      }
    }
    if (out !== word) return out;
  }
  return word + word[word.length - 1];
}

/** A name with one of its words (letters only, digits never touched) misspelt. */
export function misspellName(faker: Faker, name: string): string {
  const long = wordsOf(name, 3);
  const words = long.length > 0 ? long : wordsOf(name, 1);
  if (words.length === 0) return `${name}x`;
  const { word, at } = faker.helpers.arrayElement(words);
  return name.slice(0, at) + misspell(faker, word) + name.slice(at + word.length);
}

/** Another way a source system spells the same asset name: case, separators, a domain or padding. */
export function spellingVariant(faker: Faker, name: string): string {
  const options = [
    name.toUpperCase(),
    name.replace(/-/g, '_'),
    name.replace(/-/g, ' '),
    `${name}.corp.local`,
    name.replace(/-0+(\d)/g, '-$1'),
  ].filter((variant, i, all) => variant !== name && all.indexOf(variant) === i);
  return faker.helpers.arrayElement(options);
}

// ---------------------------------------------------------------------------------------------------
// The document model

export type Sentence =
  | { kind: 'prose'; text: string }
  | { kind: 'fact'; text: string; fact: Fact }
  | { kind: 'false_positive'; text: string; notAFact: Fact }
  | { kind: 'injection'; text: string };

export interface Paragraph {
  sentences: Sentence[];
}

export function prose(text: string): Sentence {
  return { kind: 'prose', text };
}

/**
 * Between `min` and `max` different sentences of a prose bank, kept in the bank's order so the text
 * reads in sequence, with their `{placeholders}` filled.
 */
export function pickProse(
  faker: Faker,
  bank: readonly string[],
  min: number,
  max: number,
  values: Readonly<Record<string, string>> = {},
): Sentence[] {
  const count = faker.number.int({ min: Math.min(min, bank.length), max: Math.min(max, bank.length) });
  return pickIndices(faker, bank.length, count).map((i) => prose(fill(bank[i]!, values)));
}

export function paragraphText(paragraph: Paragraph): string {
  return paragraph.sentences.map((s) => s.text).join(' ');
}

/** A document before it is written out. The plants change its paragraphs; `render` reads them. */
export interface DocDraft {
  source: string;
  kind: UploadKind;
  fileName: string;
  format: 'txt' | 'json';
  /** Every paragraph of the body, in the order the body holds them. */
  paragraphs: Paragraph[];
  render(): string;
}

/** A plain-text document: lines and paragraphs, LF line endings, one final newline. */
export class TextDoc {
  private readonly parts: (string | { paragraph: Paragraph; prefix: string })[] = [];
  readonly paragraphs: Paragraph[] = [];

  line(text = ''): this {
    this.parts.push(text);
    return this;
  }

  paragraph(sentences: Sentence[], prefix = ''): Paragraph {
    const paragraph: Paragraph = { sentences };
    this.parts.push({ paragraph, prefix });
    this.paragraphs.push(paragraph);
    return paragraph;
  }

  render(): string {
    const lines = this.parts.map((part) =>
      typeof part === 'string' ? part : part.prefix + paragraphText(part.paragraph),
    );
    return `${lines.join('\n')}\n`;
  }
}

type FlatValue = string | number | boolean | null;

/** A flat JSON document: one object whose values are plain values or paragraphs of text. */
export class JsonDoc {
  private readonly fields: [string, FlatValue | Paragraph][] = [];
  readonly paragraphs: Paragraph[] = [];

  field(name: string, value: FlatValue): this {
    this.fields.push([name, value]);
    return this;
  }

  paragraph(name: string, sentences: Sentence[]): Paragraph {
    const paragraph: Paragraph = { sentences };
    this.fields.push([name, paragraph]);
    this.paragraphs.push(paragraph);
    return paragraph;
  }

  render(): string {
    const body: Record<string, FlatValue> = {};
    for (const [name, value] of this.fields) {
      body[name] = value !== null && typeof value === 'object' ? paragraphText(value) : value;
    }
    return `${JSON.stringify(body, null, 2)}\n`;
  }
}

// ---------------------------------------------------------------------------------------------------
// Fact sentences: every one names both ends by their answer-key names (D39's same-sentence rule).

const FACT_TEMPLATES: Readonly<Record<LinkType, readonly string[]>> = {
  HOSTS: ['{from} hosts {to}.', '{to} is hosted on {from}.'],
  RUNS: ['{from} runs {to}.', '{to} runs on {from}.'],
  EXPOSED_TO: [
    '{from} is exposed to the risk {to}.',
    'Testing confirmed that {from} is exposed to {to}.',
    'The risk {to} arises through {from}.',
  ],
  MITIGATED_BY: [
    'The risk {from} is mitigated by the {to} control.',
    'The {to} control is in place to mitigate the risk {from}.',
    'To reduce the risk {from}, the organisation relies on the {to} control.',
  ],
  GOVERNED_BY: [
    'The {from} control is governed by the {to}.',
    'The {to} governs the {from} control.',
    'Responsibility for the {from} control is set out in the {to}.',
  ],
  IMPACTS: [
    'The incident {from} impacted {to}.',
    '{to} was affected by the incident {from}.',
    'The incident {from} disrupted service on {to}.',
  ],
  EXPOSES: [
    'The incident {from} exposes the organisation to the risk {to}.',
    'Analysis of the incident {from} showed that it exposes the risk {to}.',
  ],
};

export function factSentence(faker: Faker, world: OrgWorld, fact: Fact): Sentence {
  const template = faker.helpers.arrayElement(FACT_TEMPLATES[fact.type]);
  // Names stay exactly as the answer key spells them, even at the start of a sentence (host names
  // are lowercase), so every sentence names both ends verbatim.
  const text = fill(template, { from: world.nameOf(fact.fromKey), to: world.nameOf(fact.toKey) });
  return { kind: 'fact', text, fact: { type: fact.type, fromKey: fact.fromKey, toKey: fact.toKey } };
}

// ---------------------------------------------------------------------------------------------------
// Planted false positives: sentences that name two records the answer key does not link.

const FALSE_POSITIVE_TEMPLATES: Readonly<Record<LinkType, readonly string[]>> = {
  HOSTS: ['{from} and {to} sit in the same data centre, but neither hosts the other.'],
  RUNS: ['{from} and {to} share a maintenance window, but neither runs on the other.'],
  EXPOSED_TO: [
    '{from} was assessed for the risk {to} and was found not to be exposed to it.',
    'The risk {to} was considered for {from} during the review and ruled out.',
  ],
  MITIGATED_BY: [
    'The risk {from} and the {to} control were discussed in the same workshop, but that control does not address it.',
    'The {to} control appears next to the risk {from} in the slide deck only for comparison.',
  ],
  GOVERNED_BY: [
    'The {from} control is listed beside the {to} for cross-reference only and is governed by a different policy.',
    'Readers of the {to} sometimes ask about the {from} control, which this policy does not cover.',
  ],
  IMPACTS: [
    'While triaging the incident {from}, analysts also checked {to} and found it unaffected.',
    'The incident {from} was first suspected on {to}, but that system showed no sign of compromise.',
  ],
  EXPOSES: [
    'The incident {from} was reviewed against the risk {to}, and no exposure to that risk was found.',
    'Analysts ruled out any link between the incident {from} and the risk {to}.',
  ],
};

export function falsePositiveSentence(faker: Faker, world: OrgWorld, notAFact: Fact): Sentence {
  const template = faker.helpers.arrayElement(FALSE_POSITIVE_TEMPLATES[notAFact.type]);
  const text = fill(template, { from: world.nameOf(notAFact.fromKey), to: world.nameOf(notAFact.toKey) });
  return { kind: 'false_positive', text, notAFact };
}

/**
 * The end of a fact that is the document's own subject (the ticket's incident, the policy, the
 * finding's risk), which a false positive keeps so it reads as part of the same document.
 */
function subjectEnd(kind: UploadKind, type: LinkType): 'from' | 'to' {
  if (type === 'MITIGATED_BY') return kind === 'policy_document' ? 'to' : 'from';
  return type === 'GOVERNED_BY' || type === 'EXPOSED_TO' ? 'to' : 'from';
}

/**
 * Plants false positives at `rate` false-positive sentences per fact sentence: each goes right after
 * a seeded fact sentence and names a pair of the same shape that the answer key does not link.
 */
export function plantFalsePositives(
  world: OrgWorld,
  drafts: readonly DocDraft[],
  faker: Faker,
  rate: number,
  plants: Plants,
): void {
  const slots: { draft: DocDraft; paragraph: Paragraph; sentence: Sentence & { kind: 'fact' } }[] = [];
  for (const draft of drafts) {
    for (const paragraph of draft.paragraphs) {
      for (const sentence of paragraph.sentences) {
        if (sentence.kind === 'fact') slots.push({ draft, paragraph, sentence });
      }
    }
  }
  const wanted = plantCount(rate, slots.length);
  let planted = 0;
  const found: FalsePositivePlant[] = [];
  for (const i of shuffledIndices(faker, slots.length)) {
    if (planted >= wanted) break;
    const slot = slots[i]!;
    const notAFact = unlinkedLike(
      faker,
      world,
      slot.sentence.fact,
      subjectEnd(slot.draft.kind, slot.sentence.fact.type),
    );
    if (!notAFact) continue;
    const sentence = falsePositiveSentence(faker, world, notAFact);
    const at = slot.paragraph.sentences.indexOf(slot.sentence);
    slot.paragraph.sentences.splice(at + 1, 0, sentence);
    found.push({ orgKey: world.orgKey, fileName: slot.draft.fileName, sentence: sentence.text, notAFact });
    planted++;
  }
  plants.falsePositives.push(...found);
}

/**
 * Misspells one word in `rate` of the org's prose sentences (never a fact, a false positive or an
 * injection, and never a word of the org's name).
 */
export function plantProseTypos(
  world: OrgWorld,
  drafts: readonly DocDraft[],
  faker: Faker,
  rate: number,
  plants: Plants,
): void {
  const protectedWords = new Set(
    world.org.name
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 0),
  );
  const slots: { draft: DocDraft; sentence: Sentence & { kind: 'prose' } }[] = [];
  for (const draft of drafts) {
    for (const paragraph of draft.paragraphs) {
      for (const sentence of paragraph.sentences) {
        if (sentence.kind === 'prose') slots.push({ draft, sentence });
      }
    }
  }
  const wanted = plantCount(rate, slots.length);
  let planted = 0;
  const found: TypoPlant[] = [];
  for (const i of shuffledIndices(faker, slots.length)) {
    if (planted >= wanted) break;
    const slot = slots[i]!;
    const words = wordsOf(slot.sentence.text, 5).filter((w) => !protectedWords.has(w.word.toLowerCase()));
    if (words.length === 0) continue;
    const { word, at } = faker.helpers.arrayElement(words);
    const typo = misspell(faker, word);
    slot.sentence.text = slot.sentence.text.slice(0, at) + typo + slot.sentence.text.slice(at + word.length);
    found.push({
      orgKey: world.orgKey,
      fileName: slot.draft.fileName,
      where: 'prose',
      original: word,
      typo,
      sentence: slot.sentence.text,
    });
    planted++;
  }
  plants.typos.push(...found);
}
