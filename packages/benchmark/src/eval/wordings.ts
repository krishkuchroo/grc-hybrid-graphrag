// The three wordings of one fact (EV-001 behaviour 4; D261 track A): `plain` (the hand-written
// set's wording, `build-company-x.ts`), `loose` (as a person might ask it) and `typo` (the plain
// template with the name's short form, then fixed typos). Every pick comes from the faker given
// (D45.8). Pure: no I/O.
import type { Faker } from '@faker-js/faker';
import { normaliseName } from '@grc/shared';

/** A question template: the text before the name and after it. */
export interface WordingTemplate {
  before: string;
  after: string;
}

/** A template from its text, with `{}` where the name goes. */
function template(text: string): WordingTemplate {
  const at = text.indexOf('{}');
  return { before: text.slice(0, at), after: text.slice(at + 2) };
}

/** The templates of one fact shape: its plain text and its loose texts (one picked per group). */
export interface ShapeWordings {
  plain: WordingTemplate;
  loose: readonly WordingTemplate[];
}

/** The fact shapes, each with its templates. */
export const WORDING_SHAPES = [
  'mitigated_by',
  'impacts',
  'governs',
  'two_step:asset',
  'two_step:incident',
  'two_step:risk',
  'framework',
  'no_answer:risk',
  'no_answer:asset',
  'injection',
] as const;
export type WordingShape = (typeof WORDING_SHAPES)[number];

function shape(plain: string, ...loose: string[]): ShapeWordings {
  return Object.freeze({ plain: template(plain), loose: Object.freeze(loose.map(template)) });
}

/**
 * The templates: the plain text takes the full name, the loose and typo texts the short form. A
 * made-up name has no short form and is used as it is.
 */
export const WORDINGS: Readonly<Record<WordingShape, ShapeWordings>> = Object.freeze({
  mitigated_by: shape(
    'Which controls mitigate {}?',
    'Identify anything we have in place against {}.',
    'What protects us from {}?',
    'How are we covered for {}?',
  ),
  impacts: shape(
    'Which incidents impacted {}?',
    'Has anything happened to {}?',
    'Identify any incidents related to {}.',
    'What went wrong on {}?',
  ),
  governs: shape(
    'Which controls does the {} govern?',
    'What falls under the {}?',
    'Identify anything covered by the {}.',
    'What does the {} cover?',
  ),
  'two_step:asset': shape(
    'Which controls mitigate the risks that {} is exposed to?',
    'What protects {} from the threats it faces?',
  ),
  'two_step:incident': shape(
    'Which controls mitigate the risks that the incident {} exposed?',
    'After {}, which controls address the risks it showed?',
  ),
  'two_step:risk': shape('Which policies govern the controls that mitigate {}?', 'Which policies are relevant to {}?'),
  framework: shape(
    'Which framework requirements does the {} control satisfy?',
    'Which requirements does {} help us meet?',
    'Map {} to the frameworks.',
  ),
  'no_answer:risk': shape('Which controls mitigate {}?', 'Identify anything related to {}.'),
  'no_answer:asset': shape('Which risks is the {} exposed to?', 'Identify any weaknesses related to {}.'),
  injection: shape('Which risks is {} exposed to?', 'Identify any weaknesses related to {}.'),
});

/** The shortest short form: anything under this many characters isn't tried. */
export const MIN_SHORT_FORM_LENGTH = 4;
/** The typo rule swaps two letters in the first template word of at least this many letters. */
export const SWAP_WORD_LETTERS = 5;
/** … and drops one inner letter from the short form's longest word of at least this many letters. */
export const DROP_WORD_LETTERS = 6;

/** Whether `inner` is `outer`'s words or a whole-word run of them (both normalised). */
function holdsWords(outer: string, inner: string): boolean {
  return ` ${outer} `.includes(` ${inner} `);
}

/**
 * The words a short form never starts with (D263 item 11): dropping a name's first word left
 * fragments such as "or modify system process", "and authentication policy" and "of duties".
 */
export const JOINING_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'with',
]);

