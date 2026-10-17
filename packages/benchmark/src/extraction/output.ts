// The command's output for an extraction run (S8-006; D24, D38, D52.6, D164): what was read (records
// per kind and how many the answer key couldn't be matched to, the AI links counted and the others
// left out, the link findings per status), the stated facts per state, the items per kind with
// their outcomes, and the seven extraction ratios, each with its numerator and denominator, from the
// API's summary; then the run's ID, its page on the Benchmark screen and the report's path. Counts,
// ratios, codes and IDs only: never a record's name, a sentence or a file name. Pure.
import {
  EXTRACTION_ITEM_KINDS,
  EXTRACTION_LINK_STATES,
  EXTRACTION_RATIO_METRICS,
  RECORD_KINDS,
  REVIEW_FINDING_STATUSES,
  benchmarkKindText,
  benchmarkMetricLabel,
  extractionLinkStateText,
  summaryGroup,
  type BenchmarkRatio,
} from '@grc/shared';
import type { ExtractionRunResult } from './run.js';

const LABEL_WIDTH = 44;

function row(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`.trimEnd();
}

function ratioCell(ratio: BenchmarkRatio | undefined): string {
  if (ratio === undefined) return '-';
  const value = ratio.value === null ? '-' : ratio.value.toFixed(3);
  return `${value.padEnd(8)}(${ratio.numerator} / ${ratio.denominator})`;
}

export interface ExtractionOutputContext {
  org: string;
  /** The platform's address, for the run's page (`<base>/benchmark/<id>`). */
  baseUrl: string;
  /** The report's path, as printed; null when none was written. */
  reportPath: string | null;
}

/** The output lines for an extraction run that started (or the reason it didn't). */
export function extractionRunOutput(result: ExtractionRunResult, context: ExtractionOutputContext): string[] {
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
    lines.push(
      `bench:run: no extraction run was started on ${context.org} (${result.failure ?? 'unknown'}) after ${minutes} min`,
    );
    if (result.errorLine !== null) lines.push(`  ${result.errorLine}`);
    return lines;
  }

  const status = result.end === 'finished' ? 'finished' : `failed (${result.failure ?? 'unknown'})`;
  lines.push(
    `bench:run: run ${result.runId} on ${context.org} ${status}: extraction, ${result.items.length} item(s), ${minutes} min`,
  );
  if (result.failure !== null && result.errorLine !== null) lines.push(`  ${result.errorLine}`);
  lines.push(
    `  stored ${result.stored.stored} item(s) in ${result.stored.batches} batch(es)` +
      (result.stored.repeats > 0 ? `; ${result.stored.repeats} repeat(s) ignored by the API` : '') +
      (result.stored.unsent > 0 ? `; ${result.stored.unsent} not stored` : ''),
  );
  if (result.summaryFrom === 'local')
    lines.push('  (the ratios below are computed here: the API did not give a summary)');

  const counts = result.counts;
  if (counts !== null) {
    lines.push('', row('Read from the org', 'active (not matched to the answer key)'));
    for (const kind of RECORD_KINDS) {
      lines.push(row(`  ${kind} records`, `${counts.records[kind]} (${counts.unmatched[kind]})`));
    }
    lines.push(row('  live AI links (counted)', String(counts.aiLinks)));
    lines.push(row('  other live links (import or by hand)', String(counts.otherLinks)));
    lines.push(row('  link findings', REVIEW_FINDING_STATUSES.map((s) => `${s} ${counts.findings[s]}`).join(', ')));

    lines.push('', row('Stated facts by state', ''));
    for (const state of EXTRACTION_LINK_STATES) {
      lines.push(row(`  ${extractionLinkStateText(state)}`, String(counts.statedFacts[state])));
    }
  }

  lines.push('', row('Extraction items', 'items: pass/partial/fail/skipped'));
  for (const kind of EXTRACTION_ITEM_KINDS) {
    const group = summaryGroup(result.summary, 'extraction', 'pipeline', kind);
    const o = group?.outcomes;
    lines.push(
      row(
        `  ${benchmarkKindText(kind)}`,
        group && o ? `${group.count}: ${o.pass}/${o.partial}/${o.fail}/${o.skipped}` : '0',
      ),
    );
  }

  const ratios = summaryGroup(result.summary, 'extraction', 'pipeline')?.ratios ?? null;
  lines.push('', row('Extraction ratios', 'value   (numerator / denominator)'));
  for (const metric of EXTRACTION_RATIO_METRICS) {
    lines.push(row(`  ${benchmarkMetricLabel(metric)}`, ratioCell(ratios?.[metric])));
  }

  lines.push('', `Run: ${result.runId}`, `Benchmark screen: ${context.baseUrl}/benchmark/${result.runId}`);
  if (context.reportPath !== null) lines.push(`Report: ${context.reportPath}`);
  return lines;
}
