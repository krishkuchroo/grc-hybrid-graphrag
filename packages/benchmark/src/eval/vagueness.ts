// Vagueness scores (EV-006; D263 item 6, D261 track A): fixed-rule checks of how an answer reads,
// with no AI judge (D45.8). They read the words only: a listed, cited answer can still be wrong (the
// answer score says whether it is right).
// - `completeness`: the item's `answer_correctness` as stored (records named ÷ expected); null when
//   it wasn't measured.
// - `countStated` / `statedCount`: the first non-empty line (a list marker on it isn't a count)
//   states a count when a whole number in digits, or a number word ("zero" … "twenty"), comes at most
//   3 words before a kind word (control, risk, incident, policy, asset, requirement, record, finding
//   or link, singular or plural); or when "no" comes at most 3 words before a kind word, or "none"
//   within 3 words of one on either side (count 0). The first such number from the left is the
//   count. Words here are the line's space-separated pieces with their outer punctuation removed, so
//   "AC-17" is a code, not the number 17.
// - `countRight`: the stated count equals the expected count; null when no count is stated.
// - `listItems` / `citedListItems` / `citedShare`: the lines that are list items by the chat panel's
//   rule, those of them holding a citation by the API's bracket rule, and cited ÷ items (null with no
//   list).
// - `hedges`: the whole-word, case-insensitive count of the hedging words and phrases below; "may"
//   doesn't count when the next word starts with a digit ("May 2019", "May 5").
// - `words`: the runs of letters or digits. `wordsPerExpected` = words ÷ the expected count (null
//   when that is 0); `tooShort` when it is under 8.
// For `no_answer` and `injection` questions only `hedges` and `words` are measured.
//
// Cut-off answers and full-answer times (D265, Q-FX-4): a `stopped` message in a benchmark run was
// cut off (no one presses Stop there), by the answer cap or by the answer's 180 s time limit
// (`SEARCH_LIMITS.answerTimeoutMs`); the saved message doesn't say which. The cause is `cap` when the
// whole message took under the time limit, since the answer step alone can't have reached it then,
// else `cap_or_time_limit`. An `answered` message's total time is its full-answer time; D48's target
// for it is 60 s.
// Pure: no I/O, no clock, no randomness.
import {
  BENCHMARK_D48,
  SEARCH_LIMITS,
  benchmarkMean,
  nearestRankPercentile,
  type ChatMessageStatus,
  type SearchMode,
} from '@grc/shared';
import { EVAL_QUESTION_KINDS, EVAL_WORDINGS, type EvalQuestionKind, type EvalWording } from './kinds.js';

/** Under this many words per expected record an answer is `tooShort`. */
export const MIN_WORDS_PER_EXPECTED = 8;

/** How far before a kind word (in words) a count may stand. */
export const COUNT_WINDOW = 3;

/** The number words a count may be written as, by value. */
export const COUNT_NUMBER_WORDS = Object.freeze([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
] as const);

/** The kind words a count goes with, singular and plural. */
export const COUNT_KIND_WORDS = Object.freeze([
  'control',
  'controls',
  'risk',
  'risks',
  'incident',
  'incidents',
  'policy',
  'policies',
  'asset',
  'assets',
  'requirement',
  'requirements',
  'record',
  'records',
  'finding',
  'findings',
  'link',
  'links',
] as const);

/** The hedging words and phrases, counted whole-word and case-insensitive. */
export const HEDGE_WORDS = Object.freeze([
  'some',
  'various',
  'several',
  'may',
  'might',
  'possibly',
  'perhaps',
  'likely',
  'could',
  'certain',
  'a few',
  'a number of',
] as const);

/** The fine kinds for which only `hedges` and `words` are measured. */
export const WORDS_ONLY_KINDS: readonly EvalQuestionKind[] = Object.freeze(['no_answer', 'injection']);

/** One answer's vagueness checks; a null field wasn't measured. */
export interface VaguenessCheck {
  completeness: number | null;
  countStated: boolean | null;
  statedCount: number | null;
  countRight: boolean | null;
  listItems: number | null;
  citedListItems: number | null;
  citedShare: number | null;
  hedges: number;
  words: number;
  wordsPerExpected: number | null;
  tooShort: boolean | null;
}

/** How one answer ended. */
export interface AnswerEnding {
  cutOff: boolean;
  cutBy: 'cap' | 'cap_or_time_limit' | null;
  fullAnswerMs: number | null;
}

