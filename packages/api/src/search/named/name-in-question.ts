// Whether a question names a record (FX-003; D43, D263 items 4 and 10): the pure scorer the named
// record finder (./named-records.ts) uses, exported for FX-005 too. No I/O.
// - The question's words: the shared `normaliseName` of the question, split on spaces, with the
//   joining tokens "and", "or" and "&" kept, and a comma kept as a break (`QUESTION_BREAK`).
// - A name's forms: its `normaliseName`, the same with a trailing "(…)" removed, and each of those
//   with a trailing kind word ("asset", "risk", "control", "policy", "incident") removed. A form
//   under 4 characters, or only a kind word, is dropped (the "Not reviewed yet" list's rules).
// - Exact: a form is in the question as whole consecutive words (score 1).
// - Close spelling: the best `editSimilarity` between a form and a window of the question's words
//   with the form's word count (and one word more or less for a form of 3 or more words), when it
//   reaches `NAME_SPELLING_SCORE` (0.9) and the digits agree. A one-word form needs 6 characters or more.
// - "A and B": a window never spans a break or a joining "and", "or" or "&", unless the name itself
//   holds it, so "atlassian confluence and fortigate perimeter firewall" is two names, never one.
import { digitsAgree, editSimilarity, normaliseName } from '@grc/shared';

/**
 * A close-spelling score at or above this counts: 0.9, the user's choice, so "brute forse" (0.909)
 * matches "Brute Force". Below the extraction matcher's clear score (0.92), which stays as it is.
 */
export const NAME_SPELLING_SCORE = 0.9;

/** The shortest one-word form that may match by close spelling, in characters. */
export const ONE_WORD_SPELLING_MIN = 6;

/** The shortest form that can match at all, in characters. */
const MIN_FORM_LENGTH = 4;

/** The word a comma becomes in `questionWords`: a break no window spans. */
export const QUESTION_BREAK = ',';

/** The joining tokens a window never spans, unless the name holds them. */
const JOINERS: ReadonlySet<string> = new Set(['and', 'or', '&', QUESTION_BREAK]);

/** Joining tokens that `normaliseName` drops from a name, so a window spanning one leaves it out. */
const PUNCTUATION_JOINERS: ReadonlySet<string> = new Set(['&', QUESTION_BREAK]);

/** The kind words a name may end with ("Separation of Duties control"). */
const KIND_WORDS: readonly string[] = ['asset', 'risk', 'control', 'policy', 'incident'];

// Two scores this close count as equal (floating-point noise).
const EPSILON = 1e-9;

/** Whether a question word is a joining token ("and", "or", "&") or a break (a comma). */
export function isJoiningWord(word: string): boolean {
  return JOINERS.has(word);
}

/**
 * The question's words: the shared `normaliseName` of each stretch between commas and "&", split
 * on spaces, with every "&" kept as `&` and every comma as `QUESTION_BREAK`, in order. "and" and
 * "or" are words already. Fullwidth forms count as their plain characters.
 */
export function questionWords(question: string): string[] {
  if (typeof question !== 'string') return [];
  const words: string[] = [];
  for (const part of question.normalize('NFKC').split(/([,&])/u)) {
    if (part === '&' || part === QUESTION_BREAK) {
      words.push(part);
      continue;
    }
    const text = normaliseName(part);
    if (text !== '') words.push(...text.split(' '));
  }
  return words;
}

/** The name with every trailing "(…)" removed. */
function withoutTrailingParens(name: string): string {
  let text = name;
  for (;;) {
    const cut = text.replace(/\s*\([^()]*\)\s*$/u, '');
    if (cut === text) return text;
    text = cut;
  }
}

/** The form without a trailing kind word, or null when it has none (or is only one). */
function withoutKindWord(form: string): string | null {
  const words = form.split(' ');
  const last = words[words.length - 1];
  if (words.length < 2 || last === undefined || !KIND_WORDS.includes(last)) return null;
  return words.slice(0, -1).join(' ');
}

/** Whether a form can match: at least 4 characters, and not only a kind word. */
function usableForm(form: string): boolean {
  return Array.from(form).length >= MIN_FORM_LENGTH && !KIND_WORDS.includes(form);
}

