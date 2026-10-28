// The evaluation of a run against its set's checks file (EV-002; D1, D45.8, D261 track A, items 1–3
// and item 4's failure rule). `pnpm bench:run` runs it after `runBenchmark` returns, while the run's
// key is live, when `<set>.checks.json` sits beside the set. Nothing of it goes to the API: the
// stored run, its items and the Benchmark screen are unchanged. It goes into the report file's
// `evaluation` block and, as counts and scores only, onto the screen (./eval-output.ts).
// - The breakdown: per fine kind and per wording, `summariseBenchmark` over that slice's items (both
//   parts, each mode). A stale answer counts as a `fail` here (item 4); its stored item is unchanged.
// - Consistency (./consistency.ts): per group and mode, the records the scored answers name.
// - Execution accuracy (./execution.ts): each hybrid answer's own graph query against the question's
//   gold query, through the command's runner; not measured without one (the reason is given).
// - Stale answers (./stale.ts): answers that show a name the checks file forbids.
// Per-answer checks are made in one place (`answerReport`), and each answer's report and each
// mode's summaries are plain objects, so later checks add their own fields beside these.
// Pure apart from the runner; the same run, checks file, records and query results always give the
// same report.
import {
  summariseBenchmark,
  type BenchmarkQuestionKind,
  type BenchmarkResultItemInput,
  type BenchmarkSummary,
  type SearchMode,
  type SearchRecordKind,
} from '@grc/shared';
import type { OrgRecords } from '../run/resolve.js';
import type { BenchRunQuestion } from '../run/run.js';
import type { AnswersResultItem } from '../score/common.js';
import type { EvalCheckQuestion, EvalChecks, ForbiddenReason } from './checks-file.js';
import {
  consistencySummary,
  nameableRecords,
  namedRecords,
  type ConsistencyAnswer,
  type ConsistencyModeSummary,
  type NameableRecord,
  type NamedRecordRef,
} from './consistency.js';
import {
  executeQuestion,
  executionSummary,
  recordValueIndex,
  type EvalExecution,
  type EvalGraphRunner,
  type ExecutionSummary,
  type RecordValueIndex,
} from './execution.js';
import { EVAL_QUESTION_KINDS, EVAL_WORDINGS, type EvalQuestionKind, type EvalWording } from './kinds.js';
import { staleHitsOf, staleSummary, type EvalStaleHit, type StaleAnswer, type StaleModeSummary } from './stale.js';

export const EVAL_REPORT_SECTIONS = ['breakdown', 'consistency', 'execution', 'stale'] as const;
export type EvalReportSection = (typeof EVAL_REPORT_SECTIONS)[number];

/** Why execution accuracy isn't measured when the command has no query account to run as. */
export const EXECUTION_NO_SECRET = 'NEO4J_QUERY_SECRET not set';

/** The graph part of the evaluation: the command's runner, or why there is none. */
export type EvalGraphInput = { runner: EvalGraphRunner } | { notMeasured: string };

export interface EvalRunInput {
  checks: EvalChecks;
  /** The checks file's path, as the report gives it. */
  checksPath: string;
  /** The run's questions with their resolutions (`BenchRunResult.questions`). */
  questions: readonly BenchRunQuestion[];
  /** The run's items, as sent (`BenchRunResult.items`). */
  items: readonly BenchmarkResultItemInput[];
  /** The org's records of every target kind in the checks file (`readOrgRecords`). */
  records: OrgRecords;
  graph: EvalGraphInput;
  /** One line of progress: counts only. */
  log?: (line: string) => void;
}

/** One answer of a question in one mode, as the evaluation saw it. */
export interface EvalAnswerReport {
  mode: SearchMode;
  /** The outcome stored on the API. */
  outcome: BenchmarkResultItemInput['outcome'];
  /** The outcome in the evaluation: `fail` for a stale answer, else the stored one. */
  evaluatedOutcome: BenchmarkResultItemInput['outcome'];
  /** Not `skipped`, and not a `fail` with no answer. */
  scored: boolean;
  /** The org records of the question's target kinds the answer names; null when not scored. */
  named: NamedRecordRef[] | null;
  /** The forbidden names the answer shows (scored answers only). */
  stale: EvalStaleHit[];
}

