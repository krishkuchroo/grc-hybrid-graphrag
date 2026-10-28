// Fixed templates (EV-001 behaviour 8; D261 track A, item 1): hand-found failures of Ask, kept word
// for word so every generated set asks them again. Each comes first in the set, as its own group
// `fixed-<name>` with its one `reported` question (`fixed-<name>.reported`). A template whose keys
// aren't all records of the folder is left out and counted. Empty here; EV-004 adds the first.
import type { SearchRecordKind } from '@grc/shared';
import type { OrgGraph } from '../questions/org-graph.js';

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

export const FIXED_QUESTIONS: readonly FixedQuestion[] = Object.freeze([]);

/** Every answer-key record the fixed templates rest on. */
export function fixedQuestionKeys(): Set<string> {
  return new Set(FIXED_QUESTIONS.flatMap((q) => q.keys));
}
