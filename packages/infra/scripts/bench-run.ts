// `pnpm bench:run --org <slug> --set <file> [--part retrieval|answers|all|extraction]
// [--modes hybrid,vector] [--limit N] [--wait [minutes]] [--base-url URL]` (S8-005, S8-006; D1, D24,
// D38, D42, D45.8, D46, D47, D48, D52.6, D54, D57, D60, D64, D81, D163, D164, D170, D230): runs a
// question set against an org through the real API in hybrid and vector mode, scores every answer
// by fixed rules and stores the run, so "hybrid beats plain vector search" is measured, not
// asserted. `--part extraction`, alone, instead measures a full-pipeline org's extraction against
// the answer key (packages/benchmark/src/extraction/): the org's records, links and link findings,
// read through the API, scored as stated facts, extra AI links, planted false positives, add-link
// injections and Analyst decisions, and stored as one run whose summary holds the seven ratios.
// - Refused before anything is made: unknown arguments, a set `loadQuestionSet` refuses (the field
//   that's wrong is named), a set that doesn't name the org's slug, an org that doesn't exist, an
//   org with no Admin who holds Restricted, and a base URL that isn't `https://` (or `http://` to
//   127.0.0.1 or localhost). With `--part extraction` also: a hand-written set, an org that isn't the
//   set's full-pipeline org (`gen-…`; a fast-loaded org went through no extraction), and an
//   `answer-key.json` beside the set that is missing, not valid, or from another generator version,
//   seed, size or org than the set.
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
//   the Benchmark screen. For extraction: what was read, the stated facts per state, the items per
//   kind, and the seven ratios with their numerators and denominators. Scores, counts, times and IDs
//   only: never a question, an answer, a name or the key (D57, D164). The whole run, texts
//   included, goes to `data/benchmark/<run ID>.json`, a folder git keeps out (D81).
// - The checks file (EV-002; D261 track A, items 1–3 and item 4's failure rule): when
//   `<set without .json>.checks.json` sits beside the set, it is checked against the set (the same
//   question IDs in the same order; a bad or misfitting file exits 2 naming the field, nothing made)
//   and, after the run and while its key is live, the run is scored against it (`evaluateRun`): the
//   breakdown by fine kind and by wording, consistency across the wordings of one fact, execution
//   accuracy (each hybrid answer's own graph query against the correct one, run read-only as the
//   run key's role x clearance query account after `checkGraphQuery`, never the admin or writer
//   account; not measured without NEO4J_QUERY_SECRET) and stale answers. Counts and scores go on
//   screen under "Evaluation (checks file)"; the detail goes into the report's `evaluation` block.
//   Nothing of it goes to the API. With `--part extraction` a checks file is ignored (one line says
//   so). An evaluation that throws prints its type and code and exits 1; the run stays stored and
//   the key is still revoked.
// The root script runs node with `--use-system-ca`, so the Mac's trust in Caddy's local
// certificate applies (D60). An error prints its type and code, or, for an API refusal, the address,
// status, code and reference ID. Settings: see org-script-env.ts (D170). Every run is a new run;
// nothing in the command is random.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the benchmark's, the shared and the api's `./x.js` imports load
// their `.ts`.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;
type Shared = typeof import('../../shared/src/index.js');
const shared = (await import(new URL('../../shared/src/index.ts', import.meta.url).href)) as Shared;
// Ask's graph rules, loaded only when a checks file needs them (the evaluation's runner).
type QueryCheckModule = typeof import('../../api/src/search/graph/query-check.js');
type GraphSearchModule = typeof import('../../api/src/search/graph/graph-search.service.js');
type GraphResultsModule = typeof import('../../api/src/search/graph/graph-results.js');
type GraphReader = import('../../api/src/search/graph/graph-search.service.js').GraphReader;

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