export interface EvalQuestionReport {
  id: string;
  group: string;
  kind: EvalQuestionKind;
  wording: EvalWording;
  setKind: BenchmarkQuestionKind;
  targetKinds: SearchRecordKind[];
  /** The question's expected records as the org holds them; null when they weren't all found once. */
  expected: NamedRecordRef[] | null;
  /** One per mode the answers part ran in, in the run's order. */
  answers: EvalAnswerReport[];
  /** The hybrid answer's query against the gold query; null when not measured for this question. */
  execution: EvalExecution | null;
}

export interface EvalSliceSummary<K extends string> {
  slice: K;
  /** `summariseBenchmark` over the slice's items (stale answers as `fail`). */
  summary: BenchmarkSummary;
}

export interface EvalExecutionReport {
  overall: ExecutionSummary;
  byKind: (ExecutionSummary & { kind: EvalQuestionKind })[];
  byWording: (ExecutionSummary & { wording: EvalWording })[];
  /** Hybrid answers of questions with a gold query left out because they were skipped (never asked
   * or hidden). */
  skipped: number;
  /** The IDs of the questions whose gold query gave another result than their expected records. */
  goldMismatch: string[];
  /** The IDs of the questions whose gold query couldn't run. */
  goldFailed: string[];
}

export interface EvalReport {
  checksPath: string;
  folder: EvalChecks['folder'];
  seed: number;
  count: number;
  changed: EvalChecks['changed'];
  /** The questions the run asked (all, or the first `--limit`). */
  questionCount: number;
  /** The modes the answers part ran in. */
  answerModes: SearchMode[];
  /** Each part that wasn't measured, with its reason. */
  notMeasured: { section: EvalReportSection; reason: string }[];
  breakdown: {
    byKind: EvalSliceSummary<EvalQuestionKind>[];
    byWording: EvalSliceSummary<EvalWording>[];
    /** Answers counted as `fail` here because they were stale. */
    staleAsFailures: number;
  };
  /** Per answers mode; empty when not measured. */
  consistency: ConsistencyModeSummary[];
  /** Null when not measured. */
  execution: EvalExecutionReport | null;
  /** Per answers mode; null when no question has forbidden names. */
  stale: StaleModeSummary[] | null;
  questions: EvalQuestionReport[];
}

/** Every target kind in the checks file, each once, in the order first named. */
export function evalTargetKinds(checks: EvalChecks): SearchRecordKind[] {
  const kinds: SearchRecordKind[] = [];
  for (const q of checks.questions) for (const kind of q.targetKinds) if (!kinds.includes(kind)) kinds.push(kind);
  return kinds;
}

/** Whether an answers item was scored: not `skipped`, and not a `fail` with no answer. */
export function isScoredAnswer(item: AnswersResultItem): boolean {
  if (item.outcome === 'skipped') return false;
  const noAnswer = item.details.answer === null || item.details.answer.status === 'failed';
  return !(item.outcome === 'fail' && noAnswer);
}

/** The answer text of an answers item ('' without one). */
function answerText(item: AnswersResultItem): string {
  return item.details.answer?.text ?? '';
}

function kindsKey(kinds: readonly SearchRecordKind[]): string {
  return [...new Set(kinds)].sort().join(',');
}

/** The org's records of some kinds, made once per set of kinds. */
class RecordsOfKinds {
  private readonly nameable = new Map<string, NameableRecord[]>();
  private readonly values = new Map<string, RecordValueIndex>();

  constructor(private readonly records: OrgRecords) {}

  private listed(kinds: readonly SearchRecordKind[]): { id: string; number: string; name: string }[] {
    return [...new Set(kinds)].flatMap((kind) => [...(this.records.get(kind) ?? [])]);
  }

  nameableOf(kinds: readonly SearchRecordKind[]): NameableRecord[] {
    const key = kindsKey(kinds);
    let out = this.nameable.get(key);
    if (out === undefined) {
      out = nameableRecords(this.listed(kinds));
      this.nameable.set(key, out);
    }
    return out;
  }

  valueIndexOf(kinds: readonly SearchRecordKind[]): RecordValueIndex {
    const key = kindsKey(kinds);
    let out = this.values.get(key);
    if (out === undefined) {
      out = recordValueIndex(this.listed(kinds));
      this.values.set(key, out);
    }
    return out;
  }
}

