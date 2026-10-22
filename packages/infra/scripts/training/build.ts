// The training set of `pnpm train:data` (TR-001; D18, D45.8, D234, D239, D248), made in memory from
// the generators alone: for each world seed `seed` … `seed + worlds - 1`, `buildWorld({seed, size})`
// and `renderSources`, then each chosen job's rows. No folder, answer key or org is read, and
// nothing is written here.
// - The split is by world (./split.ts); a job with more rows than its cap keeps a seeded sample of
//   that many in the same split ratio, its made-up-name rows (TR-002) at no more than their share;
//   a job with fewer than 1,000 rows gets a warning (D248). More than one row in MADE_UP_ONE_IN of
//   a job about a made-up name, before or after the cap, is a bug.
// - The order is fixed: the jobs in TRAINING_JOBS order, each job's rows in the order they were
//   built (extraction: world, org, document, chunk; graph_query: world, org, shape, record, then
//   the org's made-up names). So the same arguments give the same rows (principle 8).
// - The self-check sends one row of each job (the one with the longest answer, the first on a
//   tie) through the app's real client before anything is written (./self-check.ts).
import { buildWorld, renderSources, type SizeSpec } from '../../../generators/src/index.js';
import { extractionBuilder } from './extraction.js';
import { graphQueryBuilder } from './graph-query.js';
import { JOBS_WITHOUT_BUILDER, TRAINING_JOBS, type Split, type TrainingJob } from './jobs.js';
import {
  MADE_UP_ONE_IN,
  TrainingDataBug,
  rowLine,
  rowOf,
  type BuildContext,
  type JobBuilder,
  type TrainingExample,
} from './rows.js';
import { selfCheck } from './self-check.js';
import { sampleKeepingShare, validationSeeds } from './split.js';

/** The jobs that have a builder: `extraction` (TR-001) and `graph_query` (TR-002). */
export const JOB_BUILDERS: Readonly<Partial<Record<TrainingJob, JobBuilder>>> = Object.freeze({
  extraction: extractionBuilder,
  graph_query: graphQueryBuilder,
});

/** Fewer rows than this for a job gets a warning (D248: about 1,000 to 3,000 rows a job). */
export const MIN_ROWS_PER_JOB = 1000;

export interface TrainingPlan {
  jobs: readonly TrainingJob[];
  seed: number;
  worlds: number;
  size: SizeSpec;
  maxPerJob: number;
}

export interface JobSummary {
  job: TrainingJob;
  promptVersion: string;
  /** Rows per split before the cap, and in the file. */
  built: Record<Split, number>;
  rows: Record<Split, number>;
  /** The rows in the file that ask about a made-up name. */
  madeUpRows: number;
  /** Examples left out, per reason, every reason listed. */
  dropped: Record<string, number>;
}

export interface TrainingSet {
  worldSeeds: number[];
  validationSeeds: number[];
  jobs: JobSummary[];
  /** `train.jsonl`, whole. */
  jsonl: string;
  /** One example of each job, for the self-check. */
  checkRows: { builder: JobBuilder; example: TrainingExample }[];
  warnings: string[];
}

/** The builders of the chosen jobs, in TRAINING_JOBS order; throws for a job with none. */
export function buildersFor(jobs: readonly TrainingJob[]): JobBuilder[] {
  return TRAINING_JOBS.filter((job) => jobs.includes(job)).map((job) => {
    const builder = JOB_BUILDERS[job];
    if (builder === undefined) throw new Error(`${job} has no builder: ${JOBS_WITHOUT_BUILDER[job] ?? 'none yet'}`);
    return builder;
  });
}

/** The example of a job the self-check sends: the longest answer, the first on a tie. */
function checkExampleOf(examples: readonly TrainingExample[]): TrainingExample | undefined {
  let best: TrainingExample | undefined;
  for (const example of examples) {
    if (best === undefined || example.assistant.length > best.assistant.length) best = example;
  }
  return best;
}