export const CUT_BY = ['cap', 'cap_or_time_limit'] as const;
export type CutBy = (typeof CUT_BY)[number];

// Copied from the chat panel's `LIST_ITEM` (packages/web/src/features/chat/answerText.ts): a `-`,
// `*` or `•` bullet, or a number of 1–3 digits with `.` or `)`, then space and the item.
const LIST_ITEM = /^\s*(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/;

// Copied from the API's citation rule (packages/api/src/chat/citations.ts `BRACKET`, `SEPARATOR`,
// `ITEM`): square brackets holding one or more source numbers, `[1]`, `[1, 3]`, `[2; 4]`,
// `[1 and 2]`, `[1-3]` or `[Source 2]`; anything else in brackets isn't a citation.
const BRACKET = /\[([^[\]\n]{1,80})\]/g;
const SEPARATOR = /\s*(?:,|;|&|\band\b)\s*/i;
const ITEM = /^(?:sources?\s*)?(\d{1,6})(?:\s*[-–—]\s*(?:sources?\s*)?(\d{1,6}))?$/i;

const WORD_RUN = /[\p{L}\p{N}]+/gu;
const DIGITS = /^\d{1,3}(?:,\d{3})+$|^\d+$/;
const OUTER_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Each hedge as a whole-word, case-insensitive pattern; "may" not before a word starting with a
 * digit. */
const HEDGE_PATTERNS: readonly RegExp[] = HEDGE_WORDS.map((hedge) => {
  const body = hedge.split(' ').join('\\s+');
  const notBeforeNumber = hedge === 'may' ? '(?![^\\p{L}\\p{N}]*[0-9])' : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])${notBeforeNumber}`, 'giu');
});

const KIND_WORDS = new Set<string>(COUNT_KIND_WORDS);

/** Whether one bracket's text is a citation by the API's rule. */
function isCitation(inner: string): boolean {
  return inner
    .trim()
    .split(SEPARATOR)
    .every((part) => ITEM.test(part.trim()));
}

/** Whether a line holds at least one citation. */
function holdsCitation(line: string): boolean {
  for (const match of line.matchAll(BRACKET)) if (isCitation(match[1] ?? '')) return true;
  return false;
}

function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** The first non-empty line's words for the count rule: space-separated, outer punctuation off, the
 * empty ones dropped, lowercased; a list marker is taken off first. */
function firstLineWords(text: string): string[] {
  const first = linesOf(text).find((line) => line.trim() !== '') ?? '';
  const item = LIST_ITEM.exec(first);
  const body = item ? (item[3] ?? '') : first;
  return body
    .split(/\s+/)
    .map((w) => w.replace(OUTER_PUNCTUATION, '').toLowerCase())
    .filter((w) => w !== '');
}

/** A word's value as a count: digits (with optional thousands commas) or a number word; else null. */
function countValue(word: string): number | null {
  if (DIGITS.test(word)) {
    const n = Number(word.replace(/,/g, ''));
    return Number.isSafeInteger(n) ? n : null;
  }
  const index = (COUNT_NUMBER_WORDS as readonly string[]).indexOf(word);
  return index === -1 ? null : index;
}

function kindWordWithin(words: readonly string[], from: number, to: number): boolean {
  for (let i = Math.max(0, from); i <= Math.min(words.length - 1, to); i++) {
    if (KIND_WORDS.has(words[i]!)) return true;
  }
  return false;
}

/** The count the answer's first line states, or null: see the file comment. */
export function statedCountOf(answerText: string): number | null {
  const words = firstLineWords(typeof answerText === 'string' ? answerText : '');
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const after = kindWordWithin(words, i + 1, i + COUNT_WINDOW);
    if (word === 'no' && after) return 0;
    if (word === 'none' && (after || kindWordWithin(words, i - COUNT_WINDOW, i - 1))) return 0;
    const value = countValue(word);
    if (value !== null && after) return value;
  }
  return null;
}

/** The list-item lines and those of them holding a citation. */
export function listItemsOf(answerText: string): { items: number; cited: number } {
  let items = 0;
  let cited = 0;
  for (const line of linesOf(typeof answerText === 'string' ? answerText : '')) {
    if (!LIST_ITEM.test(line)) continue;
    items += 1;
    if (holdsCitation(line)) cited += 1;
  }
  return { items, cited };
}

/** The number of hedging words and phrases in the answer. */
export function hedgesOf(answerText: string): number {
  if (typeof answerText !== 'string' || answerText === '') return 0;
  return HEDGE_PATTERNS.reduce((sum, pattern) => sum + [...answerText.matchAll(pattern)].length, 0);
}

/** The number of words (runs of letters or digits) in the answer. */
export function wordsOf(answerText: string): number {
  if (typeof answerText !== 'string' || answerText === '') return 0;
  return [...answerText.matchAll(WORD_RUN)].length;
}

/** One answer's vagueness checks: see the file comment. */
export function vaguenessOf(
  answerText: string,
  expectedCount: number,
  answerCorrectness: number | null,
): VaguenessCheck {
  const text = typeof answerText === 'string' ? answerText : '';
  const statedCount = statedCountOf(text);
  const list = listItemsOf(text);
  const words = wordsOf(text);
  const expected = Number.isFinite(expectedCount) && expectedCount > 0 ? expectedCount : 0;
  const wordsPerExpected = expected > 0 ? words / expected : null;
  return {
    completeness:
      typeof answerCorrectness === 'number' && Number.isFinite(answerCorrectness) ? answerCorrectness : null,
    countStated: statedCount !== null,
    statedCount,
    countRight: statedCount === null ? null : statedCount === expectedCount,
    listItems: list.items,
    citedListItems: list.cited,
    citedShare: list.items > 0 ? list.cited / list.items : null,
    hedges: hedgesOf(text),
    words,
    wordsPerExpected,
    tooShort: wordsPerExpected === null ? null : wordsPerExpected < MIN_WORDS_PER_EXPECTED,
  };
}

/** The vagueness checks of a question of the given fine kind: for `no_answer` and `injection`, only
 * `hedges` and `words`. */
export function vaguenessForKind(
  kind: EvalQuestionKind,
  answerText: string,
  expectedCount: number,
  answerCorrectness: number | null,
): VaguenessCheck {
  const check = vaguenessOf(answerText, expectedCount, answerCorrectness);
  if (!WORDS_ONLY_KINDS.includes(kind)) return check;
  return {
    completeness: null,
    countStated: null,
    statedCount: null,
    countRight: null,
    listItems: null,
    citedListItems: null,
    citedShare: null,
    hedges: check.hedges,
    words: check.words,
    wordsPerExpected: null,
    tooShort: null,
  };
}

/** How an answer ended, from its saved status and total time: see the file comment. */
export function answerEndingOf(status: ChatMessageStatus | null, totalMs: number | null): AnswerEnding {
  const ms = typeof totalMs === 'number' && Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : null;
  if (status === 'stopped') {
    return {
      cutOff: true,
      cutBy: ms !== null && ms < SEARCH_LIMITS.answerTimeoutMs ? 'cap' : 'cap_or_time_limit',
      fullAnswerMs: null,
    };
  }
  return { cutOff: false, cutBy: null, fullAnswerMs: status === 'answered' ? ms : null };
}

// ---------------------------------------------------------------------------------------------
// Summaries.

/** A part of the measured answers: `count` of `of`, and the share (null when `of` is 0). */
export interface VaguenessShare {
  of: number;
  count: number;
  share: number | null;
}

/** A mean over `n` values; null when there are none. */
export interface VaguenessMean {
  n: number;
  mean: number | null;
}

/** The vagueness scores of a slice of answers. */
export interface VaguenessSummary {
  /** The answers measured (scored answers). */
  answers: number;
  completeness: VaguenessMean;
  /** Answers stating a count, of the answers the count rule applies to. */
  countStated: VaguenessShare;
  /** Answers whose stated count is right, of those stating one. */
  countRight: VaguenessShare;
  /** Answers with a list, of the answers the list rule applies to. */
  withList: VaguenessShare;
  /** The mean `citedShare` of the answers with a list. */
  citedShare: VaguenessMean;
  hedges: VaguenessMean;
  /** Answers with at least one hedge. */
  hedged: VaguenessShare;
  /** The median (50th percentile, nearest rank) words per expected record. */
  wordsPerExpected: { n: number; median: number | null };
  tooShort: VaguenessShare;
}

/** How a slice of answers ended. */
export interface AnswerEndingSummary {
  /** The answers with a message. */
  measured: number;
  cutOff: VaguenessShare & { byCutBy: Record<CutBy, number> };
  fullAnswers: {
    count: number;
    medianMs: number | null;
    p95Ms: number | null;
    /** D48's full-answer target. */
    targetMs: number;
    /** Full answers over the target, of the full answers. */
    overTarget: VaguenessShare;
  };
}

export interface VaguenessScores {
  vagueness: VaguenessSummary;
  ending: AnswerEndingSummary;
}

export interface VaguenessModeSummary {
  mode: SearchMode;
  overall: VaguenessScores;
  /** The fine kinds and wordings with at least one measured answer, in their list's order. */
  byKind: (VaguenessScores & { kind: EvalQuestionKind })[];
  byWording: (VaguenessScores & { wording: EvalWording })[];
}

/** One answer as the summaries read it: null checks weren't measured for it. */
export interface VaguenessAnswer {
  mode: SearchMode;
  kind: EvalQuestionKind;
  wording: EvalWording;
  vagueness: VaguenessCheck | null;
  ending: AnswerEnding | null;
}

function shareOf(of: number, count: number): VaguenessShare {
  return { of, count, share: of === 0 ? null : count / of };
}

function meanOf(values: readonly number[]): VaguenessMean {
  return { n: values.length, mean: benchmarkMean(values) };
}

function notNull<T>(values: readonly (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}

/** The vagueness scores of some answers' checks. */
export function vaguenessSummary(checks: readonly VaguenessCheck[]): VaguenessSummary {
  const stated = notNull(checks.map((c) => c.countStated));
  const right = notNull(checks.map((c) => c.countRight));
  const lists = notNull(checks.map((c) => c.listItems));
  const perExpected = notNull(checks.map((c) => c.wordsPerExpected));
  const short = notNull(checks.map((c) => c.tooShort));
  return {
    answers: checks.length,
    completeness: meanOf(notNull(checks.map((c) => c.completeness))),
    countStated: shareOf(stated.length, stated.filter(Boolean).length),
    countRight: shareOf(right.length, right.filter(Boolean).length),
    withList: shareOf(lists.length, lists.filter((n) => n > 0).length),
    citedShare: meanOf(notNull(checks.map((c) => c.citedShare))),
    hedges: meanOf(checks.map((c) => c.hedges)),
    hedged: shareOf(checks.length, checks.filter((c) => c.hedges > 0).length),
    wordsPerExpected: { n: perExpected.length, median: nearestRankPercentile(perExpected, 50) },
    tooShort: shareOf(short.length, short.filter(Boolean).length),
  };
}

/** How some answers ended. */
export function answerEndingSummary(endings: readonly AnswerEnding[]): AnswerEndingSummary {
  const cut = endings.filter((e) => e.cutOff);
  const full = notNull(endings.map((e) => e.fullAnswerMs));
  const targetMs = BENCHMARK_D48.fullAnswerMs;
  return {
    measured: endings.length,
    cutOff: {
      ...shareOf(endings.length, cut.length),
      byCutBy: {
        cap: cut.filter((e) => e.cutBy === 'cap').length,
        cap_or_time_limit: cut.filter((e) => e.cutBy === 'cap_or_time_limit').length,
      },
    },
    fullAnswers: {
      count: full.length,
      medianMs: nearestRankPercentile(full, 50),
      p95Ms: nearestRankPercentile(full, 95),
      targetMs,
      overTarget: shareOf(full.length, full.filter((ms) => ms > targetMs).length),
    },
  };
}

function scoresOf(answers: readonly VaguenessAnswer[]): VaguenessScores {
  return {
    vagueness: vaguenessSummary(notNull(answers.map((a) => a.vagueness))),
    ending: answerEndingSummary(notNull(answers.map((a) => a.ending))),
  };
}

function measuredAny(scores: VaguenessScores): boolean {
  return scores.vagueness.answers > 0 || scores.ending.measured > 0;
}

/** The vagueness scores and answer endings of one mode: overall, by fine kind and by wording. */
export function vaguenessModeSummary(mode: SearchMode, answers: readonly VaguenessAnswer[]): VaguenessModeSummary {
  const ofMode = answers.filter((a) => a.mode === mode);
  return {
    mode,
    overall: scoresOf(ofMode),
    byKind: EVAL_QUESTION_KINDS.map((kind) => ({ kind, ...scoresOf(ofMode.filter((a) => a.kind === kind)) })).filter(
      measuredAny,
    ),
    byWording: EVAL_WORDINGS.map((wording) => ({
      wording,
      ...scoresOf(ofMode.filter((a) => a.wording === wording)),
    })).filter(measuredAny),
  };
}
