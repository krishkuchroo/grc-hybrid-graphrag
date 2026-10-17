// The fixed text rules the scores are built on (S8-004; S8 shared notes, "Fixed rules, no AI judge"),
// so hybrid and vector mode are judged the same way and the same texts always give the same answer.
// - A record is "named" by a text when the text holds its number (`RSK0001014`) or its name, both
//   sides normalised with S4's `normaliseName` and matched as whole words: the match touches no
//   letter or digit on either side, so `srv app 01` is not named by `srv-app-010`.
// - A "record number" is one of our record kinds' prefixes (risk, asset, control, policy, incident,
//   framework, requirement, evidence, audit finding) plus 7 digits, found as a whole word after the
//   same normalising, so `rsk0001014` and `**RSK0001014**` both name `RSK0001014`.
// - A sentence ends at `.`, `!`, `?` or `…` followed by white space, or at a line break.
// Pure: no I/O, no clock, no randomness.
import {
  CATALOG_NUMBER_PREFIX,
  INTAKE_NUMBER_PREFIX,
  NUMBER_PREFIX,
  normaliseName,
  type SearchRecordKind,
} from '@grc/shared';

/** Each record kind's number prefix. */
const RECORD_NUMBER_PREFIXES = Object.freeze({
  ...NUMBER_PREFIX,
  ...CATALOG_NUMBER_PREFIX,
  ...INTAKE_NUMBER_PREFIX,
} as const satisfies Record<SearchRecordKind, string>);

const PREFIXES: ReadonlySet<string> = new Set(Object.values(RECORD_NUMBER_PREFIXES).map((p) => p.toLowerCase()));

/** A whole word after `normaliseName`: a run of letters and digits. */
const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
/** A record number after `normaliseName`: three lowercase letters and seven digits. */
const NUMBER_WORD = /^([a-z]{3})([0-9]{7})$/;
const SENTENCE_BREAK = /(?<=[.!?\u2026\u3002\uff01\uff1f])\s+|[\r\n\u2028\u2029]+/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** The character (whole code point) that ends just before `index`. */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

/** The character (whole code point) that starts at `index`. */
function charAt(text: string, index: number): string | undefined {
  const cp = text.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/**
 * Whether `phrase` appears in `text` as whole words: touching no letter or digit on either side.
 * Both are already normalised; an empty phrase is in nothing.
 */
export function holdsWholeWords(text: string, phrase: string): boolean {
  if (phrase === '' || text === '') return false;
  for (let i = text.indexOf(phrase); i !== -1; i = text.indexOf(phrase, i + 1)) {
    if (!isWordChar(charBefore(text, i)) && !isWordChar(charAt(text, i + phrase.length))) return true;
  }
  return false;
}

/** What a text can name a record by: its number (if it has one) and its name. */
export interface NamedRecord {
  number?: string | null;
  name: string;
}

/** A record's number and name, normalised once, for matching against many texts. */
export interface RecordMatcher {
  readonly number: string;
  readonly name: string;
}

export function recordMatcher(record: NamedRecord): RecordMatcher {
  return {
    number: typeof record.number === 'string' ? normaliseName(record.number) : '',
    name: normaliseName(record.name),
  };
}

/** Whether an already normalised text names the record. */
export function namesNormalised(normalisedText: string, matcher: RecordMatcher): boolean {
  return holdsWholeWords(normalisedText, matcher.number) || holdsWholeWords(normalisedText, matcher.name);
}

/**
 * Whether the text names the record: it holds the record's number, or its name, as whole words,
 * both sides through `normaliseName`. A name with nothing left after normalising names nothing.
 */
export function namesRecord(text: string, record: NamedRecord): boolean {
  if (typeof text !== 'string' || record === null || typeof record !== 'object') return false;
  return namesNormalised(normaliseName(text), recordMatcher(record));
}

/** The record numbers an already normalised text names, uppercase, each once, in the order first named. */
export function recordNumbersInNormalised(normalisedText: string): string[] {
  const seen = new Set<string>();
  for (const [word] of normalisedText.matchAll(WORD)) {
    const match = NUMBER_WORD.exec(word);
    if (match && PREFIXES.has(match[1] ?? '')) seen.add(word.toUpperCase());
  }
  return [...seen];
}

/** The record numbers the text names (`RSK0001014`, `rsk0001014`…), uppercase, each once, in the
 * order first named. */
export function recordNumbersIn(text: string): string[] {
  return typeof text === 'string' ? recordNumbersInNormalised(normaliseName(text)) : [];
}

/** The text's sentences, in order, empty ones left out. */
export function sentencesOf(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text.split(SENTENCE_BREAK).filter((s) => s.trim() !== '');
}

/** The text with compatibility forms folded and invisible format characters removed, case kept:
 * what the checks that care about capitals read. */
export function foldedText(text: string): string {
  return typeof text === 'string' ? text.normalize('NFKC').replace(/\p{Cf}+/gu, '') : '';
}

/** The text as a result item can store it: no U+0000 and no lone surrogate. */
export function storableText(text: string | null | undefined): string {
  return typeof text === 'string' ? text.replaceAll('\u0000', '').toWellFormed() : '';
}
