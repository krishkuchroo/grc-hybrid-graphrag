// How the Analyst review screen (D27 #8) says things: link and mapping types, matching steps,
// scores, record kinds, ages and the decision routes' refusals, in plain words (D2). The finding
// kinds, statuses and failed checks come from @grc/shared (S5-001), so the API, the web app and
// the benchmark say the same thing.
import {
  isReviewErrorCode,
  LINK_TYPES,
  MAPPING_LINK_TYPES,
  REVIEW_ERRORS,
  type MatchStep,
  type ReviewFindingKind,
  type ReviewRecordKind,
} from '@grc/shared';
import { ApiError } from '@/api/client';
import { formatDay } from '@/features/records/format';

/** What a record the reader may not see (or that is gone) reads as, everywhere on the screen. */
export const HIDDEN_RECORD_TEXT = 'A record you can’t see';

/** The same words inside a sentence. */
export const HIDDEN_RECORD_INLINE = 'a record you can’t see';

/** What a source document the reader may not read reads as. */
export const HIDDEN_DOCUMENT_TEXT = 'A document you can’t see';

/** The tab names, one per finding kind, in the order the screen shows them. */
export const KIND_TAB_TEXT: Readonly<Record<ReviewFindingKind, string>> = {
  link: 'Links',
  record: 'New records',
  duplicate: 'Possible duplicates',
  mapping: 'Suggested mappings',
};

export const RECORD_KIND_TEXT: Readonly<Record<ReviewRecordKind, string>> = {
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
  requirement: 'Requirement',
};

/** `EXPOSED_TO` → `exposed to`; also `SATISFIES` → `satisfies` and `MAPS_TO` → `maps to`. */
export function linkTypeText(type: string): string {
  return type.toLowerCase().replace(/_/g, ' ').trim();
}

/** The two kinds a link type joins, `from` first, or undefined for a type we don't know. */
export function linkEndsOf(type: string): { from: ReviewRecordKind; to: ReviewRecordKind } | undefined {
  const row =
    LINK_TYPES.find((t) => t.type === type) ??
    (MAPPING_LINK_TYPES as readonly { type: string; from: ReviewRecordKind; to: ReviewRecordKind }[]).find(
      (t) => t.type === type,
    );
  return row ? { from: row.from, to: row.to } : undefined;
}

/** How matching found a candidate record (S4's three steps). */
export const MATCH_STEP_TEXT: Readonly<Record<MatchStep, string>> = {
  exact: 'Same name',
  spelling: 'Close spelling',
  meaning: 'Close meaning',
};

export function matchStepText(step: string): string {
  return Object.hasOwn(MATCH_STEP_TEXT, step) ? MATCH_STEP_TEXT[step as MatchStep] : step;
}

/** A noun with its article: `incident` → `an incident`, `risk` → `a risk`. */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** A score from 0 to 1 as a whole percentage: `0.873` → `87%`. */
export function percent(score: number): string {
  if (!Number.isFinite(score)) return '';
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

/** A nullable text field as the generated client types it (`unknown`): the text, or null. */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

const STEPS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number; upTo: number }> = [
  { unit: 'minute', ms: 60_000, upTo: 60 },
  { unit: 'hour', ms: 3_600_000, upTo: 24 },
  { unit: 'day', ms: 86_400_000, upTo: 7 },
  { unit: 'week', ms: 7 * 86_400_000, upTo: 5 },
];

/** How long ago a moment was, in a few words (`5 minutes ago`, `Yesterday`, `3 weeks ago`), or its
 * day once it is more than about a month old. */
export function formatAge(value: string, now: number = Date.now()): string {
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return value;
  const ago = now - at;
  if (ago < 60_000) return 'Just now';
  for (const step of STEPS) {
    const n = Math.floor(ago / step.ms);
    if (n < step.upTo) {
      const text = RELATIVE.format(-n, step.unit);
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  return formatDay(value);
}

/** A person by display name, or what to say when the name can't be found. */
export function personText(person: { id: string; name: unknown } | null | undefined): string {
  if (!person) return '—';
  return textOrNull(person.name) ?? 'A former member';
}

export type DecisionAction = 'approve' | 'reject';

/**
 * A refused decision in plain words, keeping the API's code and reference ID (D47). The S5 codes
 * use S5-001's shared messages; 403 and 404 get the screen's own words.
 */
export function decisionRefusal(error: unknown, action: DecisionAction, kind: ReviewFindingKind): ApiError | unknown {
  if (!(error instanceof ApiError)) return error;
  let message = error.message;
  if (isReviewErrorCode(error.code)) {
    message = REVIEW_ERRORS[error.code].message;
  } else if (error.status === 403) {
    message =
      action === 'approve' && kind === 'mapping'
        ? 'Only an Analyst with the right to approve framework mappings can approve a suggested mapping.'
        : 'Only an Analyst can approve or reject findings. Your role can see the queue but not decide.';
  } else if (error.status === 404) {
    message = 'This finding, or a record it names, doesn’t exist or you can’t see it.';
  } else if (error.code === 'validation_failed') {
    message = 'The decision couldn’t be read. A note can be up to 1,000 characters.';
  }
  return new ApiError(error.status, error.code, message, error.referenceId);
}

/** The title over a refused decision. */
export function decisionRefusalTitle(action: DecisionAction): string {
  return action === 'approve' ? 'The finding wasn’t approved' : 'The finding wasn’t rejected';
}