/** Builds every row of the plan in memory (see the top of the file). Writes nothing. */
export async function buildTrainingSet(plan: TrainingPlan, ctx: BuildContext): Promise<TrainingSet> {
  const builders = buildersFor(plan.jobs);
  const worldSeeds = Array.from({ length: plan.worlds }, (_, i) => plan.seed + i);
  const validation = new Set(validationSeeds(plan.seed, worldSeeds));
  const splitOf = (example: TrainingExample): Split => (validation.has(example.seed) ? 'validation' : 'train');

  const examples = new Map<TrainingJob, TrainingExample[]>(builders.map((b) => [b.job, []]));
  const dropped = new Map<TrainingJob, Record<string, number>>(
    builders.map((b) => [b.job, Object.fromEntries(b.dropReasons.map((reason) => [reason, 0]))]),
  );
  for (const worldSeed of worldSeeds) {
    const key = buildWorld({ seed: worldSeed, size: plan.size });
    const world = { seed: worldSeed, key, sources: renderSources(key) };
    for (const builder of builders) {
      const built = await builder.build(world, ctx);
      examples.get(builder.job)!.push(...built.examples);
      const counts = dropped.get(builder.job)!;
      for (const [reason, n] of Object.entries(built.dropped)) counts[reason] = (counts[reason] ?? 0) + n;
    }
  }

  const jobs: JobSummary[] = [];
  const checkRows: TrainingSet['checkRows'] = [];
  const warnings: string[] = [];
  let jsonl = '';
  for (const builder of builders) {
    const all = examples.get(builder.job)!;
    const isMadeUp = (example: TrainingExample): boolean => example.madeUp === true;
    if (all.filter(isMadeUp).length * MADE_UP_ONE_IN > all.length) {
      throw new TrainingDataBug(`${builder.job}: more than one row in ${MADE_UP_ONE_IN} asks about a made-up name`);
    }
    const { kept, before } = sampleKeepingShare(all, splitOf, isMadeUp, plan.maxPerJob, plan.seed, builder.job);
    const madeUpRows = kept.filter(isMadeUp).length;
    if (madeUpRows * MADE_UP_ONE_IN > kept.length) {
      throw new TrainingDataBug(
        `${builder.job}: more than one row in ${MADE_UP_ONE_IN} asks about a made-up name after the cap`,
      );
    }
    const rows: Record<Split, number> = { train: 0, validation: 0 };
    for (const example of kept) {
      const split = splitOf(example);
      rows[split] += 1;
      jsonl += rowLine(rowOf(example, split));
    }
    jobs.push({
      job: builder.job,
      promptVersion: builder.promptVersion,
      built: before,
      rows,
      madeUpRows,
      dropped: dropped.get(builder.job)!,
    });
    const total = rows.train + rows.validation;
    if (total < MIN_ROWS_PER_JOB) {
      warnings.push(`${builder.job} has ${total} row(s), fewer than ${MIN_ROWS_PER_JOB} (D248); add --worlds`);
    }
    if (rows.train === 0) warnings.push(`${builder.job} has no train rows`);
    if (rows.validation === 0) warnings.push(`${builder.job} has no validation rows`);
    const example = checkExampleOf(kept);
    if (example !== undefined) checkRows.push({ builder, example });
  }
  return { worldSeeds, validationSeeds: [...validation].sort((a, b) => a - b), jobs, jsonl, checkRows, warnings };
}

/** Runs the self-check on one row of each job; the problems found, empty when all pass. */
export async function selfCheckAll(set: TrainingSet): Promise<string[]> {
  const problems: string[] = [];
  for (const summary of set.jobs) {
    const row = set.checkRows.find((r) => r.builder.job === summary.job);
    if (row === undefined) {
      problems.push(`${summary.job}: it gave no rows, so no row could be checked`);
      continue;
    }
    problems.push(...(await selfCheck(row.builder, row.example)));
  }
  return problems;
}
