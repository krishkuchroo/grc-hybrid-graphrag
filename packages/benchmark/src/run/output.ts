// The command's output for a run (S8-005; D1, D48, D164): per mode and per question kind, side by
// side, the counts, context recall and reciprocal rank and, with answers, correctness, citation
// accuracy, made-up record numbers and planted instructions followed; the 95th-percentile times
// against the D48 targets with PASS or FAIL; the graph fallbacks by reason; and the run's ID, its
// page on the Benchmark screen and the report's path. Scores, counts, times and IDs only: never a
// question, an answer, a passage, a graph query, a record's name or a key. Pure.
import {
  BENCHMARK_QUESTION_KINDS,
  BENCHMARK_TARGETS,
  GRAPH_FALLBACK_REASONS,
  benchmarkKindText,
  benchmarkMetricLabel,
  benchmarkModeText,
  benchmarkPartText,
  summaryGroup,
  type BenchmarkItemKind,
  type BenchmarkQuestionPart,
  type BenchmarkScoreMetric,
  type BenchmarkSummary,
  type BenchmarkSummaryGroup,
  type SearchMode,
} from '@grc/shared';
import type { BenchRunResult } from './run.js';

const LABEL_WIDTH = 44;
const COLUMN_WIDTH = 20;

/** The scores shown per part, in this order. */
const SHOWN_SCORES: Readonly<Record<BenchmarkQuestionPart, readonly BenchmarkScoreMetric[]>> = Object.freeze({
  retrieval: ['context_recall', 'reciprocal_rank'],
  answers: ['answer_correctness', 'citation_accuracy', 'made_up_numbers', 'injection_followed'],
});

function share(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '-';
}

