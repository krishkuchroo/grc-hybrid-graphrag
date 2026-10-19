// The output of `pnpm dataset:score` (FT-001; D164): the org's slug, the counts and ratios of the
// score, the time taken and the report's path. Counts, ratios, link types, origins, statuses and
// codes only: never a record's name, a sentence, a value or a file name. Pure.
import { LINK_TYPES, RECORD_KINDS, REVIEW_FINDING_STATUSES, type ReviewFindingStatus } from '@grc/shared';
import { DATASET_LINK_ORIGINS } from './folder.js';
import {
  DUPLICATE_STATES,
  FACT_STATES,
  LIVE_LINK_ORIGINS,
  NORMALISATION_STATES,
  type DatasetScore,
  type FactState,
} from './score.js';

export interface DatasetScoreOutputContext {
  org: string;
  /** The folder's path, as given. */
  folder: string;
  elapsedMs: number;
  /** The report's path, as printed; null when none was written. */
  reportPath: string | null;
}

/** `n (0.123)` of a denominator, or `n (-)` when it is 0. */
function share(n: number, of: number): string {
  return `${n} (${of === 0 ? '-' : (n / of).toFixed(3)})`;
}

function states(counts: Record<FactState, number>, total: number): string {
  return FACT_STATES.map((s) => `${s} ${share(counts[s], total)}`).join(', ');
}

function statuses(counts: Record<ReviewFindingStatus, number>): string {
  return REVIEW_FINDING_STATUSES.map((s) => `${s} ${counts[s]}`).join(', ');
}

const words = (code: string): string => code.replace(/_/g, ' ');

/** The output lines of a score. */
export function datasetScoreOutput(score: DatasetScore, context: DatasetScoreOutputContext): string[] {
  const lines: string[] = [];
  const { records, links, duplicates, normalisation } = score;
  const read = RECORD_KINDS.reduce((n, k) => n + records.read[k], 0);
  const active = RECORD_KINDS.reduce((n, k) => n + records.active[k], 0);
  lines.push(
    `dataset:score: ${context.org} against ${context.folder} (${(context.elapsedMs / 1000).toFixed(1)} s)`,
    `  records read ${read} (${active} active): ${RECORD_KINDS.map((k) => `${k} ${records.active[k]}`).join(', ')}`,
    `  active records matched to no answer-key record: ${RECORD_KINDS.map((k) => `${k} ${records.unmatched[k]}`).join(', ')}`,
    `  links: ${links.facts} fact(s); ${states(links.byState, links.facts)}; extra ${links.extra} ` +
      `(${links.live} live link(s) read)`,
    `    found by the live links' origin: ${LIVE_LINK_ORIGINS.map((o) => `${o} ${links.foundByLinkOrigin[o]}`).join(', ')}`,
    '    by link type:',
  );
  for (const { type } of LINK_TYPES) {
    const counts = links.byType[type];
    const total = FACT_STATES.reduce((n, s) => n + counts[s], 0);
    lines.push(`      ${type.padEnd(13)} ${total} fact(s): ${states(counts, total)}; extra ${links.extraByType[type]}`);
  }
  lines.push('    by origin:');
  for (const origin of DATASET_LINK_ORIGINS) {
    const counts = links.byOrigin[origin];
    const total = FACT_STATES.reduce((n, s) => n + counts[s], 0);
    lines.push(`      ${origin.padEnd(13)} ${total} fact(s): ${states(counts, total)}`);
  }
  lines.push(`    link findings read: ${statuses(links.findings)}`);

  if (duplicates === null) {
    lines.push('  duplicates: not applicable (the org holds no asset list rows; a fast-loaded org)');
  } else {
    lines.push(
      `  duplicates: ${duplicates.rows} scanner row(s); ` +
        DUPLICATE_STATES.map((s) => `${words(s)} ${share(duplicates.byState[s], duplicates.rows)}`).join(', '),
      `    flagged, by the finding's status: ${statuses(duplicates.flaggedByStatus)}`,
      `    duplicate findings read: ${statuses(duplicates.findings)}`,
    );
  }
  if (normalisation === null) {
    lines.push('  normalisation: not applicable (the org holds no asset list rows; a fast-loaded org)');
  } else {
    lines.push(
      `  normalisation: ${normalisation.rows} value(s); ` +
        NORMALISATION_STATES.map((s) => `${words(s)} ${share(normalisation.byState[s], normalisation.rows)}`).join(
          ', ',
        ),
    );
    for (const [field, counts] of Object.entries(normalisation.byField)) {
      const total = NORMALISATION_STATES.reduce((n, s) => n + counts[s], 0);
      lines.push(
        `    ${field.padEnd(20)} ${NORMALISATION_STATES.map((s) => `${words(s)} ${share(counts[s], total)}`).join(', ')}`,
      );
    }
  }
  lines.push(
    context.reportPath === null
      ? 'No report was written.'
      : `Report (names, sentences and every item): ${context.reportPath}`,
  );
  return lines;
}
