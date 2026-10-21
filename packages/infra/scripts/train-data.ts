// `pnpm train:data --jobs <list> [--seed <n>] [--worlds <n>] [--size <name>] [--max-per-job <n>]
// [--name <name>] [--tokenizer-dir <dir>]` (TR-001; D18, D45.8, D81, D164, D234, D239, D246–D248):
// the training file for fine-tuning the text model, built offline from the project's generators.
// - Makes `data/generated/training/<name>/train.jsonl` and `manifest.json` (git-ignored, D81) in
//   memory from `buildWorld` + `renderSources` alone: world seeds `seed` … `seed + worlds - 1`.
//   No option reads a folder, an answer key or an org, and no value may name Company X or point
//   under `docs/datasets/` (D234). No model, network, database or stack.
// - `--jobs`: a comma list of `extraction`, `mapping`, `graph_query`, `answer` (training question 2
//   stays open, so the jobs are chosen here). A job with no builder yet is refused by name.
// - Defaults: `--seed 1000` (clear of `pnpm gen:data`'s and the benchmark's seed 1, so no
//   benchmark world is trained on), `--worlds 20`, `--size accuracy` (1,730 extraction rows,
//   about a fifth of the chunks left out as cut), `--max-per-job 3000` (D248), `--name train-<seed>-<worlds>-<size>`, `--tokenizer-dir`
//   the API's own folder (`packages/api/tokenizer/`).
// - One row per example (./training/rows.ts); the split is by world, about 90/10 (./training/
//   split.ts); a self-check sends one row of each job through the app's real client with a
//   stand-in for the network before anything is written (./training/self-check.ts).
// - Same arguments, byte-identical files: a fixed order and no clock time in either file.
// - Exit 2, before anything is written, for a refused argument; exit 1 for a failed self-check or
//   a bug in the rows, also with nothing written.
// The output holds the folder path, counts and warnings only: never a row's text (D164).
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The api's, the generators' and the shared sources import each other as `./x.js`, which are
// `./x.ts` files: plain `node` loads them with this hook (as org-script-env.ts does).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});

// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Jobs = typeof import('./training/jobs.js');
const { JOBS_WITHOUT_BUILDER, TRAINING_JOBS, isTrainingJob } = (await import(
  new URL('./training/jobs.ts', import.meta.url).href
)) as Jobs;
type Generators = typeof import('../../generators/src/index.js');
const gen = (await import(new URL('../../generators/src/index.ts', import.meta.url).href)) as Generators;
type TrainingJob = import('./training/jobs.js').TrainingJob;
type SizeName = import('../../generators/src/index.js').SizeName;

const FLAGS = ['--jobs', '--seed', '--worlds', '--size', '--max-per-job', '--name', '--tokenizer-dir'] as const;
type Flag = (typeof FLAGS)[number];

const DEFAULT_SEED = 1000;
const DEFAULT_WORLDS = 20;
const DEFAULT_SIZE: SizeName = 'accuracy';
const DEFAULT_MAX_PER_JOB = 3000;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SIZE_NAMES = Object.keys(gen.SIZES) as SizeName[];

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TRAINING_DIR = 'data/generated/training';
const DATASETS_DIR = join(REPO_ROOT, 'docs', 'datasets');

const USAGE =
  `usage: pnpm train:data --jobs <comma list of ${TRAINING_JOBS.join(', ')}> ` +
  `[--seed <whole number from 1, default ${DEFAULT_SEED}>] [--worlds <whole number from 2, default ${DEFAULT_WORLDS}>] ` +
  `[--size <${SIZE_NAMES.join('|')}, default ${DEFAULT_SIZE}>] [--max-per-job <whole number from 1, default ${DEFAULT_MAX_PER_JOB}>] ` +
  '[--name <a-z, 0-9 and -, default train-<seed>-<worlds>-<size>>] [--tokenizer-dir <folder, default packages/api/tokenizer/>]';

