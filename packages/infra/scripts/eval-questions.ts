// `pnpm eval:questions --folder <dataset folder> [--count 150] [--seed 1] [--out <file>]` (EV-001;
// D1, D45.8, D52.6, D81, D163, D164, D234, D261 track A, items 1 and 2): a question set made from
// the folder's answer key, three wordings per fact, which `pnpm bench:run` runs as it is, and its
// checks file beside it (each question's fact, fine kind, wording, target kinds and correct graph
// query; packages/benchmark/src/eval/).
// - Reads the folder through `readDatasetFolder`, plus `framework-mappings.json`'s requirement and
//   crosswalk names and `plants.json` (only the fields `parseEvalExtra` names).
// - `--count`: questions asked for, a whole number from 30 to the question-set limit (default 150).
//   `--seed`: a whole number from 0 (default 1). `--out`: a `.json` file under `data/generated/`,
//   never under `data/generated/training/` (D234); default
//   `data/generated/eval/questions/<slug>-<count>-seed<seed>.json`. The checks file goes beside it
//   (`<name>.checks.json`). Both replace earlier files of the same names.
// - Every correct graph query is checked with the api's `checkGraphQuery` before anything is
//   written; one that is refused exits 1 naming the question ID and the reason.
// - A changed folder (`pnpm eval:changed`, EV-003): its `changes.json` is read and checked against
//   the folder; each question's `forbidden` list gets the old names and deleted links' far ends it
//   must not show, the facts touching a change come first, and the checks file's `changed` block
//   counts the changes. A bad `changes.json` exits 2.
// - Refused with exit 2, nothing written: unknown or repeated arguments, a bad count, seed or output
//   path, a folder `readDatasetFolder` refuses, a `framework-mappings.json` or `plants.json` that
//   can't be read or isn't in the shape read, and a `changes.json` that isn't valid or doesn't fit
//   the folder.
// No model, no database, no network: it reads files and writes two. The same folder, count and seed
// always write byte-identical files (D45.8). The output holds counts, IDs and paths only: never a
// question, a name or a query (D164); the texts go only into the git-ignored files (D81).
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the benchmark's, the shared and the api's `./x.js` imports load
// their `.ts`.
type Env = typeof import('./org-script-env.js');
const { describeError, load } = (await import(new URL('./org-script-env.ts', import.meta.url).href)) as Env;
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;
type QueryCheckModule = typeof import('../../api/src/search/graph/query-check.js');
const { checkGraphQuery } = await load<QueryCheckModule>('search/graph/query-check.ts');

const NAME = 'eval:questions';
const FLAGS = ['--folder', '--count', '--seed', '--out'] as const;
type Flag = (typeof FLAGS)[number];

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GENERATED_DIR = join(REPO_ROOT, 'data', 'generated');
const TRAINING_DIR = join(GENERATED_DIR, 'training');
const DEFAULT_OUT_DIR = join(GENERATED_DIR, 'eval', 'questions');

const USAGE =
  `usage: pnpm ${NAME} --folder <dataset folder> ` +
  `[--count <${bench.EVAL_MIN_COUNT} to ${bench.EVAL_MAX_COUNT}, default ${bench.EVAL_DEFAULT_COUNT}>] ` +
  `[--seed <whole number, default ${bench.EVAL_DEFAULT_SEED}>] ` +
  '[--out <file.json under data/generated/, default data/generated/eval/questions/<slug>-<count>-seed<seed>.json>]';

function refuse(problems: readonly string[]): never {
  for (const p of problems) console.error(`${NAME}: ${p}`);
  console.error(USAGE);
  process.exit(2);
}

function wholeNumber(text: string): number | null {
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) ? n : null;
}

interface Args {
  folder: string;
  count: number;
  seed: number;
  out: string | null;
}

function parse(argv: readonly string[]): Args {
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
    const value = eq > 0 ? arg.slice(eq + 1) : i + 1 < argv.length ? argv[++i]! : '';
    if (values[flag] !== undefined) {
      problems.push(`${flag} is given twice`);
      continue;
    }
    values[flag] = value;
  }

  const folder = (values['--folder'] ?? '').trim();
  if (values['--folder'] === undefined) problems.push('--folder is missing (the dataset folder)');
  else if (folder === '') problems.push('--folder must not be empty');

  const count = wholeNumber((values['--count'] ?? String(bench.EVAL_DEFAULT_COUNT)).trim());
  if (count === null || count < bench.EVAL_MIN_COUNT || count > bench.EVAL_MAX_COUNT) {
    problems.push(
      `--count must be a whole number from ${bench.EVAL_MIN_COUNT} to ${bench.EVAL_MAX_COUNT} ` +
        `(the question-set limit is ${bench.EVAL_MAX_COUNT})`,
    );
  }

  const seed = wholeNumber((values['--seed'] ?? String(bench.EVAL_DEFAULT_SEED)).trim());
  if (seed === null) problems.push('--seed must be a whole number from 0');

  let out: string | null = null;
  if (values['--out'] !== undefined) {
    out = values['--out'].trim();
    if (out === '') problems.push('--out must not be empty');
  }

  if (problems.length > 0) refuse(problems);
  return { folder, count: count!, seed: seed!, out };
}

