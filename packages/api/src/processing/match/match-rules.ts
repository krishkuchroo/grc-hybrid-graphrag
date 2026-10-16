// Duplicate matching's pure parts (S4-007; D43, D70; S4 shared notes, "Duplicate matching"): the
// full-text query a name asks, the exact step, the spelling and meaning candidates with the digit
// rule, when a step's best is a clear match, how a name's match is decided, and how a record's
// duplicate check is decided. The cut-offs, `normaliseName`, `digitsAgree` and `editSimilarity`
// are S4-001's, in @grc/shared. Nothing here reads the graph (./name-matcher.ts and
// ./record-dedupe.job.ts do).
import {
  CLEAR_MATCH_MARGIN,
  LABELS,
  MATCH_STEPS,
  MAX_MATCH_CANDIDATES,
  MEANING_CANDIDATE_SCORE,
  MEANING_CLEAR_SCORE,
  SPELLING_CANDIDATE_SCORE,
  SPELLING_CLEAR_SCORE,
  digitsAgree,
  editSimilarity,
  normaliseName,
  parseNumber,
  type Label,
  type MatchCandidate,
  type MatchStep,
} from '@grc/shared';

/** An active record of one kind, as the matcher reads it. */
export interface StoredName {
  id: string;
  number: string;
  name: string;
  label: Label;
  sourceIds: string[];
  version: number;
}

/** A stored record with its name as the exact step compares it (`normaliseName`). */
export interface KeyedName extends StoredName {
  key: string;
}

/** A vector index hit: the record and the index's score. */
export interface ScoredName {
  record: StoredName;
  score: number;
}

/** A candidate with the record's label, so a caller can label what it shows (D51). */
export interface RankedCandidate {
  candidate: MatchCandidate;
  label: Label;
}

/** What a name in a document means (S4 shared notes, "Duplicate matching"). `label` is the clear
 * match's, or for an uncertain one the highest of its candidates'. */
export type NameMatch =
  | { outcome: 'clear'; match: MatchCandidate; label: Label }
  | { outcome: 'uncertain'; candidates: MatchCandidate[]; label: Label }
  | { outcome: 'none' };

export const NO_MATCH: NameMatch = Object.freeze({ outcome: 'none' });

/** The most words of a name its full-text query uses. */
export const FULLTEXT_MAX_TERMS = 16;
/** Full-text hits read per name, after the kind, status and label filters. */
export const FULLTEXT_HITS = 50;
/** Nearest neighbours asked of a vector index per name, before the status and label filters. */
export const VECTOR_NEIGHBOURS = 50;

// Two scores this close count as equal (floating-point noise in a difference of rounded scores).
const EPSILON = 1e-9;

// Lucene's classic query syntax characters, escaped with a backslash.
const LUCENE_SPECIAL = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/**
 * The Lucene query a name asks of the `record_names` full-text index: each word of the name after
 * `normaliseName` (at most `FULLTEXT_MAX_TERMS`), as itself, as a fuzzy term (one edit from 4
 * characters, two from 8) and as a prefix (from 3 characters), any word matching. Null when the
 * name has no words. The index only finds the candidates; `editSimilarity` scores them.
 */
export function fullTextQuery(name: string): string | null {
  const terms = normaliseName(name)
    .split(' ')
    .filter((t) => t !== '')
    .slice(0, FULLTEXT_MAX_TERMS);
  if (terms.length === 0) return null;
  return terms
    .map((term) => {
      const escaped = term.replace(LUCENE_SPECIAL, '\\$&');
      const length = Array.from(term).length;
      const parts = [escaped];
      const edits = length >= 8 ? 2 : length >= 4 ? 1 : 0;
      if (edits > 0) parts.push(`${escaped}~${edits}`);
      if (length >= 3) parts.push(`${escaped}*`);
      return parts.length === 1 ? escaped : `(${parts.join(' OR ')})`;
    })
    .join(' OR ');
}

/** Adds the exact step's key to each record, once per read. */
export function keyed(records: readonly StoredName[]): KeyedName[] {
  return records.map((r) => ({ ...r, key: normaliseName(r.name) }));
}

// A source ID is `<source>:<the source's own ID>` (S3, imported assets): the text may be either.
function sourceIdIs(sourceId: string, text: string): boolean {
  const stored = sourceId.trim().toLowerCase();
  if (stored === '') return false;
  if (stored === text) return true;
  const colon = stored.indexOf(':');
  return colon > 0 && colon < stored.length - 1 && stored.slice(colon + 1) === text;
}

