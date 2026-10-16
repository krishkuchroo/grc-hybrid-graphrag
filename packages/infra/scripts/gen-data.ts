// `pnpm gen:data --mode full|fast [--size …] [--seed …] [--base-url …]` (S3-018; D11, D18, D42, D45.5,
// D45.8, D54, D57, D60, D81, D133, D163, D164, D170): the synthetic data generators as dummy
// connectors.
// - Builds the answer key (`buildWorld`) and its sources (`renderSources`) from the seed and size,
//   and writes them to `data/generated/<seed>-<size>/answer-key.json` and `plants.json`, a folder
//   git keeps out (D81). The same seed and size always write the same files (D45.8).
// - `--mode full`: provisions one org per answer-key org, slugs `gen-<seed>-<n>`, with
//   provisionOrg like `pnpm seed:demo` (safe to re-run: the slug names the org), makes one
//   Admin-role API key per org at clearance Restricted (D230, so every label the generated world
//   holds loads) that expires in 1 hour (through ApiKeysService, so it is audited, made by the
//   org's Admin, who holds Restricted), and runs `runFullPipeline` against `--base-url`: the
//   sources go through the real API as a customer's connector would send them. The keys are
//   revoked when the run ends, also when it fails or is stopped (Ctrl-C). A re-run adds nothing:
//   the mappings are unchanged, the batches and files come back `duplicate: true`.
// - `--mode fast` (S3-019; D42, D48, D213 (7)): provisions one org per answer-key org the same way,
//   slugs `fast-<seed>-<size>-<n>` (so a fast load never lands in a full-pipeline org or in another
//   size's org), and writes the answer key's records, links and documents straight into Neo4j,
//   Postgres and the org's bucket (`runFastLoad`, fast-load.ts): batches of at most 500, each in one
//   transaction with one `generator.loaded` audit entry listing every ID it created. No API key, no
//   API and no processing job. Then it copies the run's outbox entries into the Postgres audit trail
//   with the worker's own relay, checks each org's hash chain, and prints the time it took and the
//   process's peak memory. A re-run adds nothing and writes no entries.
// Defaults: `--size tiny`, `--seed 1`, `--base-url https://grc.localhost`. The root script runs
// node with `--use-system-ca`, so the Mac's trust in Caddy's local certificate applies (D60).
// The output holds only org slugs, counts, times and the answer key's path: never a key, a name or
// text from the data (D57, D164). An error prints its type and code only, or, for an API refusal, the
// address, status, code and reference ID. Settings: see org-script-env.ts (D170).
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the generators' and the api's `./x.js` imports load their `.ts`.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, provisioning, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
type Generators = typeof import('../../generators/src/index.js');
const gen = (await import(new URL('../../generators/src/index.ts', import.meta.url).href)) as Generators;

const MODES = ['full', 'fast'] as const;
type Mode = (typeof MODES)[number];
const FLAGS = ['--mode', '--size', '--seed', '--base-url'] as const;
type Flag = (typeof FLAGS)[number];

const DEFAULT_SIZE = 'tiny';
const DEFAULT_SEED = '1';
const DEFAULT_BASE_URL = 'https://grc.localhost';
/** Each run's API keys live at most this long (D54); they are revoked at the end anyway. */
const KEY_LIFETIME_MS = 60 * 60 * 1000;

const USAGE =
  'usage: pnpm gen:data --mode full|fast [--size tiny|accuracy|stress|custom:orgs=…,assets=…,risks=…,controls=…,policies=…,incidents=…] ' +
  `[--seed <whole number, default ${DEFAULT_SEED}>] [--base-url <default ${DEFAULT_BASE_URL}>]`;

interface Args {
  mode: Mode;
  size: string;
  seed: number;
  baseUrl: string;
}

function refuse(problems: string[]): never {
  for (const p of problems) console.error(`gen:data: ${p}`);
  console.error(USAGE);
  process.exit(2);
}

function checkBaseUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '--base-url must be a URL such as https://grc.localhost';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '--base-url must start with https:// or http://';
  if (url.username !== '' || url.password !== '') return '--base-url must not hold a user name or password';
  if (url.search !== '' || url.hash !== '') return '--base-url must not have a query or a fragment';
  return null;
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

  const mode = values['--mode'];
  if (mode === undefined) problems.push('--mode is missing (full or fast)');
  else if (!(MODES as readonly string[]).includes(mode)) problems.push('--mode must be full or fast');

  const size = (values['--size'] ?? DEFAULT_SIZE).trim();
  if (size === '') problems.push('--size must not be empty');

  const seedText = (values['--seed'] ?? DEFAULT_SEED).trim();
  const seed = Number(seedText);
  if (!/^\d+$/.test(seedText) || !Number.isSafeInteger(seed)) problems.push('--seed must be a whole number from 0');

  const baseUrl = (values['--base-url'] ?? DEFAULT_BASE_URL).trim();
  const urlProblem = checkBaseUrl(baseUrl);
  if (urlProblem) problems.push(urlProblem);

  if (problems.length > 0) refuse(problems);
  return { mode: mode as Mode, size, seed, baseUrl };
}

