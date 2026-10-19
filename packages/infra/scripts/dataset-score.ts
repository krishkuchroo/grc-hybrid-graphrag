// `pnpm dataset:score --org <slug> --folder <dir> [--base-url <url>]` (FT-001; D24, D38, D43, D54,
// D57, D60, D64, D81, D163, D164, D170, D230, D234, D235, D238 (b)): scores an org's ingestion
// against a dataset folder's keys: the links against `facts.json` (found, waiting, missed and extra,
// by type and origin), the duplicates against `duplicates.json` (merged, flagged, wrong merge,
// missed) and the stored values against `normalisation.json`
// (packages/benchmark/src/dataset/score.ts). Nothing here names a dataset: any folder in the format
// scores.
// - Refused before anything is made: unknown arguments, a folder that fails its check (each problem
//   names the file and the field), an org that is neither the folder's slug nor `<slug>-fast`, an org
//   that doesn't exist or has no Admin who holds Restricted, and a base URL that isn't `https://` (or
//   `http://` to 127.0.0.1 or localhost).
// - Reading: through the API only, with one Admin-role API key at Restricted (D230) made by the org's
//   Admin through ApiKeysService (so it is audited), expiring after 1 hour and revoked at the end,
//   also when the run fails or is stopped (Ctrl-C). It reads every record of every status with its
//   source IDs and fields, the links between active records, the link findings and the duplicate
//   findings. Nothing in the org changes.
// - Output (D164): the slug, the counts and ratios, the time taken and the report's path; never a
//   name, a sentence or a value. The full report, names and sentences and every item with its state,
//   goes to `data/benchmark/dataset-<slug>-<UTC time as yyyymmddThhmmssZ>.json`, a folder git keeps
//   out (D81). An error prints its type and code, or for an API refusal its address, status, code
//   and reference ID. The root script runs node with `--use-system-ca` (D60). Settings: see
//   org-script-env.ts (D170).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the benchmark's, the generators', the shared and the api's `./x.js`
// imports load their `.ts`.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;
type Common = typeof import('./dataset-common.js');
const common = (await import(new URL('./dataset-common.ts', import.meta.url).href)) as Common;
type AdminCtx = import('./dataset-common.js').AdminCtx;
type KeysApi = import('./dataset-common.js').KeysApi;

const REPORT_DIR = 'data/benchmark';
/** At most this many folder problems are printed. */
const MAX_PROBLEMS_SHOWN = 10;

function refuse(problems: readonly string[]): never {
  for (const p of problems) console.error(`dataset:score: ${p}`);
  console.error(bench.DATASET_SCORE_USAGE);
  process.exit(2);
}

const parsed = bench.parseDatasetScoreArgs(process.argv.slice(2));
if (!parsed.ok) refuse(parsed.problems);
const args = parsed.args;

// The whole folder, checked before anything is made.
let folder: Awaited<ReturnType<Benchmark['readDatasetFolder']>>;
try {
  folder = await bench.readDatasetFolder(resolve(process.cwd(), args.folder));
} catch (err) {
  if (err instanceof bench.DatasetFolderError) {
    const shown = err.problems
      .slice(0, MAX_PROBLEMS_SHOWN)
      .map((p) => `the folder is not valid: ${bench.datasetProblemLine(p)}`);
    const more = err.problems.length - shown.length;
    refuse(
      more > 0 ? [...shown, `… and ${more} more problem(s)`] : shown.length > 0 ? shown : ['the folder is not valid'],
    );
  }
  refuse([`the folder could not be read: ${describeError(err)}`]);
}
const orgProblem = bench.checkScoreOrg(folder.org.slug, args.org);
if (orgProblem !== null) refuse([orgProblem]);

const missing = missingSettings();
if (missing.length > 0) {
  console.error(`dataset:score: missing settings (environment or .env): ${missing.join(', ')}. Nothing was made.`);
  process.exit(2);
}

const sql = await sqlTag();
const { orgIdForSlug } = await load<{ orgIdForSlug(slug: string): string }>('identity/provision-org.ts');
const conn = await connect();
const stop = new AbortController();
let keys: InstanceType<Common['RunKeys']> | null = null;

