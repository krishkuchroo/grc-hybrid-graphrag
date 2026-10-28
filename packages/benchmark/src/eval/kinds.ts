// The generated evaluation set's names (EV-001; D261 track A): the fine question kinds, the
// wordings, the mix's weights and the set's size limits. Pure: no I/O.
import { BENCHMARK_LIMITS, type BenchmarkQuestionKind } from '@grc/shared';

/**
 * The fine kinds of an evaluation question: what the question asks about. `fixed` is a hand-found
 * failure kept as a template (`FIXED_QUESTIONS`), asked word for word.
 */
export const EVAL_QUESTION_KINDS = [
  'mitigated_by',
  'impacts',
  'governs',
  'two_step',
  'framework',
  'no_answer',
  'injection',
  'fixed',
] as const;
export type EvalQuestionKind = (typeof EVAL_QUESTION_KINDS)[number];

/** The fine kinds the generator makes from the folder's facts (all but `fixed`). */
export type GeneratedEvalKind = Exclude<EvalQuestionKind, 'fixed'>;

/**
 * How a question is worded: `plain` (the hand-written set's own wording), `loose` (as a person
 * might ask it), `typo` (typos and short forms) and `reported` (a fixed template's own words).
 */
export const EVAL_WORDINGS = ['plain', 'loose', 'typo', 'reported'] as const;
export type EvalWording = (typeof EVAL_WORDINGS)[number];

/** The wordings of one generated group, in the order its questions come. */
export const GROUP_WORDINGS = ['plain', 'loose', 'typo'] as const satisfies readonly EvalWording[];

/** The question-set kind each generated fine kind is written as (a fixed one names its own). */
export const EVAL_SET_KIND: Readonly<Record<GeneratedEvalKind, BenchmarkQuestionKind>> = Object.freeze({
  mitigated_by: 'single_hop',
  impacts: 'single_hop',
  governs: 'single_hop',
  two_step: 'multi_hop',
  framework: 'framework',
  no_answer: 'no_answer',
  injection: 'injection_trap',
});

/**
 * The mix: each kind's weight, in the order the kinds come in the set and the order the groups
 * left over after rounding down are given out.
 */
export const EVAL_MIX: readonly { kind: GeneratedEvalKind; weight: number }[] = Object.freeze([
  { kind: 'mitigated_by', weight: 20 },
  { kind: 'two_step', weight: 20 },
  { kind: 'impacts', weight: 16 },
  { kind: 'governs', weight: 16 },
  { kind: 'framework', weight: 16 },
  { kind: 'no_answer', weight: 8 },
  { kind: 'injection', weight: 4 },
]);

/** The kinds a shortfall is passed on to, round-robin in this order, while they have facts left. */
export const SHORTFALL_ORDER: readonly GeneratedEvalKind[] = Object.freeze([
  'mitigated_by',
  'two_step',
  'framework',
  'no_answer',
]);

/** Each kind draws from its own seeded sequence, so one kind's count moves nothing else. */
export const EVAL_STREAMS: Readonly<Record<GeneratedEvalKind, number>> = Object.freeze({
  mitigated_by: 1,
  impacts: 2,
  governs: 3,
  two_step: 4,
  framework: 5,
  no_answer: 6,
  injection: 7,
});

/** How many expected records a fact of each kind may have (none for `no_answer`). */
export const EVAL_EXPECTED_BOUNDS: Readonly<Record<Exclude<GeneratedEvalKind, 'no_answer'>, [number, number]>> =
  Object.freeze({
    mitigated_by: [1, 30],
    impacts: [1, 30],
    governs: [1, 30],
    two_step: [1, 30],
    framework: [3, 20],
    injection: [1, BENCHMARK_LIMITS.expectedPerQuestion],
  });

/** The fewest questions a set may be asked for. */
export const EVAL_MIN_COUNT = 30;
/** The most: the question-set format's own limit. */
export const EVAL_MAX_COUNT = BENCHMARK_LIMITS.questionsPerSet;
export const EVAL_DEFAULT_COUNT = 150;
export const EVAL_DEFAULT_SEED = 1;

/** A generated group's ID: `<fine kind>-<nn>` (`mitigated_by-03`). */
export function evalGroupId(kind: GeneratedEvalKind, n: number): string {
  return `${kind}-${String(n).padStart(2, '0')}`;
}

/** A fixed template's group: `fixed-<name>`. */
export function fixedGroupId(name: string): string {
  return `fixed-${name}`;
}

/** A question's ID: `<group>.<wording>` (`mitigated_by-03.loose`). */
export function evalQuestionId(group: string, wording: EvalWording): string {
  return `${group}.${wording}`;
}

/**
 * The groups each kind gets of `groups`: its weight's share rounded down, then the groups left
 * over given out one each in `EVAL_MIX`'s order. With 50 groups: 10, 10, 8, 8, 8, 4, 2.
 */
export function evalShares(groups: number): Record<GeneratedEvalKind, number> {
  const total = EVAL_MIX.reduce((sum, row) => sum + row.weight, 0);
  const shares = Object.fromEntries(
    EVAL_MIX.map((row) => [row.kind, Math.floor((groups * row.weight) / total)]),
  ) as Record<GeneratedEvalKind, number>;
  let left = groups - EVAL_MIX.reduce((sum, row) => sum + shares[row.kind], 0);
  while (left > 0) {
    for (const row of EVAL_MIX) {
      if (left === 0) break;
      shares[row.kind] += 1;
      left -= 1;
    }
  }
  return shares;
}
