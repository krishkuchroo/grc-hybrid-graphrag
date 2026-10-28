// `pnpm eval:changed --from <dataset folder> --to <new folder under data/generated/> [--seed 1]
// [--renames 8] [--deletions 20] [--slug <slug>] [--replace]` (EV-003; D45.8, D81, D163, D164, D234,
// D235, D261 track A, item 4): a copy of a dataset folder with some records renamed to made-up names
// and some links deleted, for the changed-data test (packages/benchmark/src/eval/changed-folder.ts).
// An answer about the changed org that still shows an old name or a deleted link came from training
// memory, not from the data.
// - Writes every file `readDatasetFolder` reads, `sources/**`, `plants.json` and `changes.json` (the
//   renames and deletions). Not `questions-*.json`: a hand-written set would be stale. The manifest
//   gets the new slug (default `<from slug>-changed`) and the org name "<from name> (changed)",
//   every other field kept, plus a short `changed` note.
// - Before it finishes it checks the written folder: no old name left (except a control's name right
//   after its 800-53 code), every deleted sentence gone, every kept sentence still there, and
//   `readDatasetFolder` accepts it. A failed check exits 1 naming the file and the count, and
//   nothing is left behind.
// - Refused with exit 2, nothing written: bad arguments; a `--to` that isn't under `data/generated/`
//   or is under `data/generated/training/` (D234); a `--to` that exists and isn't empty, unless
//   `--replace` is given and it holds a `changes.json` (only such a folder is ever removed); a
//   `--from` that `readDatasetFolder` refuses or whose `plants.json` can't be read; renames outside
//   0–40 or deletions outside 0–100; a slug that isn't a benchmark org slug, is too long or is the
//   `--from` slug.
// No model, no database, no network: it reads one folder and writes another. The same `--from`, seed
// and counts always write byte-identical files (D45.8). The output holds counts and paths only, never
// a name or a sentence (D164); those go only into the git-ignored folder (D81).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the benchmark's and the shared `./x.js` imports load their `.ts`.
type Env = typeof import('./org-script-env.js');
const { describeError } = (await import(new URL('./org-script-env.ts', import.meta.url).href)) as Env;
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;
type Shared = typeof import('../../shared/src/index.js');
const shared = (await import(new URL('../../shared/src/index.ts', import.meta.url).href)) as Shared;

const NAME = 'eval:changed';
const VALUE_FLAGS = ['--from', '--to', '--seed', '--renames', '--deletions', '--slug'] as const;
const SWITCHES = ['--replace'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GENERATED_DIR = join(REPO_ROOT, 'data', 'generated');
const TRAINING_DIR = join(GENERATED_DIR, 'training');

const USAGE =
  `usage: pnpm ${NAME} --from <dataset folder> --to <new folder under data/generated/> ` +
  `[--seed <whole number, default ${bench.CHANGED_DEFAULT_SEED}>] ` +
  `[--renames <0 to ${bench.MAX_RENAMES}, default ${bench.CHANGED_DEFAULT_RENAMES}>] ` +
  `[--deletions <0 to ${bench.MAX_DELETIONS}, default ${bench.CHANGED_DEFAULT_DELETIONS}>] ` +
  '[--slug <slug, default <from slug>-changed>] [--replace]';

function refuse(problems: readonly string[]): never {
  for (const p of problems) console.error(`${NAME}: ${p}`);
  console.error(USAGE);
  process.exit(2);
}

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(`${NAME}: ${line}`);
  process.exit(1);
}

function wholeNumber(text: string): number | null {
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) ? n : null;
}

interface Args {
  from: string;
  to: string;
  seed: number;
  renames: number;
  deletions: number;
  slug: string | null;
  replace: boolean;
}

