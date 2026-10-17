// `pnpm bench:questions --data data/generated/<seed>-<size> [--per-kind N] [--seed N]` (S8-003; D18,
// D42, D45.8, D52.6, D81, D163, D164): one question set with known right answers for every org of a
// generated answer key, for the benchmark (`pnpm bench:run`).
// - Reads `answer-key.json` in the folder `pnpm gen:data` wrote, checks it (`parseAnswerKey`), and
//   writes `questions-<org key>.json` beside it for every org (`buildQuestionSets`): single-hop,
//   multi-hop, no-answer and injection-trap questions with their expected records, each set naming
//   the two org slugs it fits (`gen-<seed>-<n>` and `fast-<seed>-<size>-<n>`). The folder stays
//   out of git (D81).
// - `--per-kind`: up to this many questions of each kind (default 10, at most 50). `--seed`: the
//   seed the questions are chosen by (default the answer key's own). The same answer key and
//   options always write the same files, byte for byte (D45.8).
// - Refuses unknown arguments, a missing folder and an answer key that isn't valid.
// The output holds only paths and counts: never a question, a name or other text from the data
// (D164). An error names the field, the code or the error type only.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, join, resolve } from 'node:path';

// The benchmark's, the generators' and the shared sources import each other as `./x.js`, which are
// `./x.ts` files: plain `node` loads them with this hook (as org-script-env.ts does for its scripts).
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
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;

const FLAGS = ['--data', '--per-kind', '--seed'] as const;
type Flag = (typeof FLAGS)[number];

const ANSWER_KEY_FILE = 'answer-key.json';
/** `pnpm gen:data`'s answer keys are well under this; a bigger file is refused unread. */
const MAX_ANSWER_KEY_BYTES = 512 * 1024 * 1024;

const USAGE =
  'usage: pnpm bench:questions --data data/generated/<seed>-<size> ' +
  `[--per-kind <1 to ${bench.MAX_PER_KIND}, default ${bench.DEFAULT_PER_KIND}>] ` +
  "[--seed <whole number, default the answer key's seed>]";

interface Args {
  data: string;
  perKind: number;
  seed: number | undefined;
}

function refuse(problems: string[]): never {
  for (const p of problems) console.error(`bench:questions: ${p}`);
  console.error(USAGE);
  process.exit(2);
}

function wholeNumber(text: string): number | null {
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) ? n : null;
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
    else if (i + 1 < argv.length) values[flag] = argv[++i]!;
    else values[flag] = '';
  }

  const data = (values['--data'] ?? '').trim();
  if (values['--data'] === undefined) problems.push('--data is missing (the folder pnpm gen:data wrote)');
  else if (data === '') problems.push('--data must not be empty');

  const perKindText = (values['--per-kind'] ?? String(bench.DEFAULT_PER_KIND)).trim();
  const perKind = wholeNumber(perKindText);
  if (perKind === null || perKind < 1 || perKind > bench.MAX_PER_KIND) {
    problems.push(`--per-kind must be a whole number from 1 to ${bench.MAX_PER_KIND}`);
  }

  let seed: number | undefined;
  if (values['--seed'] !== undefined) {
    const n = wholeNumber(values['--seed'].trim());
    if (n === null) problems.push('--seed must be a whole number from 0');
    else seed = n;
  }

  if (problems.length > 0) refuse(problems);
  return { data, perKind: perKind!, seed };
}

/** An error in one line: its type and code only (D163, D164). */
function describeError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'type=unknown';
  const e = err as { name?: unknown; code?: unknown };
  const type = typeof e.name === 'string' ? e.name : 'unknown';
  return typeof e.code === 'string' ? `type=${type} code=${e.code}` : `type=${type}`;
}

const args = parse(process.argv.slice(2));
const folder = resolve(process.cwd(), args.data);

if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  refuse([`--data: no folder ${JSON.stringify(args.data)} (run pnpm gen:data first)`]);
}
const keyPath = join(folder, ANSWER_KEY_FILE);
if (!existsSync(keyPath) || !statSync(keyPath).isFile()) {
  refuse([`--data: the folder has no ${ANSWER_KEY_FILE} (run pnpm gen:data first)`]);
}
if (statSync(keyPath).size > MAX_ANSWER_KEY_BYTES) {
  refuse([`${ANSWER_KEY_FILE} is over ${MAX_ANSWER_KEY_BYTES} bytes`]);
}

// The answer key, checked; its problems name fields and IDs only.
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(keyPath, 'utf8'));
} catch (err) {
  // JSON's own message quotes the text around the mistake, so it is not printed.
  refuse([
    err instanceof SyntaxError
      ? `${ANSWER_KEY_FILE} is not valid JSON`
      : `${ANSWER_KEY_FILE} could not be read: ${describeError(err)}`,
  ]);
}
let key: ReturnType<Benchmark['parseAnswerKey']>;
try {
  key = bench.parseAnswerKey(raw);
} catch (err) {
  if (err instanceof bench.AnswerKeyError) {
    const shown = err.problems.slice(0, 10).map((p) => `${ANSWER_KEY_FILE} is not valid: ${p.field}: ${p.message}`);
    const more = err.problems.length - shown.length;
    refuse(more > 0 ? [...shown, `… and ${more} more problem(s)`] : shown);
  }
  refuse([`${ANSWER_KEY_FILE} could not be checked: ${describeError(err)}`]);
}

// The size as gen:data named the folder (`<seed>-<size>`), for the fast-loaded orgs' slugs; a
// folder named some other way gets the size's own name, with a note.
const name = basename(folder);
const dash = name.indexOf('-');
const folderSize = dash > 0 && name.slice(0, dash) === String(key.seed) ? name.slice(dash + 1) : '';
let size: string;
if (folderSize !== '' && bench.sizeFolderDescribes(folderSize, key.size)) {
  size = folderSize;
} else {
  size = bench.sizeFolderOf(key.size);
  console.log(
    `bench:questions: the folder name is not <seed>-<size> for this answer key; the fast-load slugs use the size ${size}`,
  );
}

let sets: ReturnType<Benchmark['buildQuestionSets']>;
try {
  sets = bench.buildQuestionSets(key, { perKind: args.perKind, seed: args.seed, size });
} catch (err) {
  if (err instanceof bench.QuestionSetBuildError) refuse([`${err.code}: ${err.message}`]);
  refuse([`the question sets could not be built: ${describeError(err)}`]);
}

const lines: string[] = [];
for (const set of sets) {
  if (set.source.type !== 'generated') continue;
  const fileName = `questions-${set.source.orgKey}.json`;
  try {
    writeFileSync(join(folder, fileName), bench.formatQuestionSet(set));
  } catch (err) {
    console.error(`bench:questions: ${join(args.data, fileName)} could not be written: ${describeError(err)}`);
    process.exit(1);
  }
  const counts = bench.countByKind(set);
  const perKind = bench.GENERATED_QUESTION_KINDS.map((kind) => `${kind} ${counts[kind]}`).join(', ');
  lines.push(`  ${join(args.data, fileName)}: ${perKind} (${set.questions.length} questions)`);
}
console.log(`bench:questions: ${lines.length} question set(s) written`);
for (const line of lines) console.log(line);
