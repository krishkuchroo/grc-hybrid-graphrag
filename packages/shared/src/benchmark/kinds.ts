// The benchmark's kinds, parts, modes, outcomes and limits (S8-001; S8 shared notes, "Question kinds
// and scores"). One shared definition for the API, the web app and the benchmark command.
// - Question kinds: `single_hop` (one link from a named record), `multi_hop` (two links),
//   `framework` (a control's requirements; hand-written sets only), `no_answer` (a made-up name),
//   `injection_trap` (about a document that holds a planted instruction).
// - Parts: `retrieval` (searches only), `answers` (chat answers), `extraction` (full-pipeline orgs
//   only). Questions run in S6's search modes, `hybrid` and `vector`; extraction items in `pipeline`.
// - Extraction item kinds: `stated_fact` (a link the documents state), `extra_ai_link` (a live AI
//   link the answer key doesn't hold), `false_positive_plant`, `injection_plant` (add-links only) and
//   `analyst_decision` (an approved or rejected link finding).
// - An item's outcome is `pass`, `partial`, `fail` or `skipped` (with a reason code).
// Pure: no I/O, no clock, no randomness.
import { z } from 'zod';
import { SEARCH_LIMITS } from '../search/limits.js';
import { SEARCH_MODES } from '../search/modes.js';

export const BENCHMARK_QUESTION_KINDS = [
  'single_hop',
  'multi_hop',
  'framework',
  'no_answer',
  'injection_trap',
] as const;
export type BenchmarkQuestionKind = (typeof BENCHMARK_QUESTION_KINDS)[number];

export function isBenchmarkQuestionKind(v: unknown): v is BenchmarkQuestionKind {
  return typeof v === 'string' && (BENCHMARK_QUESTION_KINDS as readonly string[]).includes(v);
}

export const BENCHMARK_PARTS = ['retrieval', 'answers', 'extraction'] as const;
export type BenchmarkPart = (typeof BENCHMARK_PARTS)[number];

export function isBenchmarkPart(v: unknown): v is BenchmarkPart {
  return typeof v === 'string' && (BENCHMARK_PARTS as readonly string[]).includes(v);
}

/** The parts that ask the questions (searches and chat answers). */
export const BENCHMARK_QUESTION_PARTS = ['retrieval', 'answers'] as const;
export type BenchmarkQuestionPart = (typeof BENCHMARK_QUESTION_PARTS)[number];

/** The modes questions run in: S6's search modes. */
export const BENCHMARK_QUESTION_MODES = SEARCH_MODES;
export type BenchmarkQuestionMode = (typeof BENCHMARK_QUESTION_MODES)[number];

/** The one mode of extraction items. */
export const BENCHMARK_EXTRACTION_MODE = 'pipeline';

export const BENCHMARK_MODES = [...SEARCH_MODES, BENCHMARK_EXTRACTION_MODE] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

export function isBenchmarkMode(v: unknown): v is BenchmarkMode {
  return typeof v === 'string' && (BENCHMARK_MODES as readonly string[]).includes(v);
}

/** The modes each part runs in. */
export const BENCHMARK_PART_MODES: Readonly<Record<BenchmarkPart, readonly BenchmarkMode[]>> = Object.freeze({
  retrieval: BENCHMARK_QUESTION_MODES,
  answers: BENCHMARK_QUESTION_MODES,
  extraction: [BENCHMARK_EXTRACTION_MODE],
});

/** The planted instruction kinds (D52.6): the same names as `INJECTION_KINDS` in `@grc/generators`,
 * written out here because `@grc/shared` never imports from another package. */
export const BENCHMARK_INJECTION_KINDS = ['ignore_instructions', 'leak_data', 'add_links'] as const;
export type BenchmarkInjectionKind = (typeof BENCHMARK_INJECTION_KINDS)[number];

export function isBenchmarkInjectionKind(v: unknown): v is BenchmarkInjectionKind {
  return typeof v === 'string' && (BENCHMARK_INJECTION_KINDS as readonly string[]).includes(v);
}

export const EXTRACTION_ITEM_KINDS = [
  'stated_fact',
  'extra_ai_link',
  'false_positive_plant',
  'injection_plant',
  'analyst_decision',
] as const;
export type ExtractionItemKind = (typeof EXTRACTION_ITEM_KINDS)[number];

export function isExtractionItemKind(v: unknown): v is ExtractionItemKind {
  return typeof v === 'string' && (EXTRACTION_ITEM_KINDS as readonly string[]).includes(v);
}

/** Every kind a result item can have: a question kind, or an extraction item kind. */
export const BENCHMARK_ITEM_KINDS = [...BENCHMARK_QUESTION_KINDS, ...EXTRACTION_ITEM_KINDS] as const;
export type BenchmarkItemKind = (typeof BENCHMARK_ITEM_KINDS)[number];

