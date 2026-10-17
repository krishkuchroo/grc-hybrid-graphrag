// The full report of an extraction run (S8-006; D45.8, D81): the whole run, record names included,
// for `data/benchmark/<run ID>.json`, a folder git keeps out. It holds what the command was asked,
// the question set's source and the answer key it was checked against, the run as the API gave it
// (its settings: models, prompt versions, cut-offs and the unmatched records), what was read, every
// item as sent, how they were stored, and the summary with the seven ratios. The output stays free
// of texts; only this file holds them. Pure: it formats what the run gave.
import type {
  BenchmarkResultItemInput,
  BenchmarkRunDetail,
  BenchmarkSummary,
  GeneratedQuestionSetSource,
  QuestionSet,
} from '@grc/shared';
import type { BenchRunArgs } from '../run/args.js';
import type { ExpectedOrg } from './expected.js';
import type { ExtractionRunResult } from './run.js';

export const EXTRACTION_REPORT_VERSION = 1;

export interface ExtractionReport {
  reportVersion: number;
  part: 'extraction';
  command: {
    org: string;
    set: string;
    part: BenchRunArgs['part'];
    waitMinutes: number | null;
    baseUrl: string;
  };
  org: { slug: string; id: string };
  questionSet: { version: number; source: QuestionSet['source'] };
  answerKey: {
    generatorVersion: string;
    seed: number;
    size: string;
    orgKey: string;
    statedFacts: number;
    falsePositives: number;
    addLinkInjections: number;
  };
  runId: string | null;
  end: ExtractionRunResult['end'];
  failure: string | null;
  errorLine: string | null;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  run: BenchmarkRunDetail | null;
  counts: ExtractionRunResult['counts'];
  items: BenchmarkResultItemInput[];
  stored: ExtractionRunResult['stored'];
  summary: BenchmarkSummary;
  summaryFrom: ExtractionRunResult['summaryFrom'];
  documents: ExtractionRunResult['documents'];
}

export function extractionReport(
  result: ExtractionRunResult,
  args: BenchRunArgs,
  set: QuestionSet,
  source: GeneratedQuestionSetSource,
  expected: ExpectedOrg,
  org: { slug: string; id: string },
): ExtractionReport {
  return {
    reportVersion: EXTRACTION_REPORT_VERSION,
    part: 'extraction',
    command: { org: args.org, set: args.set, part: args.part, waitMinutes: args.waitMinutes, baseUrl: args.baseUrl },
    org,
    questionSet: { version: set.version, source: set.source },
    answerKey: {
      generatorVersion: source.generatorVersion,
      seed: source.seed,
      size: source.size,
      orgKey: expected.orgKey,
      statedFacts: expected.statedFacts.length,
      falsePositives: expected.falsePositives.length,
      addLinkInjections: expected.injections.length,
    },
    runId: result.runId,
    end: result.end,
    failure: result.failure,
    errorLine: result.errorLine,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    elapsedMs: result.elapsedMs,
    run: result.run,
    counts: result.counts,
    items: result.items,
    stored: result.stored,
    summary: result.summary,
    summaryFrom: result.summaryFrom,
    documents: result.documents,
  };
}

/** The report as its file holds it. */
export function formatExtractionReport(report: ExtractionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