function parse(argv: readonly string[]): Args {
  const values: Partial<Record<ValueFlag, string>> = {};
  let replace = false;
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if ((SWITCHES as readonly string[]).includes(arg)) {
      if (replace) problems.push(`${arg} is given twice`);
      replace = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = (eq > 0 ? arg.slice(0, eq) : arg) as ValueFlag;
    if ((SWITCHES as readonly string[]).includes(flag)) {
      problems.push(`${flag} takes no value`);
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) {
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

  const from = (values['--from'] ?? '').trim();
  if (values['--from'] === undefined) problems.push('--from is missing (the dataset folder to copy)');
  else if (from === '') problems.push('--from must not be empty');
  const to = (values['--to'] ?? '').trim();
  if (values['--to'] === undefined) problems.push('--to is missing (the new folder, under data/generated/)');
  else if (to === '') problems.push('--to must not be empty');

  const number = (flag: ValueFlag, fallback: number, max: number): number | null => {
    const n = wholeNumber((values[flag] ?? String(fallback)).trim());
    if (n === null || n > max) {
      problems.push(`${flag} must be a whole number from 0${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}`);
      return null;
    }
    return n;
  };
  const seed = number('--seed', bench.CHANGED_DEFAULT_SEED, Number.MAX_SAFE_INTEGER);
  const renames = number('--renames', bench.CHANGED_DEFAULT_RENAMES, bench.MAX_RENAMES);
  const deletions = number('--deletions', bench.CHANGED_DEFAULT_DELETIONS, bench.MAX_DELETIONS);

  let slug: string | null = null;
  if (values['--slug'] !== undefined) {
    slug = values['--slug'].trim();
    if (slug === '') problems.push('--slug must not be empty');
  }

  if (problems.length > 0) refuse(problems);
  return { from, to, seed: seed!, renames: renames!, deletions: deletions!, slug, replace };
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

/** Whether two paths are the same or one holds the other (links followed, case folded). */
function overlaps(a: string, b: string): boolean {
  const [x, y] = [realPathOf(a).toLowerCase(), realPathOf(b).toLowerCase()];
  return x === y || isInside(x, y) || isInside(y, x);
}

/** The `--to` path's problem, or null when it may be written (see the top of the file). */
function toProblem(path: string, replace: boolean): string | null {
  const real = realPathOf(path);
  const generated = realPathOf(GENERATED_DIR);
  const training = realPathOf(TRAINING_DIR);
  for (const p of [path, real]) {
    if (!isInside(GENERATED_DIR, p) && !isInside(generated, p)) return '--to must be a folder under data/generated/';
    // Folded: on the Mac's file system `Training` is `training`.
    if (isInside(TRAINING_DIR, p, true) || isInside(training, p, true) || p.toLowerCase() === training.toLowerCase()) {
      return '--to must not be under data/generated/training/ (Company X is never training data, D234)';
    }
  }
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isDirectory()) return '--to names something that is not a folder';
  if (readdirSync(path).length === 0) return null;
  if (!replace) return '--to exists and is not empty (give --replace to replace a folder this command wrote)';
  const changes = join(path, bench.CHANGES_FILE);
  if (!existsSync(changes) || !lstatSync(changes).isFile()) {
    return `--to is not empty and holds no ${bench.CHANGES_FILE}, so it was not written by this command (not replaced)`;
  }
  return null;
}

/** Shown as given, relative to the working folder when it is inside it. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

const args = parse(process.argv.slice(2));
const fromPath = resolve(process.cwd(), args.from);
const toPath = resolve(process.cwd(), args.to);
{
  const problem = toProblem(toPath, args.replace);
  if (problem !== null) refuse([problem]);
  if (overlaps(fromPath, toPath)) refuse(['--to must not be --from, inside it, or hold it']);
}

// The folder, checked whole; its problems name files and fields only (D164).
let folder: Awaited<ReturnType<Benchmark['readDatasetFolder']>>;
try {
  folder = await bench.readDatasetFolder(fromPath);
} catch (err) {
  if (err instanceof bench.DatasetFolderError) {
    refuse(err.problems.length > 0 ? err.problems.map(bench.datasetProblemLine) : [err.message]);
  }
  refuse([`the dataset folder could not be read: ${describeError(err)}`]);
}

const slug = args.slug ?? bench.changedSlugOf(folder.org.slug);
{
  const problems: string[] = [];
  if (!shared.benchmarkOrgSlugSchema.safeParse(slug).success) {
    problems.push(
      `${args.slug === null ? 'the default slug' : '--slug'} must be lowercase letters and digits in parts joined by -`,
    );
  }
  if (slug.length > bench.MAX_DATASET_SLUG_LENGTH) {
    problems.push(
      `${args.slug === null ? 'the default slug' : '--slug'} must be at most ${bench.MAX_DATASET_SLUG_LENGTH} characters ` +
        '(its fast-load slug must still fit); give a shorter --slug',
    );
  }
  if (slug === folder.org.slug) problems.push("--slug must not be the --from folder's slug");
  if (problems.length > 0) refuse(problems);
}
const orgName = bench.changedOrgNameOf(folder.org.name);
if (orgName.length > 200) refuse(['the --from folder\'s org name is too long to add " (changed)" (200 at most)']);

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
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    // Never JSON's own message: it quotes the text around the mistake.
    refuse([`${file}: (the whole file): is not valid JSON`]);
  }
}

// The folder's JSON files, parsed, in a fixed order.
const jsonFiles = [...Object.values(bench.DATASET_FILES), bench.EVAL_PLANTS_FILE];
const json: Record<string, unknown> = {};
for (const file of jsonFiles) json[file] = readFolderJson(file);

let plants: ReturnType<Benchmark['parseEvalExtra']>['plants'];
try {
  plants = bench.parseEvalExtra(json[bench.DATASET_FILES.frameworkMappings], json[bench.EVAL_PLANTS_FILE]).plants;
} catch (err) {
  if (err instanceof bench.DatasetFolderError) refuse(err.problems.map(bench.datasetProblemLine));
  refuse([`the folder's extras could not be read: ${describeError(err)}`]);
}

// Every file under sources/, in a fixed order; a link must stay inside sources/.
const sourcesDir = join(folder.dir, bench.DATASET_SOURCES_DIR);
const realSources = realpathSync(sourcesDir);
const sources: Parameters<Benchmark['applyChanges']>[0]['sources'] = [];
function readSources(dir: string, rel: string[]): void {
  const entries = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry);
    const shownPath = [bench.DATASET_SOURCES_DIR, ...rel, entry].join('/');
    let info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const real = realpathSync(path);
      if (!isInside(realSources, real)) refuse([`${shownPath}: is a link that leads outside sources/`]);
      info = statSync(real);
    }
    if (info.isDirectory()) {
      readSources(path, [...rel, entry]);
      continue;
    }
    if (!info.isFile()) refuse([`${shownPath}: is not a file or a folder`]);
    if (info.size > shared.MAX_UPLOAD_BYTES)
      refuse([`${shownPath}: is over the ${shared.MAX_UPLOAD_BYTES}-byte limit`]);
    const bytes = new Uint8Array(readFileSync(path));
    const at = [...rel, entry].join('/');
    if (bench.isTextSource(at)) {
      try {
        // The BOM, when there is one, is kept, so the text gives back the file's own bytes.
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        sources.push({ path: at, content: { text } });
        continue;
      } catch {
        // Not UTF-8: copied as it is.
      }
    }
    sources.push({ path: at, content: { bytes } });
  }
}
try {
  readSources(sourcesDir, []);
} catch (err) {
  refuse([`sources/ could not be read: ${describeError(err)}`]);
}
const before = { json, sources };

// ---- The changes ---------------------------------------------------------------------------------
let planned: ReturnType<Benchmark['planChanges']>;
try {
  planned = bench.planChanges(folder, plants, { seed: args.seed, renames: args.renames, deletions: args.deletions });
} catch (err) {
  if (err instanceof bench.ChangePlanError) refuse([err.message]);
  fail([`the changes could not be planned: ${describeError(err)}. Nothing was written.`]);
}
const { changes, counts } = planned;
try {
  bench.parseChangesFile(changes);
} catch (err) {
  const field = err instanceof bench.ChangesFileError ? (err.problems[0]?.field ?? '') : describeError(err);
  fail([`the planned changes don't fit ${bench.CHANGES_FILE}'s format (${field}). Nothing was written.`]);
}
const after = bench.applyChanges(before, changes, { slug, name: orgName });
const removed = bench.sentencesRemoved(before, changes);

// ---- Written beside --to, checked, then moved into place ---------------------------------------
mkdirSync(dirname(toPath), { recursive: true });
const work = mkdtempSync(join(dirname(toPath), `.${basename(toPath)}.part-`));
const cleanUp = (): void => rmSync(work, { recursive: true, force: true });
try {
  for (const [file, value] of Object.entries(after.json))
    writeFileSync(join(work, file), bench.formatFolderJson(value));
  writeFileSync(join(work, bench.CHANGES_FILE), bench.formatChangesFile(changes));
  for (const source of after.sources) {
    const path = join(work, bench.DATASET_SOURCES_DIR, ...source.path.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'text' in source.content ? source.content.text : source.content.bytes);
  }
} catch (err) {
  cleanUp();
  fail([`the folder could not be written: ${describeError(err)}. Nothing was left behind.`]);
}

const problems = bench.checkChangedFiles(before, after, changes);
const lines: string[] = problems.map((p) => `check failed: ${p.file}: ${p.check} ${p.count}`);
try {
  await bench.readDatasetFolder(work);
} catch (err) {
  if (err instanceof bench.DatasetFolderError) {
    for (const p of err.problems)
      lines.push(`check failed: the written folder doesn't read back: ${bench.datasetProblemLine(p)}`);
    if (err.problems.length === 0) lines.push(`check failed: the written folder doesn't read back: ${err.message}`);
  } else {
    lines.push(`check failed: the written folder doesn't read back: ${describeError(err)}`);
  }
}
if (lines.length > 0) {
  cleanUp();
  fail([...lines, `checks failed: ${lines.length}. Nothing was left behind.`]);
}

try {
  if (existsSync(toPath)) {
    // Only an empty folder, or one this command wrote (it holds changes.json), gets here.
    const problem = toProblem(toPath, args.replace);
    if (problem !== null) {
      cleanUp();
      refuse([problem]);
    }
    rmSync(toPath, { recursive: true });
  }
  renameSync(work, toPath);
} catch (err) {
  cleanUp();
  fail([`the folder could not be moved into place: ${describeError(err)}`]);
}

const list = <K extends string>(keys: readonly K[], values: Record<K, number>): string =>
  keys.map((k) => `${k} ${values[k]}`).join(', ');
const renamed = changes.renames.length;
const deleted = changes.deletions.length;
const byteSources = after.sources.filter((s) => !('text' in s.content)).length;
const out: string[] = [];
out.push(`${NAME}: wrote ${shown(toPath)} (slug ${slug})`);
out.push(
  `  renames: ${renamed} of ${counts.renamesAsked} (${list(bench.RENAMED_KINDS, counts.renamesPerKind)}); ` +
    `eligible: ${list(bench.RENAMED_KINDS, counts.eligibleRenames)}`,
);
out.push(
  `  deletions: ${deleted} of ${counts.deletionsAsked} (${list(bench.DELETED_LINK_TYPES, counts.deletionsPerType)}); ` +
    `eligible: ${list(bench.DELETED_LINK_TYPES, counts.eligibleDeletions)}`,
);
out.push(`  sentences removed: ${removed}`);
out.push(
  `  files: ${Object.keys(after.json).length + 1} JSON, ${after.sources.length} under sources/` +
    (byteSources > 0 ? ` (${byteSources} PDF/DOCX or other copied unchanged and not checked)` : ''),
);
out.push('  checks: old names left 0, deleted sentences left 0, kept sentences missing 0; the folder reads back');
out.push(`  changes: ${shown(join(toPath, bench.CHANGES_FILE))}`);
if (renamed < counts.renamesAsked || deleted < counts.deletionsAsked) {
  out.push('  fewer changes than asked for: not enough records or links were eligible');
}
for (const line of out) console.log(line);
