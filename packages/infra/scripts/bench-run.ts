// `pnpm bench:run --org <slug> --set <file> [--part retrieval|answers|all] [--modes hybrid,vector]
// [--limit N] [--wait [minutes]] [--base-url URL]` (S8-005; D1, D42, D45.8, D46, D47, D48, D54, D57,
// D60, D64, D81, D163, D164, D170, D230): runs a question set against an org through the real API in
// hybrid and vector mode, scores every answer by fixed rules and stores the run, so "hybrid beats
// plain vector search" is measured, not asserted.
// - Refused before anything is made: unknown arguments, a set `loadQuestionSet` refuses (the field
//   that's wrong is named), a set that doesn't name the org's slug, an org that doesn't exist, an
//   org with no Admin who holds Restricted, and a base URL that isn't `https://` (or `http://` to
//   127.0.0.1 or localhost).
// - The key: one Admin-role API key at clearance Restricted for the org (D230), made by the org's
//   Admin, who holds Restricted, through ApiKeysService (so it is audited), expiring after 12 hours
//   at most. The command reaches the org with this key only, through `--base-url`, and revokes it
//   at the end, also when the run fails or is stopped (Ctrl-C).
// - The run (packages/benchmark/src/run/): `--wait` first, then the expected records found through
//   the record lists, then every question searched and (with `--part answers` or `all`) answered in
//   each mode, scored and stored in batches as one run, finished or failed. A 429 waits for its
//   `retry-after` and the same call is sent again; five failures in a row or the API unreachable end
//   the run `failed`, revoke the key and exit 1.
// - Output: per mode and per question kind, side by side, the counts and scores; the 95th-percentile
//   times against D48 with PASS or FAIL; the graph fallbacks by reason; the run ID and its page on
//   the Benchmark screen. Scores, counts, times and IDs only: never a question, an answer, a name or
//   the key (D57, D164). The whole run, texts included, goes to `data/benchmark/<run ID>.json`, a
//   folder git keeps out (D81).
// The root script runs node with `--use-system-ca`, so the Mac's trust in Caddy's local
// certificate applies (D60). An error prints its type and code, or, for an API refusal, the address,
// status, code and reference ID. Settings: see org-script-env.ts (D170). Every run is a new run;
// nothing in the command is random.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the benchmark's, the shared and the api's `./x.js` imports load
// their `.ts`.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;
type Shared = typeof import('../../shared/src/index.js');
const shared = (await import(new URL('../../shared/src/index.ts', import.meta.url).href)) as Shared;

/** The run's API key lives at most this long (D54); it is revoked at the end anyway. */
const KEY_LIFETIME_MS = 12 * 60 * 60 * 1000;
const REPORT_DIR = 'data/benchmark';

function refuse(problems: readonly string[]): never {
  for (const p of problems) console.error(`bench:run: ${p}`);
  console.error(bench.BENCH_RUN_USAGE);
  process.exit(2);
}

const parsed = bench.parseBenchRunArgs(process.argv.slice(2));
if (!parsed.ok) refuse(parsed.problems);
const args = parsed.args;

// The question set, checked; its problems name fields only (D164).
let set: Awaited<ReturnType<Benchmark['loadQuestionSet']>>;
try {
  set = await bench.loadQuestionSet(resolve(process.cwd(), args.set));
} catch (err) {
  if (err instanceof bench.QuestionSetFileError) {
    if (err.code !== 'invalid') refuse([err.message]);
    const shown = err.problems.slice(0, 10).map((p) => `the question set is not valid: ${p.field}: ${p.message}`);
    const more = err.problems.length - shown.length;
    refuse(more > 0 ? [...shown, `… and ${more} more problem(s)`] : shown);
  }
  refuse([`the question set could not be read: ${describeError(err)}`]);
}
if (!shared.questionSetFitsOrg(set.source, args.org)) {
  refuse([`the question set is not for ${args.org}: it names ${set.source.orgSlugs.join(', ')}`]);
}

const missing = missingSettings();
if (missing.length > 0) {
  console.error(`bench:run: missing settings (environment or .env): ${missing.join(', ')}. Nothing was made.`);
  process.exit(2);
}

// The slices of the api's services the command uses (loaded from packages/api/src at run time).
interface OrgCtx {
  orgId: string;
  userId: string;
  role: 'admin';
  clearance: 'restricted';
}
interface KeysApi {
  create(ctx: OrgCtx, body: unknown): Promise<{ id: string; key: string }>;
  revoke(ctx: OrgCtx, id: string): Promise<void>;
}

const sql = await sqlTag();
const { orgIdForSlug } = await load<{ orgIdForSlug(slug: string): string }>('identity/provision-org.ts');

type OrgCheck = { found: true; adminId: string } | { found: false; problem: string };

/** The org of the slug (its ID comes from the slug, so nothing is read across the org wall) and
 * its first Admin who holds Restricted, whom the run's API key is made by. */
async function checkOrg(db: ScriptDb, orgId: string, slug: string): Promise<OrgCheck> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    const org = await tx.execute(sql`SELECT slug FROM "organization" WHERE id = ${orgId}::uuid`);
    if (org.rows[0]?.['slug'] !== slug) return { found: false, problem: `there is no org ${slug}` };
    const admin = await tx.execute(
      sql`SELECT user_id FROM "member" WHERE org_id = ${orgId}::uuid AND role = 'admin' AND clearance = 'restricted'
          ORDER BY created_at, id LIMIT 1`,
    );
    const userId = admin.rows[0]?.['user_id'];
    if (typeof userId !== 'string') {
      return { found: false, problem: `the org ${slug} has no Admin who holds Restricted to make the run's key` };
    }
    return { found: true, adminId: userId };
  });
}