/**
 * The exact step for a name as written: the records whose name after `normaliseName` is the same,
 * or whose number is the text, or one of whose source IDs is the text (the whole alias or the
 * source's own ID after it), ordered by number. A name with nothing left after normalising matches
 * nothing.
 */
export function exactMatches(records: readonly KeyedName[], name: string): KeyedName[] {
  const key = normaliseName(name);
  if (key === '') return [];
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  return records
    .filter((r) => r.key === key || r.number === upper || r.sourceIds.some((s) => sourceIdIs(s, lower)))
    .sort(byNumber);
}

/** The records with the same name after `normaliseName` as `self`'s, `self` left out, by number. */
export function sameNames(records: readonly KeyedName[], self: StoredName): KeyedName[] {
  const key = normaliseName(self.name);
  if (key === '') return [];
  return records.filter((r) => r.id !== self.id && r.key === key).sort(byNumber);
}

/** Lower number first (the older record, D196). */
export function byNumber(a: Pick<StoredName, 'number'>, b: Pick<StoredName, 'number'>): number {
  const left = parseNumber(a.number)?.n ?? Number.MAX_SAFE_INTEGER;
  const right = parseNumber(b.number)?.n ?? Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
}

/** A score kept to 4 places, between 0 and 1, so the same inputs always give the same proposal. */
function roundScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.min(1, Math.max(0, score)) * 10_000) / 10_000;
}

function ranked(record: StoredName, step: MatchStep, score: number): RankedCandidate {
  return {
    candidate: { recordId: record.id, number: record.number, name: record.name, step, score: roundScore(score) },
    label: record.label,
  };
}

const STEP_ORDER = new Map(MATCH_STEPS.map((step, i) => [step, i] as const));

/** Higher score first, then the earlier step, then the lower number. */
function byScore(a: RankedCandidate, b: RankedCandidate): number {
  const score = b.candidate.score - a.candidate.score;
  if (Math.abs(score) > EPSILON) return score;
  const step = (STEP_ORDER.get(a.candidate.step) ?? 0) - (STEP_ORDER.get(b.candidate.step) ?? 0);
  return step !== 0 ? step : byNumber(a.candidate, b.candidate);
}

/** Sorted best first, each record once (its best entry). */
function bestFirst(list: readonly RankedCandidate[]): RankedCandidate[] {
  const seen = new Set<string>();
  return [...list].sort(byScore).filter((c) => {
    if (seen.has(c.candidate.recordId)) return false;
    seen.add(c.candidate.recordId);
    return true;
  });
}

/** The exact matches as candidates (step `exact`, score 1). */
export function exactCandidates(records: readonly StoredName[]): RankedCandidate[] {
  return records.map((r) => ranked(r, 'exact', 1));
}

/**
 * Every full-text hit whose digits agree with the name's, scored by `editSimilarity`, best first.
 * Hits with no name are dropped.
 */
export function spellingScores(name: string, hits: readonly StoredName[]): RankedCandidate[] {
  return bestFirst(
    hits
      .filter((r) => r.name.trim() !== '' && digitsAgree(name, r.name))
      .map((r) => ranked(r, 'spelling', editSimilarity(name, r.name))),
  );
}

/**
 * The cosine of a hit from Neo4j's vector index score: for cosine indexes Neo4j answers
 * (1 + cosine) / 2, between 0 and 1. Negative cosines count as 0.
 */
export function cosineOf(indexScore: number): number {
  if (!Number.isFinite(indexScore)) return 0;
  return Math.min(1, Math.max(0, 2 * indexScore - 1));
}

/** Every vector hit whose digits agree with the name's, scored by cosine, best first. */
export function meaningScores(name: string, hits: readonly ScoredName[]): RankedCandidate[] {
  return bestFirst(
    hits
      .filter((h) => h.record.name.trim() !== '' && digitsAgree(name, h.record.name))
      .map((h) => ranked(h.record, 'meaning', cosineOf(h.score))),
  );
}

/** The step's best, when it is at or above `clearAt` and ahead of the next by the margin. */
function clearLeader(scores: readonly RankedCandidate[], clearAt: number): RankedCandidate | null {
  const [first, second] = scores;
  if (!first || first.candidate.score + EPSILON < clearAt) return null;
  if (second && first.candidate.score - second.candidate.score + EPSILON < CLEAR_MATCH_MARGIN) return null;
  return first;
}