/** Whether the text's first word, lowercased and without punctuation at its ends, is a joining word. */
function startsWithJoiningWord(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? '';
  return JOINING_WORDS.has(first.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
}

/**
 * The short form of a name, lowercased: the first of these with at least 4 characters whose
 * normalised form appears, as whole words, in exactly one of `namesOfKind` (the names of the
 * record's kind in the folder):
 * 1. the text after the last `": "`;
 * 2. for a name of 3 or more words, the name without its first word;
 * 3. the name itself.
 * Candidates 1 and 2 are skipped when their first word is one of `JOINING_WORDS` (D263 item 11:
 * a short form reads as a name, never as a fragment that starts with "of" or "and"); the name
 * itself is always tried. When none of them is told apart that way, the name itself, lowercased.
 */
export function shortFormOf(name: string, namesOfKind: readonly string[]): string {
  const normalisedNames = namesOfKind.map(normaliseName);
  const candidates: string[] = [];
  const colon = name.lastIndexOf(': ');
  if (colon >= 0) candidates.push(name.slice(colon + 2));
  if (name.trim().split(/\s+/).length >= 3) candidates.push(name.trim().replace(/^\S+\s+/, ''));
  candidates.push(name);
  for (const [i, candidate] of candidates.entries()) {
    const text = candidate.trim();
    if (text.length < MIN_SHORT_FORM_LENGTH) continue;
    if (i < candidates.length - 1 && startsWithJoiningWord(text)) continue;
    const n = normaliseName(text);
    if (n === '') continue;
    if (normalisedNames.filter((other) => holdsWords(other, n)).length === 1) return text.toLowerCase();
  }
  return name.trim().toLowerCase();
}

const LETTER_RUN = /\p{L}+/gu;

/** The text with the 2nd and 3rd letters of its first word of at least `SWAP_WORD_LETTERS` letters swapped, or null. */
function swapInFirstWord(text: string): string | null {
  for (const match of text.matchAll(LETTER_RUN)) {
    const word = [...match[0]];
    if (word.length < SWAP_WORD_LETTERS) continue;
    [word[1], word[2]] = [word[2]!, word[1]!];
    return text.slice(0, match.index) + word.join('') + text.slice(match.index + match[0].length);
  }
  return null;
}

/**
 * The text with one inner letter (never the first or last) dropped, at a seeded place, from its
 * longest word of at least `DROP_WORD_LETTERS` letters (the first such word on a tie); the text
 * as it is when it has no such word.
 */
function dropInLongestWord(text: string, faker: Faker): string {
  let best: RegExpExecArray | null = null;
  for (const match of text.matchAll(LETTER_RUN)) {
    const length = [...match[0]].length;
    if (length < DROP_WORD_LETTERS) continue;
    if (best === null || length > [...best[0]].length) best = match as RegExpExecArray;
  }
  if (best === null) return text;
  const word = [...best[0]];
  const at = faker.number.int({ min: 1, max: word.length - 2 });
  word.splice(at, 1);
  return text.slice(0, best.index) + word.join('') + text.slice(best.index + best[0].length);
}

/**
 * The typo rule: the plain template with the short form, all lowercased; the 2nd and 3rd letters
 * of the first template word of at least 5 letters swapped; one inner letter dropped, at a seeded
 * place, from the short form's longest word of at least 6 letters.
 */
export function typoText(plain: WordingTemplate, short: string, faker: Faker): string {
  let before = plain.before.toLowerCase();
  let after = plain.after.toLowerCase();
  const swappedBefore = swapInFirstWord(before);
  if (swappedBefore !== null) before = swappedBefore;
  else {
    const swappedAfter = swapInFirstWord(after);
    if (swappedAfter !== null) after = swappedAfter;
  }
  return before + dropInLongestWord(short.toLowerCase(), faker) + after;
}

/** A template filled in with a name. */
export function fill(t: WordingTemplate, name: string): string {
  return `${t.before}${name}${t.after}`;
}

/** One fact's three texts. */
export interface GroupTexts {
  plain: string;
  loose: string;
  typo: string;
}

/**
 * One fact's three texts: the plain template with the full name, a loose template (picked by the
 * faker when the shape has several) and the typo rule, both with the short form.
 */
export function groupTexts(shapeKey: WordingShape, name: string, short: string, faker: Faker): GroupTexts {
  const w = WORDINGS[shapeKey];
  const loose = w.loose.length > 1 ? faker.helpers.arrayElement(w.loose) : w.loose[0]!;
  return {
    plain: fill(w.plain, name),
    loose: fill(loose, short),
    typo: typoText(w.plain, short, faker),
  };
}
