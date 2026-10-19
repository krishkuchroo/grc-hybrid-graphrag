// The full report of `pnpm dataset:score` (FT-001; D45.8, D81): what the command was asked, the
// folder and its answer key, the org, when it ran, and the whole score with every item, names and
// sentences included, for `data/benchmark/dataset-<slug>-<UTC time>.json`, a folder git keeps out.
// The output stays free of texts; only this file holds them. Pure: it formats what it is given.
import type { DatasetScoreArgs } from './args.js';
import type { DatasetFolder } from './folder.js';
import type { DatasetScore } from './score.js';

export const DATASET_REPORT_VERSION = 1;

export interface DatasetReport {
  reportVersion: number;
  command: { org: string; folder: string; baseUrl: string };
  org: { slug: string; id: string };
  folder: {
    path: string;
    org: { name: string; slug: string };
    answerKey: { generatorVersion: string; seed: number; orgKey: string };
    facts: number;
    scannerRows: number;
    normalisationRows: number;
  };
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  score: DatasetScore;
}

/** The time as `yyyymmddThhmmssZ`, in UTC. */
export function compactUtcTime(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** The report's file name: `dataset-<slug>-<yyyymmddThhmmssZ>.json`. */
export function datasetReportFileName(slug: string, at: Date): string {
  return `dataset-${slug}-${compactUtcTime(at)}.json`;
}

export function datasetReport(
  score: DatasetScore,
  args: DatasetScoreArgs,
  folder: DatasetFolder,
  org: { slug: string; id: string },
  times: { startedAt: Date; endedAt: Date },
): DatasetReport {
  return {
    reportVersion: DATASET_REPORT_VERSION,
    command: { org: args.org, folder: args.folder, baseUrl: args.baseUrl },
    org,
    folder: {
      path: folder.dir,
      org: folder.org,
      answerKey: {
        generatorVersion: folder.key.generatorVersion,
        seed: folder.key.seed,
        orgKey: folder.answerOrg.key,
      },
      facts: folder.facts.length,
      scannerRows: folder.duplicates.length,
      normalisationRows: folder.normalisation.length,
    },
    startedAt: times.startedAt.toISOString(),
    endedAt: times.endedAt.toISOString(),
    elapsedMs: times.endedAt.getTime() - times.startedAt.getTime(),
    score,
  };
}

/** The report as the file holds it: pretty JSON with a final newline. */
export function formatDatasetReport(report: DatasetReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
