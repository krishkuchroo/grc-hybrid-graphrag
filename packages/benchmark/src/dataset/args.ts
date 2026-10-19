// The arguments of `pnpm dataset:score` (FT-001; D60, D235):
//   --org <slug> --folder <dir> [--base-url URL]
// The base URL defaults to `https://grc.localhost` and follows bench:run's rules: `https://`, or
// `http://` to 127.0.0.1 or localhost only, with no user name, password, query or fragment.
// Refused: unknown arguments, a flag given twice, a missing or bad org slug, a missing folder and a
// bad base URL. Which orgs a folder may score (its slug and `<slug>-fast`) is `checkScoreOrg`'s.
// Pure: the problems name the flag and the rule, never a value from a file.
import { benchmarkOrgSlugSchema } from '@grc/shared';
import { DEFAULT_BENCH_BASE_URL, checkBenchBaseUrl, cleanBenchBaseUrl } from '../run/args.js';
import { fastOrgSlugOf } from './folder.js';

export const DATASET_SCORE_USAGE =
  'usage: pnpm dataset:score --org <org slug> --folder <dataset folder> ' +
  `[--base-url <default ${DEFAULT_BENCH_BASE_URL}>]`;

export interface DatasetScoreArgs {
  org: string;
  /** The folder's path, as given. */
  folder: string;
  /** The platform's address, without a trailing slash. */
  baseUrl: string;
}

export type DatasetScoreArgsResult = { ok: true; args: DatasetScoreArgs } | { ok: false; problems: string[] };

const FLAGS = ['--org', '--folder', '--base-url'] as const;
type Flag = (typeof FLAGS)[number];

/** Parses the command's arguments (without node's own). */
export function parseDatasetScoreArgs(argv: readonly string[]): DatasetScoreArgsResult {
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

  const org = (values['--org'] ?? '').trim();
  if (values['--org'] === undefined) problems.push('--org is missing (the org slug, for example company-x-fast)');
  else if (!benchmarkOrgSlugSchema.safeParse(org).success) {
    problems.push('--org must be an org slug: lowercase letters and digits, joined by single hyphens');
  }

  const folder = (values['--folder'] ?? '').trim();
  if (values['--folder'] === undefined) problems.push('--folder is missing (the dataset folder)');
  else if (folder === '') problems.push('--folder must not be empty');

  const baseUrlText = (values['--base-url'] ?? DEFAULT_BENCH_BASE_URL).trim();
  const urlProblem = checkBenchBaseUrl(baseUrlText);
  if (urlProblem) problems.push(urlProblem);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, args: { org, folder, baseUrl: cleanBenchBaseUrl(baseUrlText) } };
}

/** The problem with scoring this org against a folder of this slug, or null: only the folder's own
 * org (`<slug>`, loaded through the intake) and its fast-load org (`<slug>-fast`) are scored. */
export function checkScoreOrg(folderSlug: string, org: string): string | null {
  if (org === folderSlug || org === fastOrgSlugOf(folderSlug)) return null;
  return `the folder's orgs are ${folderSlug} and ${fastOrgSlugOf(folderSlug)}, not ${org}`;
}