/** The folder name part for a size: the name itself, or the custom size with only letters, digits and `-`. */
function sizeFolder(size: string): string {
  return size
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const args = parse(process.argv.slice(2));
const started = performance.now();

// The answer key and its sources: pure, from the seed and size only (D45.8).
let size: ReturnType<Generators['parseSize']>;
try {
  size = gen.parseSize(args.size);
} catch (err) {
  refuse([`--size: ${err instanceof Error ? err.message : 'not a size'}`]);
}
let key: ReturnType<Generators['buildWorld']>;
let sources: ReturnType<Generators['renderSources']>;
try {
  key = gen.buildWorld({ seed: args.seed, size });
  sources = gen.renderSources(key);
} catch (err) {
  refuse([`the data for this size could not be built: ${describeError(err)}`]);
}

const missing = missingSettings();
if (missing.length > 0) {
  console.error(`gen:data: missing settings (environment or .env): ${missing.join(', ')}. Nothing was created.`);
  process.exit(2);
}

// The answer key and the plants, into the git-ignored folder (D81).
const folder = `${args.seed}-${sizeFolder(args.size)}`;
const relativeDir = `data/generated/${folder}`;
const outDir = new URL(`../../../${relativeDir}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('answer-key.json', outDir), `${JSON.stringify(key, null, 2)}\n`);
writeFileSync(new URL('plants.json', outDir), `${JSON.stringify(sources.plants, null, 2)}\n`);

// The slices of the api's services the run uses (loaded from packages/api/src at run time).
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
interface Services {
  outbox: object;
  catalogs: unknown;
  apiKeys: KeysApi;
}

async function services(deps: { db: ScriptDb; graph: unknown }): Promise<Services> {
  const { AuditOutbox } = await load<{ AuditOutbox: new (graph: unknown) => object }>('audit/outbox.ts');
  const { AuditService } = await load<{ AuditService: new (db: unknown) => object }>('audit/audit.service.ts');
  const { ApiKeysService } = await load<{ ApiKeysService: new (db: unknown, audit: object) => KeysApi }>(
    'identity/api-keys.service.ts',
  );
  const { readCatalogFiles } = await load<{ readCatalogFiles(): unknown }>('frameworks/catalog-files.ts');
  return {
    outbox: new AuditOutbox(deps.graph),
    catalogs: readCatalogFiles(),
    apiKeys: new ApiKeysService(deps.db, new AuditService(deps.db)),
  };
}

const sql = await sqlTag();

/** The org's first Admin (provisionOrg makes one), whom the run's API key is made by. */
async function adminOf(db: ScriptDb, orgId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    const found = await tx.execute(
      sql`SELECT user_id FROM "member" WHERE org_id = ${orgId}::uuid AND role = 'admin'
          ORDER BY created_at, id LIMIT 1`,
    );
    const userId = found.rows[0]?.['user_id'];
    if (typeof userId !== 'string') throw new Error('gen:data: the org has no Admin');
    return userId;
  });
}

/** One line of counts for an org (D164: its slug and counts only). */
function orgLine(slug: string, o: Awaited<ReturnType<Generators['runFullPipeline']>>['orgs'][number]): string {
  return (
    `  ${slug}: mappings saved ${o.mappings.saved}, unchanged ${o.mappings.unchanged}; ` +
    `batches pushed ${o.batches.pushed}, repeats ${o.batches.duplicate} (${o.batches.rows} rows); ` +
    `documents uploaded ${o.documents.uploaded}, repeats ${o.documents.duplicate}`
  );
}

/** An error in one line: an API refusal's address, status, code and reference ID, else type and code. */
function errorLine(err: unknown): string {
  if (err instanceof gen.ApiRequestError) return err.message;
  return describeError(err);
}

/** Full pipeline: through the real API with one short-lived Admin key per org (S3-018). */
async function runFull(): Promise<void> {
  const conn = await connect();
  const keys: { id: string; ctx: OrgCtx }[] = [];
  let apiKeys: KeysApi | null = null;
  let revoking: Promise<{ revoked: number; failed: number }> | null = null;

  /** Revokes every key this run made, once, however the run ends. */
  function revokeKeys(): Promise<{ revoked: number; failed: number }> {
    revoking ??= (async () => {
      let revoked = 0;
      let failed = 0;
      for (const k of keys) {
        try {
          await apiKeys!.revoke(k.ctx, k.id);
          revoked += 1;
        } catch {
          failed += 1;
        }
      }
      return { revoked, failed };
    })();
    return revoking;
  }

  function onSignal(signal: NodeJS.Signals): void {
    console.error(`gen:data: stopped (${signal}); revoking this run's API keys.`);
    void revokeKeys()
      .then(({ failed }) => {
        if (failed > 0)
          console.error(`gen:data: ${failed} API key(s) could not be revoked; they expire within 1 hour.`);
      })
      .finally(async () => {
        await conn.close();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const svc = await services(conn.deps);
    apiKeys = svc.apiKeys;
    const slugOf = new Map<string, string>();
    const targets: { orgKey: string; baseUrl: string; apiKey: string }[] = [];

    for (const [i, org] of key.orgs.entries()) {
      const slug = `gen-${args.seed}-${i + 1}`;
      slugOf.set(org.key, slug);
      const { orgId } = await provisioning.provisionOrg(
        { name: org.name, slug, admin: { email: `admin@${slug}.example`, name: 'Generator Admin' } },
        { ...conn.deps, outbox: svc.outbox, catalogs: svc.catalogs },
      );
      const ctx: OrgCtx = { orgId, userId: await adminOf(conn.deps.db, orgId), role: 'admin', clearance: 'restricted' };
      const made = await svc.apiKeys.create(ctx, {
        name: `gen:data ${folder}`,
        role: 'admin',
        clearance: 'restricted',
        expiresAt: new Date(Date.now() + KEY_LIFETIME_MS).toISOString(),
      });
      keys.push({ id: made.id, ctx });
      targets.push({ orgKey: org.key, baseUrl: args.baseUrl, apiKey: made.key });
    }

    console.log(
      `gen:data: full pipeline, size ${args.size}, seed ${args.seed}, generator version ${key.generatorVersion}, ` +
        `${targets.length} org(s), into ${args.baseUrl}`,
    );
    const result = await gen.runFullPipeline({
      key,
      sources,
      targets,
      onOrgDone: (o) => console.log(orgLine(slugOf.get(o.orgKey) ?? o.orgKey, o)),
    });
    const t = result.totals;
    console.log(
      `  total: mappings saved ${t.mappingsSaved}, unchanged ${t.mappingsUnchanged}; batches pushed ${t.batchesPushed}, ` +
        `repeats ${t.batchesDuplicate} (${t.rows} rows); documents uploaded ${t.documentsUploaded}, repeats ${t.documentsDuplicate}`,
    );
    console.log(`Answer key: ${relativeDir}/answer-key.json`);
    console.log(`Plants: ${relativeDir}/plants.json`);
    console.log(
      'The worker imports the pushed asset lists and processes the documents; Data intake shows their progress.',
    );
  } catch (err) {
    console.error(`gen:data: failed: ${errorLine(err)}`);
    console.error('gen:data: fix the cause and run the same command again; it finishes the missing steps.');
    process.exitCode = 1;
  } finally {
    const { revoked, failed } = await revokeKeys();
    if (keys.length > 0) console.log(`API keys revoked: ${revoked} of ${keys.length}.`);
    if (failed > 0) {
      console.error(`gen:data: ${failed} API key(s) could not be revoked; they expire within 1 hour.`);
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await conn.close();
  }
}

type FastLoad = typeof import('./fast-load.js');
type FastLoadDeps = Parameters<FastLoad['runFastLoad']>[0];

/** One line of counts for a fast-loaded org (D164: its slug, counts and time only). */
function fastOrgLine(
  slug: string,
  o: Awaited<ReturnType<FastLoad['runFastLoad']>>['orgs'][number],
  ms: number,
): string {
  return (
    `  ${slug}: records added ${o.records.created}, already there ${o.records.existing}; links added ${o.links.created}; ` +
    `documents added ${o.documents.created}, already there ${o.documents.existing}; ` +
    `audit entries ${o.entries} (${(ms / 1000).toFixed(1)} s)`
  );
}

/** Fast load: straight into the databases from the answer key, one org at a time (S3-019). */
async function runFast(): Promise<void> {
  let plan: ReturnType<Generators['planFastLoad']>;
  try {
    plan = gen.planFastLoad(key, sources);
  } catch (err) {
    const why = err instanceof gen.FastLoadPlanError ? `${err.code} (${err.where})` : describeError(err);
    refuse([`the fast-load plan could not be made: ${why}`]);
  }
  const fl = (await import(new URL('./fast-load.ts', import.meta.url).href)) as FastLoad;
  const { AuditOutbox } = await load<{ AuditOutbox: new (graph: unknown) => FastLoadDeps['outbox'] }>(
    'audit/outbox.ts',
  );
  const { AuditService } = await load<{
    AuditService: new (db: unknown) => FastLoadDeps['audit'] & {
      append: Parameters<FastLoad['relayOutbox']>[0]['audit']['append'];
      verifyChain(orgId: string): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }>;
    };
  }>('audit/audit.service.ts');
  const { readCatalogFiles } = await load<{ readCatalogFiles(): unknown }>('frameworks/catalog-files.ts');

  const conn = await connect();
  try {
    const outbox = new AuditOutbox(conn.deps.graph);
    const audit = new AuditService(conn.deps.db);
    const catalogs = readCatalogFiles();
    const graph = conn.deps.graph as FastLoadDeps['graph'];
    const deps: FastLoadDeps = {
      db: conn.deps.db as unknown as FastLoadDeps['db'],
      graph,
      outbox,
      audit,
      files: conn.deps.files as FastLoadDeps['files'],
    };

    const slugOf = new Map<string, string>();
    const targets: { orgKey: string; orgId: string; ownerId: string }[] = [];
    for (const [i, org] of key.orgs.entries()) {
      const slug = `fast-${args.seed}-${sizeFolder(args.size)}-${i + 1}`;
      slugOf.set(org.key, slug);
      const { orgId } = await provisioning.provisionOrg(
        { name: org.name, slug, admin: { email: `admin@${slug}.example`, name: 'Generator Admin' } },
        { ...conn.deps, outbox, catalogs },
      );
      targets.push({ orgKey: org.key, orgId, ownerId: await adminOf(conn.deps.db, orgId) });
    }

    const planned = plan.orgs.reduce(
      (n, o) => ({
        records: n.records + o.counts.records,
        links: n.links + o.counts.links,
        documents: n.documents + o.counts.documents,
      }),
      { records: 0, links: 0, documents: 0 },
    );
    console.log(
      `gen:data: fast load, size ${args.size}, seed ${args.seed}, generator version ${key.generatorVersion}, ` +
        `${targets.length} org(s): ${planned.records} records, ${planned.links} links and ${planned.documents} documents ` +
        `in batches of at most ${plan.batchSize}`,
    );
    const loadStarted = performance.now();
    let orgStarted = loadStarted;
    const result = await fl.runFastLoad(deps, plan, targets, {
      onOrgDone: (o) => {
        const now = performance.now();
        console.log(fastOrgLine(slugOf.get(o.orgKey) ?? o.orgKey, o, now - orgStarted));
        orgStarted = now;
      },
    });
    const t = result.totals;
    const loadMs = performance.now() - loadStarted;
    console.log(
      `  total: records added ${t.recordsCreated}, already there ${t.recordsExisting}; links added ${t.linksCreated}; ` +
        `documents added ${t.documentsCreated}, already there ${t.documentsExisting}; audit entries ${t.entries}`,
    );

    // The run's entries into each org's Postgres hash chain now (the worker would within seconds),
    // then every org's chain checked.
    const orgIds = targets.map((tg) => tg.orgId);
    const relayed = await fl.relayOutbox({ graph, audit }, orgIds);
    if (relayed.left > 0) {
      console.error(
        `gen:data: ${relayed.left} audit entr${relayed.left === 1 ? 'y is' : 'ies are'} still waiting in the outbox; ` +
          'the worker copies them, and a re-run checks again.',
      );
      process.exitCode = 1;
    }
    let broken = 0;
    for (const tg of targets) {
      const check = await audit.verifyChain(tg.orgId);
      if (!check.ok) {
        broken += 1;
        console.error(`gen:data: the audit chain of ${slugOf.get(tg.orgKey)} breaks at entry ${check.brokenAtSeq}.`);
      }
    }
    if (broken > 0) process.exitCode = 1;
    else console.log(`Audit trail: entries copied to Postgres; hash chains verified for ${targets.length} org(s).`);

    console.log(`Answer key: ${relativeDir}/answer-key.json`);
    console.log(`Plants: ${relativeDir}/plants.json`);
    const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
    console.log(
      `Time: load ${(loadMs / 1000).toFixed(1)} s, whole run ${((performance.now() - started) / 1000).toFixed(1)} s; ` +
        `peak memory ${peakMb} MB (one process).`,
    );
    console.log('No processing jobs were queued: chunking and embedding of these documents come with S4.');
  } catch (err) {
    const why = err instanceof fl.FastLoadError ? `${err.code} (${err.where})` : describeError(err);
    console.error(`gen:data: failed: ${why}`);
    console.error('gen:data: fix the cause and run the same command again; it finishes the missing steps.');
    process.exitCode = 1;
  } finally {
    await conn.close();
  }
}

if (args.mode === 'fast') await runFast();
else await runFull();