/** The spelling step's clear match, if it has one. */
export function clearBySpelling(scores: readonly RankedCandidate[]): RankedCandidate | null {
  return clearLeader(scores, SPELLING_CLEAR_SCORE);
}

/** The meaning step's clear match, if it has one. */
export function clearByMeaning(scores: readonly RankedCandidate[]): RankedCandidate | null {
  return clearLeader(scores, MEANING_CLEAR_SCORE);
}

/** The spelling and meaning scores at or above their candidate cut-offs, each record once, best
 * first, at most `MAX_MATCH_CANDIDATES`. */
export function topCandidates(
  spelling: readonly RankedCandidate[],
  meaning: readonly RankedCandidate[],
): RankedCandidate[] {
  return bestFirst([
    ...spelling.filter((c) => c.candidate.score + EPSILON >= SPELLING_CANDIDATE_SCORE),
    ...meaning.filter((c) => c.candidate.score + EPSILON >= MEANING_CANDIDATE_SCORE),
  ]).slice(0, MAX_MATCH_CANDIDATES);
}

/** The higher of two labels (D51). */
export function higherLabel(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

function highest(list: readonly RankedCandidate[]): Label {
  return list.reduce<Label>((top, c) => higherLabel(top, c.label), 'public');
}

function clear(c: RankedCandidate): NameMatch {
  return { outcome: 'clear', match: c.candidate, label: c.label };
}

function uncertain(list: readonly RankedCandidate[]): NameMatch {
  if (list.length === 0) return NO_MATCH;
  const kept = list.slice(0, MAX_MATCH_CANDIDATES);
  return { outcome: 'uncertain', candidates: kept.map((c) => c.candidate), label: highest(kept) };
}

/** After the exact step: one record is a clear match, several are uncertain, none goes on (null). */
export function decideExact(exact: readonly StoredName[]): NameMatch | null {
  if (exact.length === 1) return clear(exactCandidates(exact)[0]!);
  if (exact.length > 1) return uncertain(exactCandidates(exact));
  return null;
}

/** After the spelling step: its clear match, or null to go on to meaning. */
export function decideSpelling(spelling: readonly RankedCandidate[]): NameMatch | null {
  const leader = clearBySpelling(spelling);
  return leader ? clear(leader) : null;
}

/** After the meaning step: its clear match, else the candidates of both steps, else none. */
export function decideMeaning(spelling: readonly RankedCandidate[], meaning: readonly RankedCandidate[]): NameMatch {
  const leader = clearByMeaning(meaning);
  if (leader) return clear(leader);
  return uncertain(topCandidates(spelling, meaning));
}

/** What a record's duplicate check does (S4-007, planner's reading S4-Q3). */
export type DedupeDecision =
  { kind: 'merge'; other: StoredName } | { kind: 'flag'; pairs: RankedCandidate[] } | { kind: 'nothing' };

/** Whether the exact step alone settles the check: exactly one other record has the same name
 * after `normaliseName`, and it has the same label. */
export function mergeable(self: StoredName, same: readonly StoredName[]): StoredName | null {
  const [only] = same;
  return same.length === 1 && only !== undefined && only.label === self.label ? only : null;
}

/**
 * The duplicate check's decision for `self`: a merge when `mergeable`; otherwise every other record
 * with the same name (a different label, or more than one), and the spelling and meaning candidates
 * at or above their cut-offs, each one possible duplicate pair (each record once, best first, at
 * most `MAX_MATCH_CANDIDATES`); nothing when there are none.
 */
export function decideDuplicates(
  self: StoredName,
  same: readonly StoredName[],
  spelling: readonly RankedCandidate[],
  meaning: readonly RankedCandidate[],
): DedupeDecision {
  const other = mergeable(self, same);
  if (other) return { kind: 'merge', other };
  const others = (list: readonly RankedCandidate[]) => list.filter((c) => c.candidate.recordId !== self.id);
  const pairs = bestFirst([...exactCandidates(same), ...topCandidates(others(spelling), others(meaning))]).slice(
    0,
    MAX_MATCH_CANDIDATES,
  );
  return pairs.length === 0 ? { kind: 'nothing' } : { kind: 'flag', pairs };
}
