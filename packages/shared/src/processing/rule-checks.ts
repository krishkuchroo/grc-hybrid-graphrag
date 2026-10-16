// The rule checks (D39; S4 shared notes, "Rule checks"): what makes an extracted link confident. All
// three pass and the link goes live; any one fails and it waits for the Analyst with its failed checks
// listed. No Gemma self-rating and no double runs: these checks are the whole decision.
import { isAllowedLink } from '../records/links.js';

/**
 * `same_sentence`: the sentence is in the chunk's text and both ends' names, as written, are in that
 * sentence. `ontology_fit`: the link type and direction fit the ontology for the two ends' kinds.
 * `both_ends_known`: both ends are clear matches of existing records.
 */
export const RULE_CHECKS = ['same_sentence', 'ontology_fit', 'both_ends_known'] as const;
export type RuleCheck = (typeof RULE_CHECKS)[number];

export function isRuleCheck(v: unknown): v is RuleCheck {
  return typeof v === 'string' && (RULE_CHECKS as readonly string[]).includes(v);
}

export interface RuleCheckEnd {
  /** The name exactly as Gemma wrote it. */
  name: string;
  /** The matched record's kind, or Gemma's kind when the end has no clear match. */
  kind: string;
  /** Whether the end is a clear match of an existing record. */
  clearMatch: boolean;
}

export interface RuleCheckInput {
  /** The link type Gemma gave. */
  type: string;
  /** The sentence Gemma copied. */
  sentence: string;
  /** The chunk's own text. */
  chunkText: string;
  from: RuleCheckEnd;
  to: RuleCheckEnd;
}

/** Text with its spacing ignored: one canonical Unicode form, every run of white space one space,
 * trimmed. Letters, case and punctuation are kept as written. */
function squashSpacing(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

function sameSentence(input: RuleCheckInput): boolean {
  const sentence = squashSpacing(input.sentence);
  const from = squashSpacing(input.from.name);
  const to = squashSpacing(input.to.name);
  if (sentence === '' || from === '' || to === '') return false;
  return squashSpacing(input.chunkText).includes(sentence) && sentence.includes(from) && sentence.includes(to);
}

/** The checks the link fails, in `RULE_CHECKS` order; an empty list means it may go live. */
export function failedRuleChecks(input: RuleCheckInput): RuleCheck[] {
  const failed: RuleCheck[] = [];
  if (!sameSentence(input)) failed.push('same_sentence');
  if (!isAllowedLink(input.type, input.from.kind, input.to.kind)) failed.push('ontology_fit');
  if (input.from.clearMatch !== true || input.to.clearMatch !== true) failed.push('both_ends_known');
  return failed;
}