function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function row(label: string, cells: readonly string[]): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${cells.map((c) => c.padEnd(COLUMN_WIDTH)).join('')}`.trimEnd();
}

function countsCell(group: BenchmarkSummaryGroup | null): string {
  if (group === null) return '-';
  const o = group.outcomes;
  return `${group.count}: ${o.pass}/${o.partial}/${o.fail}/${o.skipped}`;
}

function scoreCell(group: BenchmarkSummaryGroup | null, metric: BenchmarkScoreMetric): string {
  const stat = group?.scores[metric];
  if (stat === undefined) return '-';
  return stat.mean === null ? '-' : `${share(stat.mean)} (n ${stat.n})`;
}

/** The part's table: overall, then each question kind with items, side by side per mode. */
function partTable(summary: BenchmarkSummary, part: BenchmarkQuestionPart, modes: readonly SearchMode[]): string[] {
  const lines: string[] = [];
  const overall = modes.map((mode) => summaryGroup(summary, part, mode));
  if (overall.every((g) => g === null)) return lines;
  lines.push(row(benchmarkPartText(part), modes.map(benchmarkModeText)));
  const kinds: (BenchmarkItemKind | null)[] = [null, ...BENCHMARK_QUESTION_KINDS];
  for (const kind of kinds) {
    const groups = modes.map((mode) => summaryGroup(summary, part, mode, kind));
    if (groups.every((g) => g === null)) continue;
    lines.push(`  ${kind === null ? 'All questions' : benchmarkKindText(kind)}`);
    lines.push(row('  items: pass/partial/fail/skipped', groups.map(countsCell)));
    for (const metric of SHOWN_SCORES[part]) {
      if (groups.every((g) => g?.scores[metric] === undefined)) continue;
      lines.push(
        row(
          `  ${benchmarkMetricLabel(metric)}`,
          groups.map((g) => scoreCell(g, metric)),
        ),
      );
    }
  }
  return lines;
}

/** The 95th-percentile times against the D48 targets, from each part's overall group. */
function targetsTable(
  summary: BenchmarkSummary,
  parts: readonly BenchmarkQuestionPart[],
  modes: readonly SearchMode[],
): string[] {
  const lines: string[] = [];
  for (const target of BENCHMARK_TARGETS) {
    const cells: string[] = [];
    let measured = false;
    for (const mode of modes) {
      let cell = 'not measured';
      for (const part of parts) {
        const result = summaryGroup(summary, part, mode)?.targets.find((t) => t.metric === target.metric);
        if (result === undefined) continue;
        measured = true;
        cell = result.value === null ? 'no value' : `${ms(result.value)} ${result.pass ? 'PASS' : 'FAIL'}`;
      }
      cells.push(cell);
    }
    if (measured) lines.push(row(target.text, cells));
  }
  if (lines.length === 0) return lines;
  return [row('Times against D48 (95th percentile)', modes.map(benchmarkModeText)), ...lines];
}

/** The graph fallbacks by reason, per part (hybrid mode: vector mode never runs the graph path). */
function fallbacksTable(summary: BenchmarkSummary, parts: readonly BenchmarkQuestionPart[]): string[] {
  const groups = parts.map((part) => summaryGroup(summary, part, 'hybrid'));
  if (groups.every((g) => g === null)) return [];
  const lines = [row('Graph fallbacks (hybrid)', parts.map(benchmarkPartText))];
  for (const reason of GRAPH_FALLBACK_REASONS) {
    lines.push(
      row(
        `  ${reason}`,
        groups.map((g) => (g === null ? '-' : String(g.graphFallbacks[reason]))),
      ),
    );
  }
  return lines;
}

export interface BenchOutputContext {
  org: string;
  parts: readonly BenchmarkQuestionPart[];
  modes: readonly SearchMode[];
  /** The platform's address, for the run's page (`<base>/benchmark/<id>`). */
  baseUrl: string;
  /** The report's path, as printed; null when none was written. */
  reportPath: string | null;
}

/** The output lines for a run that started (or the reason it didn't). */
export function benchRunOutput(result: BenchRunResult, context: BenchOutputContext): string[] {
  const lines: string[] = [];
  const minutes = (result.elapsedMs / 60_000).toFixed(1);
  if (result.runId === null) {
    if (result.failure === 'documents_not_processed' && result.documents !== null) {
      lines.push(
        `bench:run: the documents of ${context.org} were not all processed after ${minutes} min ` +
          `(waiting ${result.documents.waiting}, being processed ${result.documents.processing}); no run was started. ` +
          'Run the command again once Data intake shows them processed, or with a longer --wait.',
      );
      return lines;
    }
    lines.push(`bench:run: no run was started on ${context.org} (${result.failure ?? 'unknown'}) after ${minutes} min`);
    if (result.errorLine !== null) lines.push(`  ${result.errorLine}`);
    return lines;
  }

  const status = result.end === 'finished' ? 'finished' : `failed (${result.failure ?? 'unknown'})`;
  const questionCount = result.questions.length;
  lines.push(
    `bench:run: run ${result.runId} on ${context.org} ${status}: ${questionCount} question(s), ` +
      `${result.items.length} item(s), ${minutes} min`,
  );
  if (result.failure !== null && result.errorLine !== null) lines.push(`  ${result.errorLine}`);
  lines.push(
    `  stored ${result.stored.stored} item(s) in ${result.stored.batches} batch(es)` +
      (result.stored.repeats > 0 ? `; ${result.stored.repeats} repeat(s) ignored by the API` : '') +
      (result.stored.unsent > 0 ? `; ${result.stored.unsent} not stored` : ''),
  );
  if (result.summaryFrom === 'local') lines.push('  (the summary below is computed here: the API did not give one)');

  for (const part of context.parts) {
    const table = partTable(result.summary, part, context.modes);
    if (table.length === 0) continue;
    lines.push('', ...table);
  }
  const targets = targetsTable(result.summary, context.parts, context.modes);
  if (targets.length > 0) lines.push('', ...targets);
  if (context.modes.includes('hybrid')) {
    const fallbacks = fallbacksTable(result.summary, context.parts);
    if (fallbacks.length > 0) lines.push('', ...fallbacks);
  }

  lines.push('', `Run: ${result.runId}`, `Benchmark screen: ${context.baseUrl}/benchmark/${result.runId}`);
  if (context.reportPath !== null) lines.push(`Report: ${context.reportPath}`);
  return lines;
}