export function isBenchmarkItemKind(v: unknown): v is BenchmarkItemKind {
  return typeof v === 'string' && (BENCHMARK_ITEM_KINDS as readonly string[]).includes(v);
}

/** The kinds each part's items have. */
export const BENCHMARK_PART_KINDS: Readonly<Record<BenchmarkPart, readonly BenchmarkItemKind[]>> = Object.freeze({
  retrieval: BENCHMARK_QUESTION_KINDS,
  answers: BENCHMARK_QUESTION_KINDS,
  extraction: EXTRACTION_ITEM_KINDS,
});

/** `pass`; `partial` (some of it right, nothing else wrong); `fail`; `skipped` (not scored, with a
 * reason code: it is counted but never averaged). */
export const BENCHMARK_OUTCOMES = ['pass', 'partial', 'fail', 'skipped'] as const;
export type BenchmarkOutcome = (typeof BENCHMARK_OUTCOMES)[number];

export function isBenchmarkOutcome(v: unknown): v is BenchmarkOutcome {
  return typeof v === 'string' && (BENCHMARK_OUTCOMES as readonly string[]).includes(v);
}

/** The skip reasons the benchmark's own code gives. Any other short code is allowed too. */
export const BENCHMARK_SKIP_REASONS = ['no_expected_records', 'expected_record_not_found', 'hidden'] as const;
export type BenchmarkSkipReason = (typeof BENCHMARK_SKIP_REASONS)[number];

/** Where a link an extraction item is about stands in the org: live on its own (`live_auto`), live
 * after the Analyst approved it (`live_approved`), waiting for the Analyst, rejected, removed after
 * going live, or not there at all (`absent`). */
export const EXTRACTION_LINK_STATES = [
  'live_auto',
  'live_approved',
  'waiting',
  'rejected',
  'removed',
  'absent',
] as const;
export type ExtractionLinkState = (typeof EXTRACTION_LINK_STATES)[number];

export function isExtractionLinkState(v: unknown): v is ExtractionLinkState {
  return typeof v === 'string' && (EXTRACTION_LINK_STATES as readonly string[]).includes(v);
}

/** The two live states. */
export const EXTRACTION_LIVE_STATES: readonly ExtractionLinkState[] = Object.freeze(['live_auto', 'live_approved']);

/** A run is `running` until the command finishes it (`finished`) or gives up (`failed`, with a code). */
export const BENCHMARK_RUN_STATUSES = ['running', 'finished', 'failed'] as const;
export type BenchmarkRunStatus = (typeof BENCHMARK_RUN_STATUSES)[number];

export function isBenchmarkRunStatus(v: unknown): v is BenchmarkRunStatus {
  return typeof v === 'string' && (BENCHMARK_RUN_STATUSES as readonly string[]).includes(v);
}

/** How a run ends: `finished`, or `failed` with its code. */
export const BENCHMARK_FINISH_OUTCOMES = ['finished', 'failed'] as const;
export type BenchmarkFinishOutcome = (typeof BENCHMARK_FINISH_OUTCOMES)[number];

export const BENCHMARK_LIMITS = Object.freeze({
  /** The most questions in one question set. */
  questionsPerSet: 200,
  /** The most result items in one batch. */
  itemsPerBatch: 25,
  /** A stored answer is cut to this many characters. */
  answerMaxLength: 4_000,
  /** The most expected records one question names. */
  expectedPerQuestion: 50,
  /** The most citations one answer holds: one per source in the context. */
  citationsPerAnswer: SEARCH_LIMITS.contextPassages + SEARCH_LIMITS.contextRecords,
  /** An item key or question ID: at most this many characters. */
  itemKeyMaxLength: 200,
  /** A short code (a skip reason, a failure code): at most this many characters. */
  codeMaxLength: 64,
});

/** A short code: a lowercase letter, then lowercase letters, digits and `_`; 1 to 64 characters. */
export const benchmarkCodeSchema = z
  .string()
  .max(BENCHMARK_LIMITS.codeMaxLength)
  .regex(/^[a-z][a-z0-9_]*$/);

/** An item key or question ID: a letter or digit, then letters, digits, `_`, `-`, `.` and `:`; 1 to
 * 200 characters. A question's ID is its items' key. */
export const benchmarkItemKeySchema = z
  .string()
  .max(BENCHMARK_LIMITS.itemKeyMaxLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

/** An org slug, as orgs are provisioned: lowercase letters and digits, joined by single hyphens. */
export const benchmarkOrgSlugSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * The answer cut to at most `BENCHMARK_LIMITS.answerMaxLength` UTF-16 code units, never between the
 * two halves of one character, so it is also at most that many characters to Postgres.
 */
export function cutBenchmarkAnswer(text: string): string {
  if (typeof text !== 'string') return '';
  const max = BENCHMARK_LIMITS.answerMaxLength;
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}
