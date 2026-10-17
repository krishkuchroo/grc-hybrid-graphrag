// The arguments of `pnpm bench:run` (S8-005; D1, D46, D60):
//   --org <slug> --set <file> [--part retrieval|answers|all] [--modes hybrid,vector] [--limit N]
//   [--wait [minutes]] [--base-url URL]
// Defaults: part `retrieval`, both modes in S6's order, every question, no wait (`--wait` alone
// waits up to 240 minutes), base URL `https://grc.localhost`. Refused: unknown arguments, a flag
// given twice, a missing or bad org slug or set path, an unknown part or mode, a mode given twice,
// a limit or wait that isn't a whole number in range, and a base URL that isn't `https://` (or
// `http://` to 127.0.0.1 or localhost), holds a user name or password, or has a query or fragment.
// Pure: the problems name the flag and the rule, never a value from a file.
import {
  BENCHMARK_QUESTION_PARTS,
  SEARCH_MODES,
  benchmarkOrgSlugSchema,
  isSearchMode,
  type BenchmarkQuestionPart,
  type SearchMode,
} from '@grc/shared';

export const BENCH_RUN_PARTS = ['retrieval', 'answers', 'all'] as const;
export type BenchRunPartOption = (typeof BENCH_RUN_PARTS)[number];

export const DEFAULT_BENCH_BASE_URL = 'https://grc.localhost';
export const DEFAULT_BENCH_PART: BenchRunPartOption = 'retrieval';
/** How long `--wait` alone waits for the org's documents. */
export const DEFAULT_WAIT_MINUTES = 240;
/** The longest wait: the run's API key lives 12 hours at most, so at least 4 are left for the run. */
export const MAX_WAIT_MINUTES = 480;

export const BENCH_RUN_USAGE =
  'usage: pnpm bench:run --org <org slug> --set <question set file> [--part retrieval|answers|all] ' +
  '[--modes hybrid,vector] [--limit <whole number>] ' +
  `[--wait [minutes, default ${DEFAULT_WAIT_MINUTES}, at most ${MAX_WAIT_MINUTES}]] [--base-url <default ${DEFAULT_BENCH_BASE_URL}>]`;

export interface BenchRunArgs {
  org: string;
  /** The question set's path, as given. */
  set: string;
  part: BenchRunPartOption;
  /** The question parts the part option asks for, in the fixed order. */
  parts: BenchmarkQuestionPart[];
  /** The modes, in the order given, each once. */
  modes: SearchMode[];
  /** Only the first N questions of the set; null for all of them. */
  limit: number | null;
  /** Minutes to wait for the org's documents first; null for no wait. */
  waitMinutes: number | null;
  /** The platform's address, without a trailing slash. */
  baseUrl: string;
}

export type BenchRunArgsResult = { ok: true; args: BenchRunArgs } | { ok: false; problems: string[] };

const FLAGS = ['--org', '--set', '--part', '--modes', '--limit', '--wait', '--base-url'] as const;
type Flag = (typeof FLAGS)[number];

const WHOLE = /^\d+$/;

function wholeNumber(text: string): number | null {
  const n = Number(text);
  return WHOLE.test(text) && Number.isSafeInteger(n) ? n : null;
}

const LOCAL_HTTP_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/** The base URL's problem, or null when it may be used. */
export function checkBenchBaseUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '--base-url must be a URL such as https://grc.localhost';
  }
  if (url.protocol === 'http:') {
    if (!LOCAL_HTTP_HOSTS.includes(url.hostname)) return '--base-url may use http:// only to 127.0.0.1 or localhost';
  } else if (url.protocol !== 'https:') {
    return '--base-url must start with https:// (or http:// to 127.0.0.1 or localhost)';
  }
  if (url.username !== '' || url.password !== '') return '--base-url must not hold a user name or password';
  if (url.search !== '' || url.hash !== '') return '--base-url must not have a query or a fragment';
  return null;
}

/** The base URL as the client uses it: its origin and path, without trailing slashes. */
export function cleanBenchBaseUrl(text: string): string {
  const url = new URL(text);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function partsOf(part: BenchRunPartOption): BenchmarkQuestionPart[] {
  return part === 'all' ? [...BENCHMARK_QUESTION_PARTS] : [part];
}

/** Parses the command's arguments (without node's own). */
export function parseBenchRunArgs(argv: readonly string[]): BenchRunArgsResult {
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
    if (eq > 0) {
      values[flag] = arg.slice(eq + 1);
    } else if (flag === '--wait') {
      // The minutes are optional: only a whole number right after it is taken as them.
      const next = argv[i + 1];
      values[flag] = next !== undefined && WHOLE.test(next.trim()) ? argv[++i]!.trim() : String(DEFAULT_WAIT_MINUTES);
    } else if (i + 1 < argv.length) {
      values[flag] = argv[++i]!;
    } else {
      values[flag] = '';
    }
  }

  const org = (values['--org'] ?? '').trim();
  if (values['--org'] === undefined) problems.push('--org is missing (the org slug, for example fast-1-tiny-1)');
  else if (!benchmarkOrgSlugSchema.safeParse(org).success) {
    problems.push('--org must be an org slug: lowercase letters and digits, joined by single hyphens');
  }

  const set = (values['--set'] ?? '').trim();
  if (values['--set'] === undefined) problems.push('--set is missing (the question set file)');
  else if (set === '') problems.push('--set must not be empty');

  const partText = (values['--part'] ?? DEFAULT_BENCH_PART).trim();
  const part = (BENCH_RUN_PARTS as readonly string[]).includes(partText) ? (partText as BenchRunPartOption) : null;
  if (part === null) problems.push('--part must be retrieval, answers or all');

  const modes: SearchMode[] = [];
  if (values['--modes'] === undefined) {
    modes.push(...SEARCH_MODES);
  } else {
    const names = values['--modes'].split(',').map((m) => m.trim());
    if (names.length === 0 || names.some((m) => m === '')) {
      problems.push(`--modes must list ${SEARCH_MODES.join(' and/or ')}, separated by commas`);
    } else {
      for (const name of names) {
        if (!isSearchMode(name)) {
          problems.push(`--modes: each mode must be ${SEARCH_MODES.join(' or ')}`);
          break;
        }
        if (modes.includes(name)) {
          problems.push('--modes: each mode only once');
          break;
        }
        modes.push(name);
      }
    }
  }

  let limit: number | null = null;
  if (values['--limit'] !== undefined) {
    limit = wholeNumber(values['--limit'].trim());
    if (limit === null || limit < 1) problems.push('--limit must be a whole number from 1');
  }

  let waitMinutes: number | null = null;
  if (values['--wait'] !== undefined) {
    waitMinutes = wholeNumber(values['--wait'].trim());
    if (waitMinutes === null || waitMinutes < 1 || waitMinutes > MAX_WAIT_MINUTES) {
      problems.push(`--wait must be a whole number of minutes from 1 to ${MAX_WAIT_MINUTES}`);
    }
  }

  const baseUrlText = (values['--base-url'] ?? DEFAULT_BENCH_BASE_URL).trim();
  const urlProblem = checkBenchBaseUrl(baseUrlText);
  if (urlProblem) problems.push(urlProblem);

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    args: {
      org,
      set,
      part: part!,
      parts: partsOf(part!),
      modes,
      limit,
      waitMinutes,
      baseUrl: cleanBenchBaseUrl(baseUrlText),
    },
  };
}