let stopping = false;
function onSignal(signal: NodeJS.Signals): void {
  const code = signal === 'SIGINT' ? 130 : 143;
  if (!stopping) {
    stopping = true;
    console.error(`dataset:score: stopped (${signal}); ending the run and revoking its API key.`);
    process.exitCode = code;
    stop.abort();
    return;
  }
  // A second signal: revoke now and leave.
  console.error('dataset:score: stopping now; revoking the API key.');
  void (keys?.revokeAll() ?? Promise.resolve({ revoked: 0, failed: 0 }))
    .then(({ failed }) => {
      if (failed > 0) console.error("dataset:score: the run's API key could not be revoked; it expires within 1 hour.");
    })
    .finally(async () => {
      await conn.close();
      process.exit(code);
    });
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/** The full report, texts included, into the git-ignored folder (D81); its path, or null. */
function writeReport(fileName: string, text: string): string | null {
  const relative = `${REPORT_DIR}/${fileName}`;
  try {
    const dir = new URL(`../../../${REPORT_DIR}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(fileName, dir), text);
    return relative;
  } catch (err) {
    console.error(`dataset:score: the report ${relative} could not be written: ${describeError(err)}`);
    process.exitCode = 1;
    return null;
  }
}

try {
  const orgId = orgIdForSlug(args.org);
  const found = await common.findOrgAdmin(conn.deps.db, sql, orgId, args.org);
  if (!found.found) {
    console.error(
      `dataset:score: ${
        found.missing === 'org'
          ? `there is no org ${args.org}`
          : `the org ${args.org} has no Admin who holds Restricted to make the run's key`
      }. Nothing was made.`,
    );
    process.exitCode = 2;
  } else if (!stop.signal.aborted) {
    const { AuditService } = await load<{ AuditService: new (db: unknown) => object }>('audit/audit.service.ts');
    const { ApiKeysService } = await load<{ ApiKeysService: new (db: unknown, audit: object) => KeysApi }>(
      'identity/api-keys.service.ts',
    );
    keys = new common.RunKeys(new ApiKeysService(conn.deps.db, new AuditService(conn.deps.db)));
    const ctx: AdminCtx = { orgId, userId: found.adminId, role: 'admin', clearance: 'restricted' };
    const apiKey = await keys.make(ctx, `dataset:score ${args.org}`);
    const api = new bench.BenchApiClient({
      baseUrl: args.baseUrl,
      apiKey,
      signal: stop.signal,
      onRateLimited: (ms) =>
        console.log(`  rate limit (D64): waiting ${Math.ceil(ms / 1000)} s, then the same call again`),
    });

    const startedAt = new Date();
    console.log(
      `dataset:score: ${args.org} (${orgId}) against ${args.folder}: ${folder.facts.length} fact(s), ` +
        `${folder.duplicates.length} scanner row(s), ${folder.normalisation.length} normalised value(s), from ${args.baseUrl}`,
    );
    const snapshot = await bench.readOrgSnapshot(api, (line) => console.log(line));
    const duplicateFindings = await api.duplicateFindings();
    console.log(`  duplicate findings read: ${duplicateFindings.length}`);
    const score = bench.scoreDataset(folder, { ...snapshot, duplicateFindings });
    const endedAt = new Date();
    const reportPath = writeReport(
      bench.datasetReportFileName(args.org, endedAt),
      bench.formatDatasetReport(
        bench.datasetReport(score, args, folder, { slug: args.org, id: orgId }, { startedAt, endedAt }),
      ),
    );
    console.log('');
    for (const line of bench.datasetScoreOutput(score, {
      org: args.org,
      folder: args.folder,
      elapsedMs: endedAt.getTime() - startedAt.getTime(),
      reportPath,
    })) {
      console.log(line);
    }
  }
} catch (err) {
  // An API refusal's line names its address, status, code and reference ID; anything else only its
  // type and code (D164).
  const line = bench.benchErrorLine(err);
  console.error(`dataset:score: failed: ${line.startsWith('type=') ? describeError(err) : line}`);
  if (!stopping) process.exitCode = 1;
} finally {
  if (keys !== null) {
    const { revoked, failed } = await keys.revokeAll();
    if (keys.count > 0) {
      if (failed === 0 && revoked > 0) console.log("The run's API key is revoked.");
      else {
        console.error("dataset:score: the run's API key could not be revoked; it expires within 1 hour.");
        process.exitCode = 1;
      }
    }
  }
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  await conn.close();
}
