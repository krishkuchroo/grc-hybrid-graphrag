// Stale answers (EV-002 behaviour 2(e); D261 track A, item 4's failure rule): an answer that shows a
// name the checks file forbids, an old name of a renamed record or an end of a deleted link, came
// from somewhere other than the org's current data.
// - A forbidden name is shown when the answer text names it as `namesRecord` does: both sides through
//   `normaliseName`, matched as whole words.
// - An entry with `exceptAfter` (a renamed control's code): an occurrence straight after that code,
//   both normalised, doesn't count, so "AC-4 Information Flow Enforcement", the catalog's own
//   requirement title, is no stale hit. Any other occurrence of the same name still is.
// - The score per mode: stale answers ÷ measured answers (the scored answers of the questions with
//   forbidden names), also split by `why`. A stale answer counts as a failure in the evaluation; the
//   item stored on the API is never changed.
// Pure: no I/O, no clock, no randomness.
import { normaliseName } from '@grc/shared';
import type { SearchMode } from '@grc/shared';
import { holdsWholeWords } from '../score/text.js';
import { FORBIDDEN_REASONS, type EvalForbidden, type ForbiddenReason } from './checks-file.js';

/** A forbidden name an answer showed, and why it is forbidden. */
export interface EvalStaleHit {
  name: string;
  why: ForbiddenReason;
}

const WORD_CHAR = /^[\p{L}\p{N}]$/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** The whole code point that ends just before `index`. */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

/** The whole code point that starts at `index`. */
function charAt(text: string, index: number): string | undefined {
  const cp = text.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** Where `phrase` starts in `text` as whole words (the rule of `holdsWholeWords`); both normalised. */
function wholeWordStarts(text: string, phrase: string): number[] {
  const starts: number[] = [];
  if (phrase === '' || text === '') return starts;
  for (let i = text.indexOf(phrase); i !== -1; i = text.indexOf(phrase, i + 1)) {
    if (!isWordChar(charBefore(text, i)) && !isWordChar(charAt(text, i + phrase.length))) starts.push(i);
  }
  return starts;
}

/** Whether the occurrence at `index` comes straight after `code` (a whole word or words), in a
 * normalised text. */
function followsCode(text: string, index: number, code: string): boolean {
  const before = text.slice(0, index).trimEnd();
  if (!before.endsWith(code)) return false;
  return !isWordChar(charBefore(before, before.length - code.length));
}

/** Whether the answer shows the forbidden name, by the rule in the file comment. */
export function showsForbidden(normalisedText: string, entry: EvalForbidden): boolean {
  const name = normaliseName(entry.name);
  if (name === '') return false;
  const code = entry.exceptAfter === undefined ? '' : normaliseName(entry.exceptAfter);
  if (code === '') return holdsWholeWords(normalisedText, name);
  return wholeWordStarts(normalisedText, name).some((index) => !followsCode(normalisedText, index, code));
}

/** The forbidden names the answer text shows, in the checks file's order, each entry once. */
export function staleHitsOf(answerText: string, forbidden: readonly EvalForbidden[]): EvalStaleHit[] {
  if (typeof answerText !== 'string' || forbidden.length === 0) return [];
  const text = normaliseName(answerText);
  return forbidden.filter((entry) => showsForbidden(text, entry)).map(({ name, why }) => ({ name, why }));
}

/** One scored answer of a question with forbidden names: its mode, the reasons its question
 * forbids names for, and its hits. */
export interface StaleAnswer {
  mode: SearchMode;
  reasons: readonly ForbiddenReason[];
  hits: readonly EvalStaleHit[];
}

/** Stale answers ÷ measured answers; null when none was measured. */
export interface StaleShare {
  measured: number;
  stale: number;
  score: number | null;
}

export interface StaleModeSummary extends StaleShare {
  mode: SearchMode;
  /** Per reason: the answers whose question forbids a name for it, and those showing one. */
  byWhy: (StaleShare & { why: ForbiddenReason })[];
}

function shareOf(measured: number, stale: number): StaleShare {
  return { measured, stale, score: measured === 0 ? null : stale / measured };
}

/** The stale scores of one mode's measured answers. */
export function staleSummary(mode: SearchMode, answers: readonly StaleAnswer[]): StaleModeSummary {
  const ofMode = answers.filter((a) => a.mode === mode);
  return {
    mode,
    ...shareOf(ofMode.length, ofMode.filter((a) => a.hits.length > 0).length),
    byWhy: FORBIDDEN_REASONS.map((why) => {
      const measured = ofMode.filter((a) => a.reasons.includes(why));
      return { why, ...shareOf(measured.length, measured.filter((a) => a.hits.some((h) => h.why === why)).length) };
    }),
  };
}
