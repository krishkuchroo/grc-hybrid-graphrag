// Duplicate matching (D43, D70; S4 shared notes, "Duplicate matching"): the steps, the outcomes, the
// name normalising the exact step uses, the digit rule, the spelling score and the cut-offs. The
// matcher itself (S4-007) reads the graph; everything here is pure. The cut-offs are the planner's
// starting values, and the benchmark tunes them later (S8).

/** Tried in this order: the same name after `normaliseName` (or the record's number or a source
 * ID), then close spelling (the `record_names` full-text index, scored by `editSimilarity`), then
 * close meaning (the label's `<label>_name_embedding` vector index, cosine). */
export const MATCH_STEPS = ['exact', 'spelling', 'meaning'] as const;
export type MatchStep = (typeof MATCH_STEPS)[number];

export function isMatchStep(v: unknown): v is MatchStep {
  return typeof v === 'string' && (MATCH_STEPS as readonly string[]).includes(v);
}

/** `clear`: one record is the match. `uncertain`: up to `MAX_MATCH_CANDIDATES` candidates for the
 * Analyst. `none`: nothing close enough. */
export const MATCH_OUTCOMES = ['clear', 'uncertain', 'none'] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

export function isMatchOutcome(v: unknown): v is MatchOutcome {
  return typeof v === 'string' && (MATCH_OUTCOMES as readonly string[]).includes(v);
}

/** A spelling score at or above this is a clear match (if it leads the next by the margin). */
export const SPELLING_CLEAR_SCORE = 0.92;
/** A spelling score at or above this is kept as a candidate. */
export const SPELLING_CANDIDATE_SCORE = 0.8;
/** A meaning (cosine) score at or above this is a clear match (if it leads the next by the margin). */
export const MEANING_CLEAR_SCORE = 0.9;
/** A meaning (cosine) score at or above this is kept as a candidate. */
export const MEANING_CANDIDATE_SCORE = 0.8;
/** A clear spelling or meaning match leads the next candidate by at least this much. */
export const CLEAR_MATCH_MARGIN = 0.05;
/** At most this many candidates are kept for an uncertain match. */
export const MAX_MATCH_CANDIDATES = 3;

/**
 * The name as the exact step compares it: Unicode-folded (compatibility forms and accents dropped,
 * invisible format characters removed), lowercase, every run of spaces, punctuation, `_` and `-`
 * made one space, trimmed. `Payroll-DB`, `payroll db` and ` PAYROLL_DB ` all give `payroll db`.
 * A name with nothing left (only spaces or punctuation) gives `''`, which matches nothing.
 */
export function normaliseName(name: string): string {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\p{Cf}+/gu, '')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{Cc}]+/gu, ' ')
    .trim();
}

/** The runs of digits in a name, in order, after `normaliseName`. */
function digitRuns(name: string): string[] {
  return normaliseName(name).match(/\p{Nd}+/gu) ?? [];
}

/**
 * Whether two names carry the same digits, run by run and in order (leading zeros count). Names
 * whose digits differ never match by spelling or meaning: `srv-app-01` is not `srv-app-02`.
 */
export function digitsAgree(a: string, b: string): boolean {
  const left = digitRuns(a);
  const right = digitRuns(b);
  return left.length === right.length && left.every((run, i) => run === right[i]);
}

/** The edit (Levenshtein) distance between two lists of characters. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * How alike two names are spelled, from 0 to 1: one minus the edit distance between their
 * `normaliseName` forms, over the longer one's length (counted in characters). The same name gives
 * 1; a name with nothing left after normalising matches nothing and gives 0.
 */
export function editSimilarity(a: string, b: string): number {
  const left = Array.from(normaliseName(a));
  const right = Array.from(normaliseName(b));
  if (left.length === 0 || right.length === 0) return 0;
  const longest = Math.max(left.length, right.length);
  return 1 - editDistance(left, right) / longest;
}
