// Execution accuracy (EV-002 behaviour 2(d); D261 track A, item 2): the graph query the model wrote
// for a hybrid answer, run and compared with the question's correct (gold) query, reported apart from
// the answer score.
// - The runner is the command's (`EvalGraphRunner`): it checks a query with Ask's `checkGraphQuery`
//   and runs it read-only as the run key's role x clearance query account, with Ask's limits (D73,
//   D131). This package imports nothing from the api.
// - A result set: the IDs of the graph records of the question's target kinds, plus any value cell
//   (a string, or a string inside a list) whose `normaliseName` form equals the name or number of
//   exactly one org record of those kinds. Sorted, each once.
// - The gold query runs first. Its result set must equal the question's resolved expected records;
//   otherwise the question is `gold_mismatch` (or `gold_failed` when it couldn't run) and is left
//   out of the score, counted and listed.
// - The model's query: `no_query` (none), `refused` (our checks refuse it, so it is never sent),
//   `failed` (it ran but timed out or failed; the code is kept), else `match` when the two result
//   sets are equal and `mismatch` otherwise. Precision and recall compare the model's set with the
//   gold set.
// - The score: match ÷ (match + mismatch + no_query + refused + failed).
// Pure apart from the runner it is given; queries run one at a time.
import { normaliseName, type SearchRecordKind } from '@grc/shared';

/** The outcomes that count in the score, in the order they are shown. */
export const EXECUTION_SCORED_OUTCOMES = ['match', 'mismatch', 'no_query', 'refused', 'failed'] as const;
/** The outcomes left out of the score: the gold query's own result was wrong, or it couldn't run. */
export const EXECUTION_EXCLUDED_OUTCOMES = ['gold_mismatch', 'gold_failed'] as const;
export const EXECUTION_OUTCOMES = [...EXECUTION_SCORED_OUTCOMES, ...EXECUTION_EXCLUDED_OUTCOMES] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/** What running one query gave: the records and the plain value rows read, or why it gave none. */
export type EvalGraphRunResult =
  | { ok: true; records: { id: string; kind: SearchRecordKind }[]; values: unknown[][] }
  | { ok: false; reason: 'refused' | 'failed'; code: string };

/** Checks one query and, if it passes, runs it read-only in the org's database (the command's). */
export type EvalGraphRunner = (query: string) => Promise<EvalGraphRunResult>;

/** One query as it ran: its text, what happened and its result set (null when it gave none). */
export interface EvalQueryRun {
  query: string | null;
  status: 'no_query' | 'refused' | 'failed' | 'ran';
  /** The refusal reason or the failure code; null when it ran or there was no query. */
  code: string | null;
  resultSet: string[] | null;
}

export interface EvalExecution {
  outcome: ExecutionOutcome;
  model: EvalQueryRun;
  gold: EvalQueryRun;
  /** The question's resolved expected record IDs, sorted. */
  expected: string[];
  /** |model ∩ gold| ÷ |model|; null when the model's set is empty or the question is left out. */
  precision: number | null;
  /** |model ∩ gold| ÷ |gold|; null when the gold set is empty or the question is left out. */
  recall: number | null;
}

/** The org's records of some kinds by their normalised name and number: the IDs each key names. */
export type RecordValueIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** The value index of the records given: each normalised name and number, with the IDs it names. */
export function recordValueIndex(records: readonly { id: string; number: string; name: string }[]): RecordValueIndex {
  const index = new Map<string, Set<string>>();
  const add = (key: string, id: string): void => {
    if (key === '') return;
    const ids = index.get(key);
    if (ids === undefined) index.set(key, new Set([id]));
    else ids.add(id);
  };
  for (const record of records) {
    add(normaliseName(record.name), record.id);
    add(normaliseName(record.number), record.id);
  }
  return index;
}

/** The value cells of a row that are strings, those inside lists included. */
function stringCells(row: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const cell of row) {
    if (typeof cell === 'string') out.push(cell);
    else if (Array.isArray(cell)) for (const item of cell as unknown[]) if (typeof item === 'string') out.push(item);
  }
  return out;
}