interface Args {
  jobs: TrainingJob[];
  seed: number;
  worlds: number;
  size: SizeName;
  maxPerJob: number;
  name: string;
  /** As given; undefined for the API's own folder. */
  tokenizerDir: string | undefined;
}

function refuse(problems: string[], usage = true): never {
  for (const p of problems) console.error(`train:data: ${p}`);
  if (usage) console.error(USAGE);
  process.exit(2);
}

function fail(problems: string[]): never {
  for (const p of problems) console.error(`train:data: ${p}`);
  console.error('train:data: nothing was written');
  process.exit(1);
}

/** A whole number from 1 written in digits, or null. */
function positiveWhole(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Whether a value names Company X, which training never reads (D234). */
function namesCompanyX(value: string): boolean {
  return value.toLowerCase().includes('company-x');
}

/** Whether a value spells out `docs/datasets` (D234), with either kind of slash, in any case. */
function spellsDatasets(value: string): boolean {
  return value.replaceAll('\\', '/').toLowerCase().includes('docs/datasets');
}

/** Whether a folder, as written, resolved or followed through links, is under `docs/datasets/` (D234). */
function pointsUnderDatasets(value: string): boolean {
  if (spellsDatasets(value)) return true;
  const paths = [resolve(process.cwd(), value)];
  try {
    paths.push(realpathSync(paths[0]!));
  } catch {
    // A folder that doesn't exist is refused later, for having no tokenizer files.
  }
  return paths.some((path) => {
    if (spellsDatasets(path)) return true;
    const rel = relative(DATASETS_DIR, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

function parse(argv: string[]): Args {
  const values: Partial<Record<Flag, string>> = {};
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = (eq > 0 ? arg.slice(0, eq) : arg) as Flag;
    if (!FLAGS.includes(flag)) {
      problems.push(`unknown argument ${JSON.stringify(arg)}`);
      continue;
    }
    if (values[flag] !== undefined) problems.push(`${flag} is given twice`);
    if (eq > 0) values[flag] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) values[flag] = argv[++i]!;
    else values[flag] = '';
  }

  // No value may name Company X or point under docs/datasets/ (D234).
  for (const flag of FLAGS) {
    const value = values[flag];
    if (value === undefined) continue;
    if (namesCompanyX(value)) problems.push(`${flag} names company-x: training data never comes from Company X (D234)`);
    else if (flag === '--tokenizer-dir' ? pointsUnderDatasets(value) : spellsDatasets(value)) {
      problems.push(`${flag} points under docs/datasets/: training data never comes from a dataset folder (D234)`);
    }
  }

  const jobs: TrainingJob[] = [];
  const jobsText = values['--jobs'];
  if (jobsText === undefined) problems.push('--jobs is missing (a comma list of jobs)');
  else if (jobsText.trim() === '') problems.push('--jobs needs a value (a comma list of jobs)');
  else {
    for (const item of jobsText.split(',').map((part) => part.trim())) {
      if (item === '') problems.push('--jobs has an empty item');
      else if (!isTrainingJob(item)) {
        problems.push(`--jobs: unknown job ${JSON.stringify(item)} (the jobs are ${TRAINING_JOBS.join(', ')})`);
      } else if (jobs.includes(item)) problems.push(`--jobs: ${item} is listed twice`);
      else {
        jobs.push(item);
        const why = JOBS_WITHOUT_BUILDER[item];
        if (why !== undefined) problems.push(`--jobs: ${item} has no builder yet: ${why}`);
      }
    }
  }

  const number = (flag: Flag, fallback: number, min: number): number => {
    const text = values[flag];
    if (text === undefined) return fallback;
    const n = positiveWhole(text.trim());
    if (n === null) {
      problems.push(`${flag} must be a positive whole number`);
      return fallback;
    }
    if (n < min) problems.push(`${flag} must be at least ${min}`);
    return n;
  };
  const seed = number('--seed', DEFAULT_SEED, 1);
  // One world at least goes to validation (about 10%), so a train side needs a second one.
  const worlds = number('--worlds', DEFAULT_WORLDS, 2);
  const maxPerJob = number('--max-per-job', DEFAULT_MAX_PER_JOB, 1);
  if (!Number.isSafeInteger(seed + worlds - 1)) problems.push('--seed plus --worlds is past the largest whole number');

  let size: SizeName = DEFAULT_SIZE;
  const sizeText = values['--size'];
  if (sizeText !== undefined) {
    const trimmed = sizeText.trim();
    if ((SIZE_NAMES as string[]).includes(trimmed)) size = trimmed as SizeName;
    else problems.push(`--size must be one of ${SIZE_NAMES.join(', ')}`);
  }

  const nameText = values['--name'];
  const name = nameText === undefined ? `train-${seed}-${worlds}-${size}` : nameText;
  if (!NAME.test(name)) {
    problems.push(
      nameText === undefined
        ? `the default name ${JSON.stringify(name)} is not a valid name; give --name`
        : '--name must be 1 to 64 of a-z, 0-9 and -, starting with a letter or digit',
    );
  }

  const tokenizerText = values['--tokenizer-dir'];
  if (tokenizerText !== undefined && tokenizerText.trim() === '') problems.push('--tokenizer-dir needs a folder');

  if (problems.length > 0) refuse(problems);
  // In the file's order, whatever order they were listed in.
  const ordered = TRAINING_JOBS.filter((job) => jobs.includes(job));
  return { jobs: ordered, seed, worlds, size, maxPerJob, name, tokenizerDir: tokenizerText };
}

/** An error in a few words: its name and code only (D163, D164). */
function describeError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'type=unknown';
  const e = err as { name?: unknown; code?: unknown };
  const type = typeof e.name === 'string' ? e.name : 'unknown';
  return typeof e.code === 'string' ? `type=${type} code=${e.code}` : `type=${type}`;
}

const args = parse(process.argv.slice(2));
const relativeOut = `${TRAINING_DIR}/${args.name}`;
const outDir = join(REPO_ROOT, TRAINING_DIR, args.name);
if (existsSync(outDir)) {
  refuse([`${relativeOut}/ already exists: pick another --name or delete the folder`], false);
}

// The api's reader, chunker and tokenizer, and the builders that use them.
type Tokenizer = typeof import('../../api/src/processing/reader/tokenizer.js');
const tokenizer = (await import(
  new URL('../../api/src/processing/reader/tokenizer.ts', import.meta.url).href
)) as Tokenizer;
type TokenizerSource = typeof import('../../api/src/processing/reader/tokenizer-source.js');
const tokenizerSource = (await import(
  new URL('../../api/src/processing/reader/tokenizer-source.ts', import.meta.url).href
)) as TokenizerSource;
type Build = typeof import('./training/build.js');
const build = (await import(new URL('./training/build.ts', import.meta.url).href)) as Build;
type Rows = typeof import('./training/rows.js');
const { TrainingDataBug } = (await import(new URL('./training/rows.ts', import.meta.url).href)) as Rows;

const tokenizerDir =
  args.tokenizerDir === undefined ? tokenizerSource.defaultTokenizerDir() : resolve(process.cwd(), args.tokenizerDir);
try {
  await tokenizer.checkTokenizerFiles(tokenizerDir);
} catch (err) {
  if (err instanceof tokenizer.TokenizerUnavailableError) {
    refuse(
      [
        `--tokenizer-dir: ${tokenizerDir} does not hold bge-m3's tokenizer files (${err.code}, ${err.file}); ` +
          `run \`${tokenizerSource.TOKENIZER_SETUP_COMMAND}\`, or give --tokenizer-dir the folder that has them`,
      ],
      false,
    );
  }
  refuse([`--tokenizer-dir: the tokenizer files could not be read (${describeError(err)})`], false);
}
let counter: Awaited<ReturnType<Tokenizer['loadTokenCounter']>>;
try {
  counter = await tokenizer.loadTokenCounter(tokenizerDir);
} catch (err) {
  fail([`bge-m3's tokenizer could not be loaded: ${describeError(err)}`]);
}

const plan = {
  jobs: args.jobs,
  seed: args.seed,
  worlds: args.worlds,
  size: gen.parseSize(args.size),
  maxPerJob: args.maxPerJob,
};
console.log(
  `train:data: building ${args.jobs.join(', ')} from ${args.worlds} ${args.size} world(s), seeds ${args.seed} to ${args.seed + args.worlds - 1}`,
);
let set: Awaited<ReturnType<Build['buildTrainingSet']>>;
try {
  set = await build.buildTrainingSet(plan, { counter });
} catch (err) {
  if (err instanceof TrainingDataBug) fail([`a bug in the rows: ${err.message}`]);
  fail([`the rows could not be built: ${describeError(err)}`]);
}

const problems = await build.selfCheckAll(set);
if (problems.length > 0) fail(['the self-check failed: the rows are not what the app sends', ...problems]);
console.log(`train:data: self-check passed (${set.jobs.map((j) => j.job).join(', ')})`);

const manifest = {
  arguments: {
    jobs: args.jobs,
    seed: args.seed,
    worlds: args.worlds,
    size: args.size,
    maxPerJob: args.maxPerJob,
    name: args.name,
    tokenizerDir: args.tokenizerDir ?? null,
  },
  size: plan.size,
  seeds: { worlds: set.worldSeeds, validation: set.validationSeeds },
  generatorVersion: gen.GENERATOR_VERSION,
  promptVersions: Object.fromEntries(set.jobs.map((j) => [j.job, j.promptVersion])),
  rows: Object.fromEntries(set.jobs.map((j) => [j.job, j.rows])),
  rowsBeforeCap: Object.fromEntries(set.jobs.map((j) => [j.job, j.built])),
  dropped: Object.fromEntries(set.jobs.map((j) => [j.job, j.dropped])),
  tokenizer: {
    repository: tokenizerSource.BGE_M3_TOKENIZER.repository,
    revision: tokenizerSource.BGE_M3_TOKENIZER.revision,
  },
  files: {
    'train.jsonl': {
      rows: set.jobs.reduce((sum, j) => sum + j.rows.train + j.rows.validation, 0),
      bytes: Buffer.byteLength(set.jsonl),
      sha256: createHash('sha256').update(set.jsonl).digest('hex'),
    },
  },
  warnings: set.warnings,
};

try {
  mkdirSync(join(REPO_ROOT, TRAINING_DIR), { recursive: true });
  // Not recursive: a folder made since the check above is refused, never written into.
  mkdirSync(outDir);
} catch (err) {
  if ((err as { code?: unknown } | null)?.code === 'EEXIST') {
    refuse([`${relativeOut}/ already exists: pick another --name or delete the folder`], false);
  }
  fail([`${relativeOut}/ could not be made: ${describeError(err)}`]);
}
try {
  writeFileSync(join(outDir, 'train.jsonl'), set.jsonl);
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} catch (err) {
  rmSync(outDir, { recursive: true, force: true });
  fail([`${relativeOut}/ could not be written: ${describeError(err)}`]);
}

console.log(`train:data: wrote ${relativeOut}/ (train.jsonl, manifest.json)`);
console.log(`  validation worlds: seeds ${set.validationSeeds.join(', ')}`);
for (const job of set.jobs) {
  console.log(`  ${job.job} (${job.promptVersion}): train ${job.rows.train}, validation ${job.rows.validation}`);
  const capped = job.built.train + job.built.validation - (job.rows.train + job.rows.validation);
  if (capped > 0) console.log(`  ${job.job}: ${capped} row(s) left out by --max-per-job ${args.maxPerJob}`);
  const dropped = Object.entries(job.dropped)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  console.log(`  ${job.job} dropped: ${dropped}`);
}
for (const warning of set.warnings) console.log(`train:data: warning: ${warning}`);