// The extraction part: a generated set on its own full-pipeline org, and the answer key beside it,
// rendered again into what the org's documents state and plant.
type Expected = ReturnType<Benchmark['expectedOrg']>;
type GeneratedSource = Extract<typeof set.source, { type: 'generated' }>;
let extraction: { source: GeneratedSource; expected: Expected } | null = null;
if (args.part === 'extraction') {
  const check = bench.checkExtractionSet(set.source, args.org);
  if (!check.ok) refuse([check.problem]);
  let key: Awaited<ReturnType<Benchmark['loadAnswerKeyBeside']>>;
  try {
    key = await bench.loadAnswerKeyBeside(resolve(process.cwd(), args.set));
  } catch (err) {
    if (err instanceof bench.AnswerKeyFileError) {
      if (err.code !== 'invalid') refuse([err.message]);
      const shown = err.problems
        .slice(0, 10)
        .map((p) => `${bench.ANSWER_KEY_FILE} is not valid: ${p.field}: ${p.message}`);
      const more = err.problems.length - shown.length;
      refuse(more > 0 ? [...shown, `… and ${more} more problem(s)`] : shown);
    }
    refuse([`${bench.ANSWER_KEY_FILE} could not be read: ${describeError(err)}`]);
  }
  const keyProblems = bench.answerKeyProblems(key, check.source, args.org);
  if (keyProblems.length > 0) refuse(keyProblems);
  try {
    extraction = { source: check.source, expected: bench.expectedOrg(key, check.source.orgKey) };
  } catch (err) {
    refuse([`the answer key's sources could not be rendered again: ${describeError(err)}`]);
  }
}

// The checks file beside the set (EV-002): checked against the set before anything is made; its
// problems name fields only (D164).
type EvalChecks = ReturnType<Benchmark['parseEvalChecks']>;
const setPath = resolve(process.cwd(), args.set);
async function loadChecks(): Promise<EvalChecks | null> {
  if (args.part === 'extraction') {
    if (existsSync(bench.checksPathFor(setPath))) {
      console.log('bench:run: the checks file beside the set is ignored with --part extraction');
    }
    return null;
  }
  try {
    return await bench.loadChecksBeside(setPath, set);
  } catch (err) {
    if (err instanceof bench.ChecksFileError) {
      const shown = err.problems.slice(0, 10).map((p) => `the checks file is not valid: ${p.field}: ${p.message}`);
      const more = err.problems.length - shown.length;
      refuse(more > 0 ? [...shown, `… and ${more} more problem(s)`] : shown);
    }
    refuse([`the checks file could not be read: ${describeError(err)}`]);
  }
}
const checks = await loadChecks();

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

/**
 * The evaluation's graph runner (EV-002 behaviour 2(d); D73, D131, D176): each query checked with
 * Ask's `checkGraphQuery` (a refused one is never sent), then run with Ask's `runGraphQuery` and
 * limits (5 s, 50 rows) through `GraphService.readAs`, as the read-only query account of the run
 * key's own role and clearance (Admin at Restricted), and read with `readGraphRows` for the Admin
 * who made the key. Never the admin or writer account. One query at a time (the evaluation awaits
 * each). Without NEO4J_QUERY_SECRET there is no query account: not measured.
 */