/**
 * A name's forms: its `normaliseName`, the same with a trailing "(…)" removed, and each of those
 * without a trailing kind word; each once, usable ones only (see the top of the file).
 */
export function nameForms(name: string): string[] {
  if (typeof name !== 'string') return [];
  const full = normaliseName(name);
  const bare = normaliseName(withoutTrailingParens(name));
  const forms: string[] = [];
  for (const form of [full, bare]) {
    forms.push(form);
    const short = withoutKindWord(form);
    if (short !== null) forms.push(short);
  }
  return [...new Set(forms)].filter(usableForm);
}

export interface NameInQuestionScore {
  score: number;
  how: 'exact' | 'spelling';
}

/** The window sizes a form is compared with: its word count, and one more or less from 3 words. */
function sizesFor(wordCount: number): number[] {
  return wordCount >= 3 ? [wordCount - 1, wordCount, wordCount + 1] : [wordCount];
}

/**
 * Every window of the question's words, by its word count (up to `maxSize`), as the text a form is
 * compared with. A window starts and ends on a word, never spans a joining token the name doesn't
 * hold, and leaves out an "&" or a comma it spans (the name's forms don't have them).
 */
function windowsOf(words: readonly string[], held: ReadonlySet<string>, maxSize: number): Map<number, string[]> {
  const bySize = new Map<number, string[]>();
  const blocks = (w: string): boolean => JOINERS.has(w) && !held.has(w);
  for (let start = 0; start < words.length; start += 1) {
    const first = words[start];
    if (first === undefined || blocks(first) || PUNCTUATION_JOINERS.has(first)) continue;
    const taken: string[] = [];
    for (let end = start; end < words.length; end += 1) {
      const word = words[end];
      if (word === undefined || blocks(word)) break;
      if (PUNCTUATION_JOINERS.has(word)) continue;
      taken.push(word);
      if (taken.length > maxSize) break;
      const list = bySize.get(taken.length) ?? [];
      list.push(taken.join(' '));
      bySize.set(taken.length, list);
    }
  }
  return bySize;
}

/** A score kept to 4 places, so the same inputs always give the same order. */
function roundScore(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 10_000) / 10_000;
}

/**
 * How `name` is named in the question (`words` from `questionWords`): score 1 for a form found as
 * whole consecutive words, else the best close-spelling score at or above `NAME_SPELLING_SCORE`
 * with the digits agreeing, else null. See the top of the file for the windows and the joining
 * rule.
 */
export function nameScoreInQuestion(words: readonly string[], name: string): NameInQuestionScore | null {
  if (!Array.isArray(words) || words.length === 0) return null;
  const forms = nameForms(name);
  if (forms.length === 0) return null;
  const held = new Set(questionWords(name).filter((w) => JOINERS.has(w)));
  const counted = forms.map((form) => ({ form, size: form.split(' ').length, length: Array.from(form).length }));
  const maxSize = Math.max(...counted.map((f) => f.size + (f.size >= 3 ? 1 : 0)));
  const windows = windowsOf(words, held, maxSize);

  // Exact: a form as whole consecutive words.
  for (const { form, size } of counted) {
    if ((windows.get(size) ?? []).includes(form)) return { score: 1, how: 'exact' };
  }

  // Close spelling: the best window over all forms, digits agreeing.
  let best = 0;
  for (const { form, size, length } of counted) {
    if (size === 1 && length < ONE_WORD_SPELLING_MIN) continue;
    for (const windowSize of sizesFor(size)) {
      for (const text of windows.get(windowSize) ?? []) {
        // The edit distance is at least the length difference: skip windows that can't reach the score.
        const textLength = Array.from(text).length;
        const longest = Math.max(textLength, length);
        if (1 - Math.abs(textLength - length) / longest + EPSILON < NAME_SPELLING_SCORE) continue;
        if (!digitsAgree(text, form)) continue;
        const score = editSimilarity(text, form);
        if (score > best) best = score;
      }
    }
  }
  return best + EPSILON >= NAME_SPELLING_SCORE ? { score: roundScore(best), how: 'spelling' } : null;
}