/** Whether `path` is inside `dir` (not `dir` itself). Case-insensitive when `fold` is set. */
function isInside(dir: string, path: string, fold = false): boolean {
  const rel = fold ? relative(dir.toLowerCase(), path.toLowerCase()) : relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The path with its nearest existing folder's links followed, so a link can't lead outside. */
function realPathOf(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/** The output path's problem, or null when it may be written: a `.json` file under `data/generated/`,
 * not under `data/generated/training/`, also once links are followed. */
function outProblem(path: string): string | null {
  if (!path.endsWith('.json')) return '--out must end in .json';
  const real = realPathOf(path);
  const generated = realPathOf(GENERATED_DIR);
  const training = realPathOf(TRAINING_DIR);
  for (const p of [path, real]) {
    if (!isInside(GENERATED_DIR, p) && !isInside(generated, p)) return '--out must be under data/generated/';
    // Folded: on the Mac's file system `Training` is `training`.
    if (isInside(TRAINING_DIR, p, true) || isInside(training, p, true)) {
      return '--out must not be under data/generated/training/ (Company X is never training data, D234)';
    }
  }
  if (existsSync(path) && !statSync(path).isFile()) return '--out names something that is not a file';
  return null;
}

/** Shown as given, relative to the working folder when it is inside it. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

const args = parse(process.argv.slice(2));
if (args.out !== null) {
  const problem = outProblem(resolve(process.cwd(), args.out));
  if (problem !== null) refuse([problem]);
}

// The folder, checked whole; its problems name files and fields only (D164).
let folder: Awaited<ReturnType<Benchmark['readDatasetFolder']>>;
try {
  folder = await bench.readDatasetFolder(resolve(process.cwd(), args.folder));
} catch (err) {
  if (err instanceof bench.DatasetFolderError) {
    refuse(err.problems.length > 0 ? err.problems.map(bench.datasetProblemLine) : [err.message]);
  }
  refuse([`the dataset folder could not be read: ${describeError(err)}`]);
}

/** One JSON file of the folder, parsed; refused (exit 2) when it can't be. */
function readFolderJson(file: string): unknown {
  const path = join(folder.dir, file);
  let text: string;
  try {
    const info = statSync(path);
    if (!info.isFile()) refuse([`${file}: (the whole file): is missing (not a file)`]);
    if (info.size > bench.MAX_DATASET_JSON_BYTES) {
      refuse([`${file}: (the whole file): is over ${bench.MAX_DATASET_JSON_BYTES} bytes`]);
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    refuse([
      `${file}: (the whole file): ${code === 'ENOENT' ? 'is missing' : `can't be read (${describeError(err)})`}`,
    ]);
  }
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) as unknown;
  } catch {
    // Never JSON's own message: it quotes the text around the mistake.
    refuse([`${file}: (the whole file): is not valid JSON`]);
  }
}

let extra: ReturnType<Benchmark['parseEvalExtra']>;
try {
  extra = bench.parseEvalExtra(
    readFolderJson(bench.DATASET_FILES.frameworkMappings),
    readFolderJson(bench.EVAL_PLANTS_FILE),
  );
} catch (err) {
  if (err instanceof bench.DatasetFolderError) refuse(err.problems.map(bench.datasetProblemLine));
  refuse([`the folder's extras could not be read: ${describeError(err)}`]);
}

// A changed folder's changes, checked against the folder; its problems name fields only (D164).
let changes: Awaited<ReturnType<Benchmark['loadChangesFile']>>;
try {
  changes = await bench.loadChangesFile(folder.dir);
} catch (err) {
  if (err instanceof bench.ChangesFileError) {
    refuse(err.problems.map((p) => `${bench.CHANGES_FILE}: ${p.field}: ${p.message}`));
  }
  refuse([`${bench.CHANGES_FILE} could not be read: ${describeError(err)}`]);
}
if (changes !== null) {
  const problems = bench.checkChangesFitFolder(changes, folder);
  if (problems.length > 0) {
    refuse(problems.map((p) => `${bench.CHANGES_FILE}: ${p.field}: ${p.message} (it doesn't fit the folder)`));
  }
}

const outPath =
  args.out !== null
    ? resolve(process.cwd(), args.out)
    : join(DEFAULT_OUT_DIR, `${folder.org.slug}-${args.count}-seed${args.seed}.json`);
{
  const problem = outProblem(outPath);
  if (problem !== null) refuse([problem]);
}
const checksPath = bench.checksPathFor(outPath);
{
  const problem = outProblem(checksPath);
  if (problem !== null) refuse([problem.replace('--out', 'the checks file beside --out')]);
}

let built: ReturnType<Benchmark['buildEvalSet']>;
try {
  built = bench.buildEvalSet(folder, extra, {
    count: args.count,
    seed: args.seed,
    ...(changes !== null ? { changes } : {}),
  });
} catch (err) {
  if (err instanceof bench.EvalSetBuildError) {
    if (err.code === 'bad_option') refuse([err.message]);
    console.error(`${NAME}: ${err.code}: ${err.message}. Nothing was written.`);
    process.exit(1);
  }
  console.error(`${NAME}: the set could not be built: ${describeError(err)}. Nothing was written.`);
  process.exit(1);
}
const { set, checks, counts } = built;

// Every correct graph query passes the graph path's own checks, or nothing is written.
const refused: string[] = [];
for (const q of checks.questions) {
  if (q.goldQuery === null) continue;
  const check = checkGraphQuery(q.goldQuery);
  if (!check.ok) refused.push(`question ${q.id}: its correct graph query is refused (${check.reason})`);
}
if (refused.length > 0) {
  for (const line of refused) console.error(`${NAME}: ${line}`);
  console.error(`${NAME}: correct graph queries refused: ${refused.length}. Nothing was written.`);
  process.exit(1);
}

// Both files, each written whole and then moved into place.
try {
  mkdirSync(dirname(outPath), { recursive: true });
  for (const [path, text] of [
    [outPath, bench.formatQuestionSet(set)],
    [checksPath, bench.formatEvalChecks(checks)],
  ] as const) {
    const part = `${path}.part`;
    writeFileSync(part, text);
    renameSync(part, path);
  }
} catch (err) {
  console.error(`${NAME}: the files could not be written: ${describeError(err)}`);
  process.exit(1);
}

const list = <K extends string>(keys: readonly K[], values: Record<K, number>): string =>
  keys.map((k) => `${k} ${values[k]}`).join(', ');
const lines: string[] = [];
lines.push(
  `${NAME}: ${counts.questions} question(s) written in ${counts.groups} group(s)` +
    (counts.fixed.written > 0 ? ` plus ${counts.fixed.written} fixed` : '') +
    ` (asked for ${counts.asked})`,
);
lines.push(`  set: ${shown(outPath)}`);
lines.push(`  checks: ${shown(checksPath)}`);
lines.push(`  by kind: ${list(bench.EVAL_QUESTION_KINDS, counts.perKind)}`);
lines.push(`  by wording: ${list(bench.EVAL_WORDINGS, counts.perWording)}`);
const kinds = bench.EVAL_MIX.map((row) => row.kind);
lines.push(
  `  groups by kind (share): ${kinds.map((k) => `${k} ${counts.groupsPerKind[k]} (${counts.shares[k]})`).join(', ')}`,
);
if (counts.shortfalls.length > 0) {
  lines.push(
    `  shortfall: ${counts.shortfalls.map((s) => `${s.kind} made ${s.made} of ${s.share}`).join(', ')}; ` +
      `passed on: ${list(bench.SHORTFALL_ORDER, counts.passedOn)}; not made: ${counts.unfilled} group(s)`,
  );
} else {
  lines.push('  shortfall: none');
}
lines.push(`  groups dropped: ${list(bench.EVAL_DROP_REASONS, counts.dropped)}`);
lines.push(`  fixed templates: ${counts.fixed.written} written, ${counts.fixed.leftOut} left out`);
if (checks.changed !== null) {
  lines.push(
    `  changed folder: ${checks.changed.renames} rename(s), ${checks.changed.deletions} deletion(s); ` +
      `questions with forbidden names: ${counts.withForbidden} of ${counts.questions}`,
  );
}
if (counts.questions < counts.asked) {
  lines.push(
    `  fewer questions than asked for: ${counts.questions} of ${counts.asked}` +
      ' (a remainder under 3 makes no group, and a shortfall no kind could take is not made)',
  );
}
for (const line of lines) console.log(line);