async function evalGraph(orgId: string, viewerId: string): Promise<Parameters<Benchmark['evaluateRun']>[0]['graph']> {
  if (setting('NEO4J_QUERY_SECRET') === '') return { notMeasured: bench.EXECUTION_NO_SECRET };
  const { checkGraphQuery } = await load<QueryCheckModule>('search/graph/query-check.ts');
  const { GRAPH_QUERY_LIMITS, runGraphQuery } = await load<GraphSearchModule>('search/graph/graph-search.service.ts');
  const { readGraphRows } = await load<GraphResultsModule>('search/graph/graph-results.ts');
  const reader = conn.deps.graph as GraphReader;
  const role = 'admin' as const;
  const clearance = 'restricted' as const;
  return {
    runner: async (query) => {
      const check = checkGraphQuery(query);
      if (!check.ok) return { ok: false, reason: 'refused', code: check.reason };
      // readAs: the role x clearance query account only (GraphService.readAs, M0-005).
      const ran = await runGraphQuery(reader, { orgId, role, clearance }, query, GRAPH_QUERY_LIMITS);
      if (!ran.ok) {
        return { ok: false, reason: ran.fallback === 'graph_query_refused' ? 'refused' : 'failed', code: ran.code };
      }
      const read = readGraphRows(ran.rows, { userId: viewerId, role, clearance });
      return {
        ok: true,
        records: read.records.map((r) => ({ id: r.id, kind: r.kind })),
        values: read.values.map((row) => Object.values(row) as unknown[]),
      };
    },
  };
}
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

    const api = new bench.BenchApiClient({
      baseUrl: args.baseUrl,
      apiKey: made.key,
      signal: stop.signal,
      onRateLimited: (ms) =>
        console.log(`  rate limit (D64): waiting ${Math.ceil(ms / 1000)} s, then the same call again`),
    });

    /** The whole run, texts included, into the git-ignored folder (D81); its path, or null. */
    const writeReport = (runId: string | null, text: () => string): string | null => {
      if (runId === null) return null;
      const relative = `${REPORT_DIR}/${runId}.json`;
      try {
        const dir = new URL(`../../../${REPORT_DIR}/`, import.meta.url);
        mkdirSync(dir, { recursive: true });
        writeFileSync(new URL(`${runId}.json`, dir), text());
        return relative;
      } catch (err) {
        console.error(`bench:run: the report ${relative} could not be written: ${describeError(err)}`);
        process.exitCode = 1;
        return null;
      }
    };

    let end: 'finished' | 'failed' | 'not_started';
    let lines: string[];
    /** The evaluation's error line (type and code, or the API refusal's line); null when none. */
    let evaluationError: string | null = null;
    if (extraction !== null) {
      const { expected, source: generated } = extraction;
      console.log(
        `bench:run: ${args.org} (${orgId}), extraction against the answer key of ${sourceText}: ` +
          `${expected.statedFacts.length} stated fact(s), ${expected.falsePositives.length} planted false positive(s), ` +
          `${expected.injections.length} add-link injection(s), into ${args.baseUrl}`,
      );
      const result = await bench.runExtraction({
        api,
        set,
        expected,
        waitMinutes: args.waitMinutes,
        signal: stop.signal,
        sleep: (ms) => bench.abortableSleep(ms, stop.signal),
        log: (line) => console.log(line),
      });
      const reportPath = writeReport(result.runId, () =>
        bench.formatExtractionReport(
          bench.extractionReport(result, args, set, generated, expected, { slug: args.org, id: orgId }),
        ),
      );
      end = result.end;
      lines = bench.extractionRunOutput(result, { org: args.org, baseUrl: args.baseUrl, reportPath });
    } else {
      const runCount = args.limit === null ? set.questions.length : Math.min(args.limit, set.questions.length);
      console.log(
        `bench:run: ${args.org} (${orgId}), question set ${sourceText}, ${runCount} of ${set.questions.length} question(s), ` +
          `parts ${args.parts.join(', ')}, modes ${args.modes.join(', ')}, into ${args.baseUrl}`,
      );
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
      // The run scored against the checks file, while the key is live (EV-002).
      type EvalReport = Awaited<ReturnType<Benchmark['evaluateRun']>>;
      let evaluation: EvalReport | null = null;
      let evaluationLines: string[] = [];
      if (checks !== null && result.runId !== null) {
        if (stopping || stop.signal.aborted) {
          evaluationLines = ['Evaluation (checks file): not run (the run was stopped)'];
        } else {
          try {
            const records = await bench.readOrgRecords(api, bench.evalTargetKinds(checks));
            evaluation = await bench.evaluateRun({
              checks,
              checksPath: bench.checksPathFor(args.set),
              questions: result.questions,
              items: result.items,
              records,
              graph: await evalGraph(orgId, org.adminId),
              log: (line) => console.log(line),
            });
            evaluationLines = bench.evalRunOutput(evaluation);
          } catch (err) {
            const line = bench.benchErrorLine(err);
            evaluationError = line.startsWith('type=') ? describeError(err) : line;
          }
        }
      }
      const reportPath = writeReport(result.runId, () =>
        bench.formatBenchReport(bench.benchReport(result, args, set, { slug: args.org, id: orgId }, evaluation)),
      );
      end = result.end;
      lines = bench.benchRunOutput(result, {
        org: args.org,
        parts: args.parts,
        modes: args.modes,
        baseUrl: args.baseUrl,
        reportPath,
      });
      if (evaluationLines.length > 0) lines.push('', ...evaluationLines);
    }

    console.log('');
    for (const line of lines) console.log(line);
    if (end !== 'finished' && !stopping) process.exitCode = 1;
    if (evaluationError !== null) {
      console.error(`bench:run: the evaluation (checks file) failed: ${evaluationError}`);
      if (!stopping) process.exitCode = 1;
    }
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
