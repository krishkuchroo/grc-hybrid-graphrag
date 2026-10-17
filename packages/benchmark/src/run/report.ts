// The full report of a run (S8-005; D45.8, D81): the whole run with its question and answer texts,
// for `data/benchmark/<run ID>.json`, a folder git keeps out. It holds what the command was asked,
// the run as the API gave it (its settings: models, prompt versions, limits, cut-offs and injection
// checks), every question with its expected records as the org holds them, every item as sent, how
// they were stored, and the summary. The output stays free of texts; only this file holds them.
// Pure: it formats what the run gave.
import type { BenchmarkResultItemInput, BenchmarkRunDetail, BenchmarkSummary, QuestionSet } from '@grc/shared';
import type { BenchRunArgs } from './args.js';
import type { BenchRunResult } from './run.js';

export const BENCH_REPORT_VERSION = 1;

export interface BenchReport {
  reportVersion: number;
  command: {
    org: string;
    set: string;
    part: BenchRunArgs['part'];
    parts: BenchRunArgs['parts'];
    modes: BenchRunArgs['modes'];
    limit: number | null;
    waitMinutes: number | null;
    baseUrl: string;
  };
  org: { slug: string; id: string };
  questionSet: { version: number; source: QuestionSet['source']; questionsInSet: number; questionsRun: number };
  runId: string | null;
  end: BenchRunResult['end'];
  failure: string | null;
  errorLine: string | null;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  run: BenchmarkRunDetail | null;
  questions: {
    id: string;
    kind: string;
    text: string;
    expected: QuestionSet['questions'][number]['expected'];
    found: BenchRunResult['questions'][number]['resolution']['expected'];
    skipped: boolean;
  }[];
  items: BenchmarkResultItemInput[];
  stored: BenchRunResult['stored'];
  summary: BenchmarkSummary;
  summaryFrom: BenchRunResult['summaryFrom'];
  documents: BenchRunResult['documents'];
}

export function benchReport(
  result: BenchRunResult,
  args: BenchRunArgs,
  set: QuestionSet,
  org: { slug: string; id: string },
): BenchReport {
  return {
    reportVersion: BENCH_REPORT_VERSION,
    command: {
      org: args.org,
      set: args.set,
      part: args.part,
      parts: args.parts,
      modes: args.modes,
      limit: args.limit,
      waitMinutes: args.waitMinutes,
      baseUrl: args.baseUrl,
    },
    org,
    questionSet: {
      version: set.version,
      source: set.source,
      questionsInSet: set.questions.length,
      questionsRun: result.questions.length,
    },
    runId: result.runId,
    end: result.end,
    failure: result.failure,
    errorLine: result.errorLine,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    elapsedMs: result.elapsedMs,
    run: result.run,
    questions: result.questions.map(({ question, resolution }) => ({
      id: question.id,
      kind: question.kind,
      text: question.text,
      expected: question.expected,
      found: resolution.expected,
      skipped: resolution.resolved === null,
    })),
    items: result.items,
    stored: result.stored,
    summary: result.summary,
    summaryFrom: result.summaryFrom,
    documents: result.documents,
  };
}

/** The report as its file holds it. */
export function formatBenchReport(report: BenchReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