/** The result set of a query that ran, by the rule in the file comment. */
export function resultSetOf(
  run: Extract<EvalGraphRunResult, { ok: true }>,
  targetKinds: readonly SearchRecordKind[],
  index: RecordValueIndex,
): string[] {
  const ids = new Set<string>();
  for (const record of run.records) if (targetKinds.includes(record.kind)) ids.add(record.id);
  for (const row of run.values) {
    if (!Array.isArray(row)) continue;
    for (const cell of stringCells(row)) {
      const named = index.get(normaliseName(cell));
      if (named !== undefined && named.size === 1) ids.add([...named][0]!);
    }
  }
  return [...ids].sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((id) => other.has(id));
}

async function runQuery(
  query: string | null,
  runner: EvalGraphRunner,
  targetKinds: readonly SearchRecordKind[],
  index: RecordValueIndex,
): Promise<EvalQueryRun> {
  if (query === null || query.trim() === '') return { query, status: 'no_query', code: null, resultSet: null };
  const ran = await runner(query);
  if (!ran.ok) return { query, status: ran.reason, code: ran.code, resultSet: null };
  return { query, status: 'ran', code: null, resultSet: resultSetOf(ran, targetKinds, index) };
}

export interface ExecutionInput {
  /** The model's query (the hybrid answer's `details.graph.query`), or null. */
  modelQuery: string | null;
  goldQuery: string;
  targetKinds: readonly SearchRecordKind[];
  /** The question's resolved expected record IDs. */
  expectedIds: readonly string[];
  /** The org's records of the target kinds, for the value cells. */
  index: RecordValueIndex;
  runner: EvalGraphRunner;
}

/** One question's execution: the gold query, then the model's, one at a time. */
export async function executeQuestion(input: ExecutionInput): Promise<EvalExecution> {
  const expected = [...new Set(input.expectedIds)].sort();
  const gold = await runQuery(input.goldQuery, input.runner, input.targetKinds, input.index);
  const model = await runQuery(input.modelQuery, input.runner, input.targetKinds, input.index);
  const left = (outcome: ExecutionOutcome): EvalExecution => ({
    outcome,
    model,
    gold,
    expected,
    precision: null,
    recall: null,
  });
  if (gold.resultSet === null) return left('gold_failed');
  if (!sameSet(gold.resultSet, expected)) return left('gold_mismatch');

  const goldSet = new Set(gold.resultSet);
  const modelSet = model.resultSet ?? [];
  const both = modelSet.filter((id) => goldSet.has(id)).length;
  const outcome: ExecutionOutcome =
    model.status === 'ran' ? (sameSet(modelSet, gold.resultSet) ? 'match' : 'mismatch') : model.status;
  return {
    outcome,
    model,
    gold,
    expected,
    precision: modelSet.length === 0 ? null : both / modelSet.length,
    recall: goldSet.size === 0 ? null : both / goldSet.size,
  };
}

/** A mean over the values there are; null with none. */
export interface ExecutionMean {
  mean: number | null;
  n: number;
}

export interface ExecutionSummary {
  counts: Record<ExecutionOutcome, number>;
  /** The questions in the score: every outcome but the two gold ones. */
  measured: number;
  /** match ÷ measured; null when nothing was measured. */
  score: number | null;
  precision: ExecutionMean;
  recall: ExecutionMean;
}

function meanOf(values: readonly (number | null)[]): ExecutionMean {
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return { mean: finite.length === 0 ? null : finite.reduce((s, v) => s + v, 0) / finite.length, n: finite.length };
}

/** The summary of some questions' executions. */
export function executionSummary(rows: readonly EvalExecution[]): ExecutionSummary {
  const counts = Object.fromEntries(
    EXECUTION_OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]),
  ) as Record<ExecutionOutcome, number>;
  const measured = EXECUTION_SCORED_OUTCOMES.reduce((sum, o) => sum + counts[o], 0);
  return {
    counts,
    measured,
    score: measured === 0 ? null : counts.match / measured,
    precision: meanOf(rows.map((r) => r.precision)),
    recall: meanOf(rows.map((r) => r.recall)),
  };
}