/**
 * One answer's own checks: what it names and the forbidden names it shows. Later per-answer checks
 * go here, beside these.
 */
function answerReport(
  item: AnswersResultItem,
  check: EvalCheckQuestion,
  records: readonly NameableRecord[],
): EvalAnswerReport {
  const scored = isScoredAnswer(item);
  const text = answerText(item);
  const stale = scored ? staleHitsOf(text, check.forbidden) : [];
  return {
    mode: item.mode,
    outcome: item.outcome,
    evaluatedOutcome: stale.length > 0 ? 'fail' : item.outcome,
    scored,
    named: scored ? namedRecords(text, records) : null,
    stale,
  };
}

function itemKey(part: string, mode: string, id: string): string {
  return `${part}\u0000${mode}\u0000${id}`;
}

/** Evaluates the run against its checks file: see the file comment. */
export async function evaluateRun(input: EvalRunInput): Promise<EvalReport> {
  const { checks, items } = input;
  const log = input.log ?? (() => undefined);
  const checkById = new Map(checks.questions.map((q) => [q.id, q]));
  const ofKinds = new RecordsOfKinds(input.records);

  const answersItems = new Map<string, AnswersResultItem>();
  for (const item of items) {
    if (item.part === 'answers') answersItems.set(itemKey(item.part, item.mode, item.itemKey), item);
  }
  const answerModes: SearchMode[] = [];
  for (const item of items) {
    if (item.part === 'answers' && !answerModes.includes(item.mode)) answerModes.push(item.mode);
  }

  // Each question's group: the union of its questions' target kinds (they are the same in a group).
  const groupKinds = new Map<string, SearchRecordKind[]>();
  for (const q of checks.questions) {
    const kinds = groupKinds.get(q.group) ?? [];
    for (const kind of q.targetKinds) if (!kinds.includes(kind)) kinds.push(kind);
    groupKinds.set(q.group, kinds);
  }

  // Per question, per answers mode: the answer's own checks.
  const questions: EvalQuestionReport[] = [];
  const consistencyAnswers: ConsistencyAnswer[] = [];
  const staleAnswers: StaleAnswer[] = [];
  const staleIds = new Set<string>();
  for (const { question, resolution } of input.questions) {
    const check = checkById.get(question.id);
    if (check === undefined) continue;
    const named = ofKinds.nameableOf(groupKinds.get(check.group) ?? check.targetKinds);
    const reasons: ForbiddenReason[] = [...new Set(check.forbidden.map((f) => f.why))];
    const answers: EvalAnswerReport[] = [];
    for (const mode of answerModes) {
      const item = answersItems.get(itemKey('answers', mode, question.id));
      if (item === undefined) continue;
      const answer = answerReport(item, check, named);
      answers.push(answer);
      if (!answer.scored) continue;
      consistencyAnswers.push({
        group: check.group,
        kind: check.kind,
        mode,
        named: (answer.named ?? []).map((r) => r.id),
      });
      if (check.forbidden.length > 0) staleAnswers.push({ mode, reasons, hits: answer.stale });
      if (answer.stale.length > 0) staleIds.add(itemKey('answers', mode, question.id));
    }
    questions.push({
      id: question.id,
      group: check.group,
      kind: check.kind,
      wording: check.wording,
      setKind: question.kind,
      targetKinds: [...check.targetKinds],
      expected: resolution.resolved === null ? null : resolution.resolved.map((r) => ({ id: r.id, number: r.number })),
      answers,
      execution: null,
    });
  }

  const notMeasured: EvalReport['notMeasured'] = [];
  const noAnswers = answerModes.length === 0;
  if (noAnswers) {
    for (const section of ['consistency', 'execution'] as const) {
      notMeasured.push({ section, reason: 'the run has no answers part' });
    }
  }

  // (b) The breakdown: both parts, stale answers as `fail`.
  const evaluated = items.map((item) =>
    item.part === 'answers' && staleIds.has(itemKey(item.part, item.mode, item.itemKey))
      ? { ...item, outcome: 'fail' as const }
      : item,
  );
  const sliceOf = <K extends string>(
    slices: readonly K[],
    of: (check: EvalCheckQuestion) => K,
  ): EvalSliceSummary<K>[] =>
    slices
      .map((slice) => ({
        slice,
        summary: summariseBenchmark(
          evaluated.filter((item) => {
            if (item.part === 'extraction') return false;
            const check = checkById.get(item.itemKey);
            return check !== undefined && of(check) === slice;
          }),
        ),
      }))
      .filter((row) => row.summary.itemCount > 0);
  const byKind = sliceOf(EVAL_QUESTION_KINDS, (c) => c.kind);
  const byWording = sliceOf(EVAL_WORDINGS, (c) => c.wording);
  if (byKind.length === 0) notMeasured.unshift({ section: 'breakdown', reason: 'the run has no scored items' });

  // (c) Consistency, per answers mode.
  const consistency = answerModes.map((mode) => consistencySummary(mode, consistencyAnswers));

  // (d) Execution accuracy: hybrid answers of questions with a gold query, one query at a time.
  let execution: EvalExecutionReport | null = null;
  if (!noAnswers) {
    const withGold = questions.filter((q) => (checkById.get(q.id)?.goldQuery ?? null) !== null);
    const hybrid = withGold
      .map((q) => ({ q, item: answersItems.get(itemKey('answers', 'hybrid', q.id)) }))
      .filter((row): row is { q: EvalQuestionReport; item: AnswersResultItem } => row.item !== undefined);
    if ('notMeasured' in input.graph) {
      notMeasured.push({ section: 'execution', reason: input.graph.notMeasured });
    } else if (!answerModes.includes('hybrid')) {
      notMeasured.push({ section: 'execution', reason: 'the run has no hybrid answers' });
    } else if (withGold.length === 0) {
      notMeasured.push({ section: 'execution', reason: 'no question has a correct graph query' });
    } else {
      const runner = input.graph.runner;
      const asked = hybrid.filter(({ q, item }) => item.outcome !== 'skipped' && q.expected !== null);
      log(`evaluation: running the correct and the model's graph query of ${asked.length} question(s), one at a time`);
      for (const { q, item } of asked) {
        const check = checkById.get(q.id)!;
        q.execution = await executeQuestion({
          modelQuery: item.details.graph?.query ?? null,
          goldQuery: check.goldQuery!,
          targetKinds: check.targetKinds,
          expectedIds: (q.expected ?? []).map((r) => r.id),
          index: ofKinds.valueIndexOf(check.targetKinds),
          runner,
        });
      }
      const ran = asked.map(({ q }) => q).filter((q) => q.execution !== null);
      const rows = (list: readonly EvalQuestionReport[]): EvalExecution[] => list.map((q) => q.execution!);
      execution = {
        overall: executionSummary(rows(ran)),
        byKind: EVAL_QUESTION_KINDS.map((kind) => ({
          kind,
          ...executionSummary(rows(ran.filter((q) => q.kind === kind))),
        })).filter((row) => Object.values(row.counts).some((n) => n > 0)),
        byWording: EVAL_WORDINGS.map((wording) => ({
          wording,
          ...executionSummary(rows(ran.filter((q) => q.wording === wording))),
        })).filter((row) => Object.values(row.counts).some((n) => n > 0)),
        skipped: hybrid.length - asked.length,
        goldMismatch: ran.filter((q) => q.execution!.outcome === 'gold_mismatch').map((q) => q.id),
        goldFailed: ran.filter((q) => q.execution!.outcome === 'gold_failed').map((q) => q.id),
      };
    }
  }

  // (e) Stale answers: only when some question has forbidden names.
  const hasForbidden = questions.some((q) => (checkById.get(q.id)?.forbidden.length ?? 0) > 0);
  let stale: StaleModeSummary[] | null = null;
  if (hasForbidden) {
    if (noAnswers) notMeasured.push({ section: 'stale', reason: 'the run has no answers part' });
    else stale = answerModes.map((mode) => staleSummary(mode, staleAnswers));
  }

  return {
    checksPath: input.checksPath,
    folder: checks.folder,
    seed: checks.seed,
    count: checks.count,
    changed: checks.changed,
    questionCount: input.questions.length,
    answerModes,
    notMeasured,
    breakdown: { byKind, byWording, staleAsFailures: staleIds.size },
    consistency,
    execution,
    stale,
    questions,
  };
}
