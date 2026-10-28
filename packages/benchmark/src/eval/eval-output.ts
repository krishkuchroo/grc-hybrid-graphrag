// The command's output for the evaluation (EV-002 behaviour 3; D164): a part headed "Evaluation
// (checks file)" after the run's own output, with the breakdown tables (the answers part, per mode,
// by fine kind and by wording), consistency, execution accuracy with its outcome counts, stale
// answers (only when some question has forbidden names), and each part not measured with its
// reason. Counts, scores, times and the checks file's path only: never a question, an answer, a
// name or a query. Pure.
import { benchmarkModeText, summaryGroup, type BenchmarkSummaryGroup, type SearchMode } from '@grc/shared';
import type { ConsistencyShare } from './consistency.js';
import type { EvalReport, EvalSliceSummary } from './evaluate.js';
import { EXECUTION_OUTCOMES, type ExecutionSummary } from './execution.js';
import type { StaleShare } from './stale.js';

const LABEL_WIDTH = 18;
const COLUMN_WIDTH = 15;
const WIDE_COLUMN = 24;

function share(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '-';
}

function ms(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function cells(values: readonly string[], width = COLUMN_WIDTH): string {
  return values.map((v) => v.padEnd(width)).join('');
}

function row(indent: string, label: string, values: readonly string[], width = COLUMN_WIDTH): string {
  return `${indent}${label.padEnd(LABEL_WIDTH)}${cells(values, width)}`.trimEnd();
}

/** A score's mean where it was measured (`n` above 0), else '-'. */
function scoreOf(group: BenchmarkSummaryGroup, metric: keyof BenchmarkSummaryGroup['scores']): string {
  const stat = group.scores[metric];
  return stat === undefined || stat.n === 0 ? '-' : share(stat.mean);
}

const BREAKDOWN_HEADER = [
  'n',
  'p/pa/f/s',
  'correct',
  'made-up no.',
  'no-answer ok',
  'injection',
  'p95 first',
  'p95 full',
];

function breakdownRow(label: string, group: BenchmarkSummaryGroup): string {
  const o = group.outcomes;
  return row('    ', label, [
    String(group.count),
    `${o.pass}/${o.partial}/${o.fail}/${o.skipped}`,
    scoreOf(group, 'answer_correctness'),
    scoreOf(group, 'made_up_numbers'),
    scoreOf(group, 'no_answer_correct'),
    scoreOf(group, 'injection_followed'),
    ms(group.times.first_words_ms?.p95),
    ms(group.times.answer_total_ms?.p95),
  ]);
}

/** The answers part of each slice in one mode, one row per slice that has answers in it. */
function breakdownTable(title: string, slices: readonly EvalSliceSummary<string>[], mode: SearchMode): string[] {
  const rows = slices
    .map(({ slice, summary }) => ({ slice, group: summaryGroup(summary, 'answers', mode) }))
    .filter((r): r is { slice: string; group: BenchmarkSummaryGroup } => r.group !== null);
  if (rows.length === 0) return [];
  return [
    `  ${title}, ${benchmarkModeText(mode)}`,
    row('    ', '', BREAKDOWN_HEADER),
    ...rows.map((r) => breakdownRow(r.slice, r.group)),
  ];
}

function consistencyCell(s: ConsistencyShare | undefined): string {
  return s === undefined || s.measured === 0 ? '-' : `${share(s.score)} (${s.consistent} of ${s.measured})`;
}

function staleCell(s: StaleShare | undefined): string {
  return s === undefined || s.measured === 0 ? '-' : `${share(s.score)} (${s.stale} of ${s.measured})`;
}

function executionCells(label: string, score: string, counts: readonly string[]): string {
  return `    ${label.padEnd(LABEL_WIDTH)}${score.padEnd(WIDE_COLUMN)}${cells(counts)}`.trimEnd();
}

function executionRow(label: string, s: ExecutionSummary): string {
  return executionCells(
    label,
    s.measured === 0 ? '-' : `${share(s.score)} (${s.counts.match} of ${s.measured})`,
    EXECUTION_OUTCOMES.map((o) => String(s.counts[o])),
  );
}

/** The evaluation's output lines. */
export function evalRunOutput(report: EvalReport): string[] {
  const lines: string[] = ['Evaluation (checks file)'];
  lines.push(
    `  checks file: ${report.checksPath} (${report.count} question(s); ${report.questionCount} in this run)` +
      (report.changed === null
        ? ''
        : `; changed data: ${report.changed.renames} rename(s), ${report.changed.deletions} deletion(s)`),
  );
  const modes = report.answerModes;

  // The breakdown.
  for (const mode of modes) {
    const byKind = breakdownTable('Answers by fine kind', report.breakdown.byKind, mode);
    if (byKind.length > 0) lines.push('', ...byKind);
    const byWording = breakdownTable('Answers by wording', report.breakdown.byWording, mode);
    if (byWording.length > 0) lines.push('', ...byWording);
  }
  if (report.stale !== null) {
    lines.push(`  (stale answers counted as failures in these tables: ${report.breakdown.staleAsFailures})`);
  }

  // Consistency.
  if (report.consistency.length > 0) {
    lines.push('', '  Consistency: the wordings of one fact name the same records (consistent groups)');
    lines.push(row('    ', '', modes.map(benchmarkModeText), WIDE_COLUMN));
    lines.push(
      row(
        '    ',
        'All groups',
        report.consistency.map((m) => consistencyCell(m)),
        WIDE_COLUMN,
      ),
    );
    const kinds = [...new Set(report.consistency.flatMap((m) => m.byKind.map((k) => k.kind)))];
    for (const kind of kinds) {
      lines.push(
        row(
          '    ',
          kind,
          report.consistency.map((m) => consistencyCell(m.byKind.find((k) => k.kind === kind))),
          WIDE_COLUMN,
        ),
      );
    }
  }

  // Execution accuracy.
  const ex = report.execution;
  if (ex !== null) {
    lines.push(
      '',
      "  Execution accuracy (hybrid): the model's graph query against the correct one, apart from the answer score",
    );
    lines.push(executionCells('', 'score', EXECUTION_OUTCOMES));
    lines.push(executionRow('All questions', ex.overall));
    for (const k of ex.byKind) lines.push(executionRow(k.kind, k));
    for (const w of ex.byWording) lines.push(executionRow(`wording ${w.wording}`, w));
    lines.push(
      `    precision ${share(ex.overall.precision.mean)} (n ${ex.overall.precision.n}), ` +
        `recall ${share(ex.overall.recall.mean)} (n ${ex.overall.recall.n})`,
    );
    lines.push(
      `    left out of the score: gold_mismatch ${ex.overall.counts.gold_mismatch}, gold_failed ${ex.overall.counts.gold_failed}` +
        ` (listed in the report); skipped answers ${ex.skipped}`,
    );
  }

  // Stale answers.
  if (report.stale !== null) {
    lines.push('', '  Stale answers: an old name or a deleted link shown (stale answers)');
    lines.push(
      row(
        '    ',
        '',
        report.stale.map((s) => benchmarkModeText(s.mode)),
        WIDE_COLUMN,
      ),
    );
    lines.push(row('    ', 'All', report.stale.map(staleCell), WIDE_COLUMN));
    const whys = report.stale[0]?.byWhy.map((w) => w.why) ?? [];
    for (const why of whys) {
      lines.push(
        row(
          '    ',
          why,
          report.stale.map((s) => staleCell(s.byWhy.find((w) => w.why === why))),
          WIDE_COLUMN,
        ),
      );
    }
  }

  // What wasn't measured.
  if (report.notMeasured.length > 0) {
    lines.push('');
    for (const { section, reason } of report.notMeasured) lines.push(`  ${section}: not measured (${reason})`);
  }
  return lines;
}
