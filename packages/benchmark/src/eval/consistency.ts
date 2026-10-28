// Same question, different words (EV-002 behaviour 2(c); D261 track A, item 3): the wordings of one
// fact (a group) must name the same records, whether or not those answers are right.
// - What an answer names: the org's records of the group's target kinds whose number or name the
//   answer text holds (`namesRecord`: both sides through `normaliseName`, whole words).
// - Measured: a group with at least 2 scored answers in the mode (not `skipped`, and not a `fail`
//   with no answer).
// - Consistent: every answer of the group names the same set of records. Any difference is an
//   inconsistency.
// - The score: consistent groups ÷ measured groups, overall and per fine kind.
// Pure: no I/O, no clock, no randomness.
import { normaliseName, type SearchMode } from '@grc/shared';
import { namesNormalised, recordMatcher, type RecordMatcher } from '../score/text.js';
import { EVAL_QUESTION_KINDS, type EvalQuestionKind } from './kinds.js';

/** An org record an answer may name, with its matcher made once. */
export interface NameableRecord {
  id: string;
  number: string;
  matcher: RecordMatcher;
}

/** A record an answer named: its internal ID and number. */
export interface NamedRecordRef {
  id: string;
  number: string;
}

/** The org's records as answers are matched against them, each matcher made once. */
export function nameableRecords(records: readonly { id: string; number: string; name: string }[]): NameableRecord[] {
  return records.map((r) => ({ id: r.id, number: r.number, matcher: recordMatcher(r) }));
}

/** The records the answer text names, in the order given, each once. */
export function namedRecords(answerText: string, records: readonly NameableRecord[]): NamedRecordRef[] {
  if (typeof answerText !== 'string') return [];
  const text = normaliseName(answerText);
  const seen = new Set<string>();
  const out: NamedRecordRef[] = [];
  for (const record of records) {
    if (seen.has(record.id) || !namesNormalised(text, record.matcher)) continue;
    seen.add(record.id);
    out.push({ id: record.id, number: record.number });
  }
  return out;
}

/** Whether every answer names the same set of record IDs. */
export function sameRecordSets(named: readonly (readonly string[])[]): boolean {
  if (named.length < 2) return true;
  const key = (ids: readonly string[]): string => JSON.stringify([...new Set(ids)].sort());
  const first = key(named[0]!);
  return named.every((ids) => key(ids) === first);
}

/** One measured group in one mode. */
export interface ConsistencyGroup {
  group: string;
  kind: EvalQuestionKind;
  mode: SearchMode;
  /** The scored answers compared. */
  answers: number;
  consistent: boolean;
}

/** Consistent groups ÷ measured groups; null when none was measured. */
export interface ConsistencyShare {
  measured: number;
  consistent: number;
  score: number | null;
}

export interface ConsistencyModeSummary extends ConsistencyShare {
  mode: SearchMode;
  byKind: (ConsistencyShare & { kind: EvalQuestionKind })[];
  groups: ConsistencyGroup[];
}

/** One scored answer, as consistency reads it. */
export interface ConsistencyAnswer {
  group: string;
  kind: EvalQuestionKind;
  mode: SearchMode;
  /** The IDs of the records it named. */
  named: readonly string[];
}

function shareOf(groups: readonly ConsistencyGroup[]): ConsistencyShare {
  const consistent = groups.filter((g) => g.consistent).length;
  return { measured: groups.length, consistent, score: groups.length === 0 ? null : consistent / groups.length };
}

/** The consistency of one mode's scored answers: each group with at least 2, in the order the
 * groups first come; per fine kind in `EVAL_QUESTION_KINDS`' order, those with measured groups. */
export function consistencySummary(mode: SearchMode, answers: readonly ConsistencyAnswer[]): ConsistencyModeSummary {
  const byGroup = new Map<string, ConsistencyAnswer[]>();
  for (const answer of answers) {
    if (answer.mode !== mode) continue;
    const list = byGroup.get(answer.group);
    if (list === undefined) byGroup.set(answer.group, [answer]);
    else list.push(answer);
  }
  const groups: ConsistencyGroup[] = [];
  for (const [group, list] of byGroup) {
    if (list.length < 2) continue;
    groups.push({
      group,
      kind: list[0]!.kind,
      mode,
      answers: list.length,
      consistent: sameRecordSets(list.map((a) => a.named)),
    });
  }
  const byKind = EVAL_QUESTION_KINDS.map((kind) => ({
    kind,
    ...shareOf(groups.filter((g) => g.kind === kind)),
  })).filter((row) => row.measured > 0);
  return { mode, ...shareOf(groups), byKind, groups };
}
