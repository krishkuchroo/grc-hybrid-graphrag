// Plain words for the review screen (D2, screen 8): each finding kind, each status and each failed
// rule check, so the API, the web app and the benchmark say the same thing.
import type { ReviewFindingKind, ReviewFindingStatus } from '../processing/findings.js';
import type { RuleCheck } from '../processing/rule-checks.js';

export const REVIEW_KIND_TEXT: Readonly<Record<ReviewFindingKind, string>> = Object.freeze({
  link: 'Link',
  record: 'New record',
  duplicate: 'Possible duplicate',
  mapping: 'Suggested mapping',
});

export const REVIEW_STATUS_TEXT: Readonly<Record<ReviewFindingStatus, string>> = Object.freeze({
  pending: 'Waiting',
  live: 'Live',
  approved: 'Approved',
  rejected: 'Rejected',
  removed: 'Removed',
});

/** Why a link waits: the rule check it failed, in plain words. */
export const RULE_CHECK_TEXT: Readonly<Record<RuleCheck, string>> = Object.freeze({
  same_sentence: "The sentence doesn't name both records",
  ontology_fit: "This kind of link doesn't fit these records",
  both_ends_known: 'Not sure which record is meant',
});

/** The words for a finding kind; anything unknown is shown as it is. */
export function reviewKindText(kind: string): string {
  return Object.hasOwn(REVIEW_KIND_TEXT, kind) ? REVIEW_KIND_TEXT[kind as ReviewFindingKind] : kind;
}

/** The words for a finding status; anything unknown is shown as it is. */
export function reviewStatusText(status: string): string {
  return Object.hasOwn(REVIEW_STATUS_TEXT, status) ? REVIEW_STATUS_TEXT[status as ReviewFindingStatus] : status;
}

/** The words for a failed rule check; anything unknown is shown as it is. */
export function ruleCheckText(check: string): string {
  return Object.hasOwn(RULE_CHECK_TEXT, check) ? RULE_CHECK_TEXT[check as RuleCheck] : check;
}