const conn = await connect();
const stop = new AbortController();
let key: { id: string; ctx: OrgCtx } | null = null;
let apiKeys: KeysApi | null = null;
let revoking: Promise<boolean> | null = null;

/** Revokes the run's key, once, however the command ends; false when it couldn't be. */
function revokeKey(): Promise<boolean> {
  revoking ??= (async () => {
    if (key === null || apiKeys === null) return true;
    try {
      await apiKeys.revoke(key.ctx, key.id);
      return true;
    } catch {
      return false;
    }
  })();
  return revoking;
}

let stopping = false;
function onSignal(signal: NodeJS.Signals): void {
  const code = signal === 'SIGINT' ? 130 : 143;
  if (!stopping) {
    stopping = true;
    console.error(`bench:run: stopped (${signal}); ending the run and revoking its API key.`);
    process.exitCode = code;
    stop.abort();
    return;
  }
  // A second signal: revoke now and leave.
  console.error('bench:run: stopping now; revoking the API key.');
  void revokeKey()
    .then((ok) => {
      if (!ok) console.error("bench:run: the run's API key could not be revoked; it expires within 12 hours.");
    })
    .finally(async () => {
      await conn.close();
      process.exit(code);
    });
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
  const orgId = orgIdForSlug(args.org);
  const org = await checkOrg(conn.deps.db, orgId, args.org);
  if (!org.found) {
    console.error(`bench:run: ${org.problem}. Nothing was made.`);
    process.exitCode = 2;
  } else if (!stop.signal.aborted) {
    const { AuditService } = await load<{ AuditService: new (db: unknown) => object }>('audit/audit.service.ts');
    const { ApiKeysService } = await load<{ ApiKeysService: new (db: unknown, audit: object) => KeysApi }>(
      'identity/api-keys.service.ts',
    );
    apiKeys = new ApiKeysService(conn.deps.db, new AuditService(conn.deps.db));
    const ctx: OrgCtx = { orgId, userId: org.adminId, role: 'admin', clearance: 'restricted' };
    const made = await apiKeys.create(ctx, {
      name: `bench:run ${args.org}`,
      role: 'admin',
      clearance: 'restricted',
      expiresAt: new Date(Date.now() + KEY_LIFETIME_MS).toISOString(),
    });
    key = { id: made.id, ctx };

    const source = set.source;
    const sourceText =
      source.type === 'generated'
        ? `generated (generator version ${source.generatorVersion}, seed ${source.seed}, size ${source.size}, ${source.orgKey})`
        : 'hand-written';
    const runCount = args.limit === null ? set.questions.length : Math.min(args.limit, set.questions.length);
    console.log(
      `bench:run: ${args.org} (${orgId}), question set ${sourceText}, ${runCount} of ${set.questions.length} question(s), ` +
        `parts ${args.parts.join(', ')}, modes ${args.modes.join(', ')}, into ${args.baseUrl}`,
    );

    const api = new bench.BenchApiClient({
      baseUrl: args.baseUrl,
      apiKey: made.key,
      signal: stop.signal,
      onRateLimited: (ms) =>
        console.log(`  rate limit (D64): waiting ${Math.ceil(ms / 1000)} s, then the same call again`),
    });
    const result = await bench.runBenchmark({
      api,
      set,
      parts: args.parts,
      modes: args.modes,
      limit: args.limit,
      waitMinutes: args.waitMinutes,
      signal: stop.signal,
      sleep: (ms) => bench.abortableSleep(ms, stop.signal),
      log: (line) => console.log(line),
    });

    // The whole run, texts included, into the git-ignored folder (D81).
    let reportPath: string | null = null;
    if (result.runId !== null) {
      const relative = `${REPORT_DIR}/${result.runId}.json`;
      try {
        const dir = new URL(`../../../${REPORT_DIR}/`, import.meta.url);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          new URL(`${result.runId}.json`, dir),
          bench.formatBenchReport(bench.benchReport(result, args, set, { slug: args.org, id: orgId })),
        );
        reportPath = relative;
      } catch (err) {
        console.error(`bench:run: the report ${relative} could not be written: ${describeError(err)}`);
        process.exitCode = 1;
      }
    }

    console.log('');
    for (const line of bench.benchRunOutput(result, {
      org: args.org,
      parts: args.parts,
      modes: args.modes,
      baseUrl: args.baseUrl,
      reportPath,
    })) {
      console.log(line);
    }
    if (result.end !== 'finished' && !stopping) process.exitCode = 1;
  }
} catch (err) {
  // An API refusal's line names its address, status, code and reference ID; anything else (a
  // database error making the key) only its type and code (D164).
  const line = bench.benchErrorLine(err);
  console.error(`bench:run: failed: ${line.startsWith('type=') ? describeError(err) : line}`);
  if (!stopping) process.exitCode = 1;
} finally {
  const revoked = await revokeKey();
  if (key !== null) {
    if (revoked) console.log("The run's API key is revoked.");
    else {
      console.error("bench:run: the run's API key could not be revoked; it expires within 12 hours.");
      process.exitCode = 1;
    }
  }
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  await conn.close();
}
