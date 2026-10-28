// Fixed templates (EV-001 behaviour 8; D261 track A, item 1): hand-found failures of Ask, kept word
// for word so every generated set asks them again. Each comes first in the set, as its own group
// `fixed-<name>` with its one `reported` question (`fixed-<name>.reported`). A template whose keys
// aren't all records of the folder is left out and counted. EV-004 added the first (D261).
import type { SearchRecordKind } from '@grc/shared';
import type { OrgGraph } from '../questions/org-graph.js';
import { cypherString } from './gold-queries.js';

export interface FixedQuestion {
  /** Its ID is `fixed-<name>.reported`. */
  name: string;
  /** Word for word as the user asked it. */
  text: string;
  setKind: 'single_hop' | 'multi_hop' | 'framework';
  /** The answer-key records it rests on (EV-003 leaves them alone). */
  keys: readonly string[];
  /** The records a right answer names, from the folder's graph. */
  expected(graph: OrgGraph): { kind: SearchRecordKind; key: string }[];
  targetKinds: readonly SearchRecordKind[];
  /**
   * Its correct graph query. `nameOf` gives a record's name as it is; inline it with
   * `cypherString` (gold-queries.ts).
   */
  goldQuery(nameOf: (key: string) => string): string;
}

/** The phishing question's risk: "Phishing: Spearphishing Attachment" in Company X. */
const PHISHING_RISK = 'RSK-0036';

/**
 * The hand-found failures, oldest first.
 *
 * `phishing-findings` (D261, Q-EV-1 (a)): on 2026-10-27, after round 2 (D259), the user asked Ask
 * on Company X "Identify any findings related to Phishing Attacks" and it failed:
 * - the graph query read "findings" as AuditFinding;
 * - the answer was one line long;
 * - the "Not reviewed yet" list matched 0 of 455 pending links;
 * - the first words came after 26.9 s (D48's target is 25 s).
 * The right answer is the risk "Phishing: Spearphishing Attachment" and the 7 "Phishing on …"
 * incidents that expose it: 8 records.
 */
export const FIXED_QUESTIONS: readonly FixedQuestion[] = Object.freeze([
  Object.freeze({
    name: 'phishing-findings',
    text: 'Identify any findings related to Phishing Attacks',
    setKind: 'single_hop',
    keys: Object.freeze([
      PHISHING_RISK,
      'INC-0002',
      'INC-0004',
      'INC-0011',
      'INC-0014',
      'INC-0022',
      'INC-0027',
      'INC-0029',
    ]),
    expected(graph: OrgGraph): { kind: SearchRecordKind; key: string }[] {
      const incidents = graph
        .follow(PHISHING_RISK, [{ types: ['EXPOSES'], direction: 'in' }])
        .filter((key) => graph.record(key)?.kind === 'incident');
      return [{ kind: 'risk', key: PHISHING_RISK }, ...incidents.map((key) => ({ kind: 'incident' as const, key }))];
    },
    targetKinds: Object.freeze(['risk', 'incident'] as const),
    goldQuery(nameOf: (key: string) => string): string {
      return (
        `MATCH (r:Risk {name: ${cypherString(nameOf(PHISHING_RISK))}}) ` +
        'OPTIONAL MATCH (i:Incident)-[:EXPOSES]->(r) ' +
        'WITH collect(DISTINCT r) + collect(DISTINCT i) AS xs UNWIND xs AS x RETURN DISTINCT x'
      );
    },
  }),
]);

/** Every answer-key record the fixed templates rest on. */
export function fixedQuestionKeys(): Set<string> {
  return new Set(FIXED_QUESTIONS.flatMap((q) => q.keys));
}
