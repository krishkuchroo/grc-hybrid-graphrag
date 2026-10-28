// `pnpm dataset:load --folder <dir> --mode full|fast --step base|documents [--org <existing slug>]
// [--base-url <url>]` (FT-001; D18, D37, D42, D45.5, D45.7, D45.8, D47, D54, D57, D64, D81, D163,
// D164, D170, D230, D234, D235, D236, D237, D238 (b)): loads a dataset folder in `gen:data`'s
// answer-key format into an org, the two ways D235 names. Nothing here names a dataset: any folder
// in the format loads (packages/benchmark/src/dataset/folder.ts checks it whole first).
// - Orgs: `--mode full` loads into the manifest's slug and name; `--mode fast` into `<slug>-fast`,
//   named `<name> (fast load)`; each made with provisionOrg (safe to re-run: the slug names the org),
//   its Admin `admin@<slug>.example`. `--org <slug>` loads into that existing org instead, in either
//   mode and step, and never makes one.
// - `--step base`, full: provisionOrg, then a 1-hour Admin key at Restricted (D230), revoked however
//   the run ends; `runFullPipeline` with the folder's asset lists pushed with the folder's own column
//   mappings in `import-mappings.json`'s order; every risk, control, policy and incident of the answer
//   key through the record API (one whose exact name its kind already has is skipped; no links
//   between them: finding them is the documents' job, D237); then the framework mappings through
//   `POST /api/v1/mappings` (`link_exists` left alone).
// - `--step base`, fast: provisionOrg; `runFastLoad` on the answer key's records and links; the
//   framework mappings through MappingsService as the Admin (the control found by `answer-key:<key>`,
//   the requirement by framework and code, `link_exists` left alone); the outbox relayed into the
//   Postgres hash chain and the chain checked.
// - `--step documents` (only in its own later step): refused, with nothing sent, when the org doesn't
//   exist yet or the models don't answer (dataset-common.ts: bge-m3 on Ollama, and in full mode the
//   text model on the provider AI_TEXT_PROVIDER picks). Fast: `runFastLoad` with the documents (the
//   records already there write nothing), the relay and the chain check.
// - `--step documents`, full (FX-001, D263 item 1): no API key. Each document, in `documents.json`'s
//   order, goes in process through the api's UploadsService as the org's Admin person at Restricted
//   (the one the org check found; no API key ID, so the document's uploader type is `user`), with
//   the form the API upload sent before: its `documents.json` kind, no label (the API's default),
//   the file name and the bytes, the file type found from the name's extension and the content. The
//   service checks, stores and audits the file and queues its read job in the same transaction, as
//   `POST /api/v1/uploads` does. Why: chunk-resolve runs hours later in the uploader's view, and a
//   revoked or expired key sees nothing (D230's fail-safe rule, unchanged), so with the old 1-hour
//   key nothing a document named was matched. A person's view lasts as long as their membership.
//   `--base-url` isn't used by this step. A file the service refuses prints its row, status and
//   code; the run goes on with the next file and exits 1 at the end.
// - Refused with exit 2 before anything is made: unknown arguments, a folder that fails its check
//   (each problem names the file and the field), missing settings, an `--org` with no org or no
//   Admin who holds Restricted, and for the documents step the cases above.
// - Re-runs add nothing: the mappings come back unchanged, the batches and uploads `duplicate: true`,
//   records skipped by name, framework mappings `link_exists`, fast-loaded records `existing`.
// Output (D164): slugs, IDs, counts, times and the folder path. An error prints its type and code, or
// for an API refusal its address, status, code and reference ID. The root script runs node with
// `--use-system-ca`, so the Mac's trust in Caddy's local certificate applies (D60). Settings: see
// org-script-env.ts (D170).
import { resolve } from 'node:path';
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the generators', the benchmark's and the api's `./x.js` imports
// load their `.ts`.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, provisioning, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
type Generators = typeof import('../../generators/src/index.js');
const gen = (await import(new URL('../../generators/src/index.ts', import.meta.url).href)) as Generators;
type Benchmark = typeof import('../../benchmark/src/index.js');
const bench = (await import(new URL('../../benchmark/src/index.ts', import.meta.url).href)) as Benchmark;
type Common = typeof import('./dataset-common.js');
const common = (await import(new URL('./dataset-common.ts', import.meta.url).href)) as Common;
type AdminCtx = import('./dataset-common.js').AdminCtx;
type KeysApi = import('./dataset-common.js').KeysApi;

const MODES = ['full', 'fast'] as const;
type Mode = (typeof MODES)[number];
const STEPS = ['base', 'documents'] as const;
type Step = (typeof STEPS)[number];
const FLAGS = ['--folder', '--mode', '--step', '--org', '--base-url'] as const;
type Flag = (typeof FLAGS)[number];

const DEFAULT_BASE_URL = 'https://grc.localhost';
const ADMIN_NAME = 'Dataset Admin';
/** At most this many folder problems are printed. */
const MAX_PROBLEMS_SHOWN = 10;

const USAGE =
  'usage: pnpm dataset:load --folder <dataset folder> --mode full|fast --step base|documents ' +
  `[--org <existing org slug>] [--base-url <default ${DEFAULT_BASE_URL}>]`;

interface Args {
  folder: string;
  mode: Mode;
  step: Step;
  org: string | null;
  baseUrl: string;
}

function refuse(problems: readonly string[]): never {
  for (const p of problems) console.error(`dataset:load: ${p}`);
  console.error(USAGE);
  process.exit(2);
}

/** The base URL's problem (gen:data's rules), or null. */
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
    if (values[flag] !== undefined) problems.push(`${flag} is given twice`);
    if (eq > 0) values[flag] = arg.slice(eq + 1);
    else if (i + 1 < argv.length) values[flag] = argv[++i]!;
    else values[flag] = '';
  }

  const folder = (values['--folder'] ?? '').trim();
  if (values['--folder'] === undefined) problems.push('--folder is missing (the dataset folder)');
  else if (folder === '') problems.push('--folder must not be empty');

  const mode = values['--mode']?.trim();
  if (mode === undefined) problems.push('--mode is missing (full or fast)');
  else if (!(MODES as readonly string[]).includes(mode)) problems.push('--mode must be full or fast');

  const step = values['--step']?.trim();
  if (step === undefined) problems.push('--step is missing (base or documents)');
  else if (!(STEPS as readonly string[]).includes(step)) problems.push('--step must be base or documents');

  let org: string | null = null;
  if (values['--org'] !== undefined) {
    org = values['--org'].trim();
    if (!provisioning.SLUG.test(org) || org.length > 100) {
      problems.push('--org must be an org slug: lowercase letters and digits, joined by single hyphens');
    }
  }

  const baseUrl = (values['--base-url'] ?? DEFAULT_BASE_URL).trim();
  const urlProblem = checkBaseUrl(baseUrl);
  if (urlProblem) problems.push(urlProblem);

  if (problems.length > 0) refuse(problems);
  return { folder, mode: mode as Mode, step: step as Step, org, baseUrl };
}

const args = parse(process.argv.slice(2));
const started = performance.now();

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
const answerOrg = folder.answerOrg;

let sources: ReturnType<Generators['datasetSources']>;
try {
  sources = gen.datasetSources({ orgKey: answerOrg.key, assetLists: folder.assetLists, documents: folder.documents });
} catch (err) {
  const why = err instanceof gen.DatasetSourcesError ? `${err.code} (${err.where})` : describeError(err);
  refuse([`the folder's sources could not be made: ${why}`]);
}
/** The org's sources with only the asset lists (the base step) or only the documents. */
const baseSources = { orgs: [{ ...sources.org, documents: [] }] };
const documentSources = { orgs: [{ ...sources.org, assetLists: [] }] };

// The fast-load plan, checked before anything is written.
let fastPlan: ReturnType<Generators['planFastLoad']> | null = null;
if (args.mode === 'fast') {
  try {
    fastPlan = gen.planFastLoad(folder.key, args.step === 'base' ? baseSources : documentSources);
  } catch (err) {
    const why = err instanceof gen.FastLoadPlanError ? `${err.code} (${err.where})` : describeError(err);
    refuse([`the fast-load plan could not be made: ${why}`]);
  }
}

// The org: the given one, or the folder's (full) or its fast-load org (fast).
const targetSlug = args.org ?? (args.mode === 'full' ? folder.org.slug : bench.fastOrgSlugOf(folder.org.slug));
const targetName = args.mode === 'full' ? folder.org.name : `${folder.org.name} (fast load)`;
const makesOrg = args.org === null && args.step === 'base';

const missing = missingSettings();
if (missing.length > 0) {
  console.error(`dataset:load: missing settings (environment or .env): ${missing.join(', ')}. Nothing was made.`);
  process.exit(2);
}

// The documents step's AI settings; an error names the setting only.
let aiSettings: ReturnType<Common['datasetAiSettings']> | null = null;
if (args.step === 'documents') {
  try {
    aiSettings = common.datasetAiSettings(setting);
  } catch (err) {
    refuse([
      `the AI settings are not usable: ${err instanceof Error ? err.message : 'unknown setting'}. Nothing was sent.`,
    ]);
  }
}

/** A framework mapping row the fast-loaded org doesn't hold the ends of: its code and row, never a value. */
class DatasetMappingError extends Error {
  constructor(
    readonly code: 'unknown_control' | 'unknown_requirement',
    readonly where: string,
  ) {
    super(`framework mapping: ${code} (${where})`);
    this.name = 'DatasetMappingError';
  }
}

/** An error in one line: an API refusal's address, status, code and reference ID, a step's code and
 * place, else the error's type and code (D164). */
function errorLine(err: unknown): string {
  if (err instanceof gen.ApiRequestError) return err.message;
  if (err instanceof gen.DatasetLoadError || err instanceof DatasetMappingError) return `${err.code} (${err.where})`;
  return describeError(err);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const DUPLICATE_NOTE =
  'Duplicate checks start only once bge-m3 has embedded the record names, so they need Ollama running.';

const sql = await sqlTag();
const { orgIdForSlug } = await load<{ orgIdForSlug(slug: string): string }>('identity/provision-org.ts');
const conn = await connect();
const db: ScriptDb = conn.deps.db;

// ---- Full pipeline ---------------------------------------------------------------------------

/** Full pipeline, base step: through the real API with the run's key (see the top). */
async function runFull(target: { orgId: string; adminId: string }, apiKeys: KeysApi): Promise<void> {
  const keys = new common.RunKeys(apiKeys);
  function onSignal(signal: NodeJS.Signals): void {
    console.error(`dataset:load: stopped (${signal}); revoking this run's API key.`);
    void keys
      .revokeAll()
      .then(({ failed }) => {
        if (failed > 0)
          console.error("dataset:load: the run's API key could not be revoked; it expires within 1 hour.");
      })
      .finally(async () => {
        await conn.close();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const ctx: AdminCtx = { orgId: target.orgId, userId: target.adminId, role: 'admin', clearance: 'restricted' };
    const apiKey = await keys.make(ctx, `dataset:load ${targetSlug} ${args.step}`);
    const targets = [{ orgKey: answerOrg.key, baseUrl: args.baseUrl, apiKey }];

    console.log(
      `dataset:load: full pipeline, base step, ${targetSlug} (${target.orgId}) from ${args.folder}: ` +
        `${sources.org.assetLists.length} asset list(s), ${folder.frameworkMappings.length} framework mapping(s), into ${args.baseUrl}`,
    );
    let t = performance.now();
    const pushed = await gen.runFullPipeline({
      key: folder.key,
      sources: baseSources,
      targets,
      mappings: sources.mappings,
    });
    const o = pushed.totals;
    console.log(
      `  asset lists: mappings saved ${o.mappingsSaved}, unchanged ${o.mappingsUnchanged}; batches pushed ` +
        `${o.batchesPushed}, repeats ${o.batchesDuplicate} (${o.rows} rows) (${seconds(performance.now() - t)})`,
    );

    t = performance.now();
    const client = new gen.DatasetApiClient({ baseUrl: args.baseUrl, apiKey });
    const records = await gen.loadDatasetRecords(client, answerOrg, target.adminId, {
      onKindDone: (kind, counts) =>
        console.log(`  ${kind} records: added ${counts.created}, already there ${counts.skipped}`),
    });
    const added = gen.DATASET_RECORD_KINDS.reduce((n, k) => n + records.created[k], 0);
    const skipped = gen.DATASET_RECORD_KINDS.reduce((n, k) => n + records.skipped[k], 0);
    console.log(`  records: added ${added}, already there ${skipped} (${seconds(performance.now() - t)})`);

    t = performance.now();
    const mapped = await gen.loadDatasetMappings(client, answerOrg, folder.frameworkMappings);
    console.log(
      `  framework mappings: added ${mapped.added}, already there ${mapped.existing} (${seconds(performance.now() - t)})`,
    );
    console.log('The worker imports the pushed asset lists; Data intake shows their progress.');
    console.log(DUPLICATE_NOTE);
  } catch (err) {
    console.error(`dataset:load: failed: ${errorLine(err)}`);
    console.error('dataset:load: fix the cause and run the same command again; it finishes the missing steps.');
    process.exitCode = 1;
  } finally {
    const { revoked, failed } = await keys.revokeAll();
    if (keys.count > 0) console.log(`API keys revoked: ${revoked} of ${keys.count}.`);
    if (failed > 0) {
      console.error("dataset:load: the run's API key could not be revoked; it expires within 1 hour.");
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

type SourceFile = import('../../generators/src/index.js').SourceFile;

/** The upload form UploadsService takes (the api's `MultipartForm`, as the upload route reads it). */
interface UploadForm {
  fields: Record<string, string>;
  file: { fieldName: string; fileName: string; body: Buffer };
}

/** The slice of UploadsService the documents step uses. */
interface UploadsApi {
  upload(caller: AdminCtx, form: UploadForm): Promise<{ document: { id: string }; duplicate: boolean }>;
}

/** The api's ApiError, as far as this step reads it: its status and code (never its message). */
interface ApiErrorLike {
  code: string;
  getStatus(): number;
}

/**
 * The form the API path sent for a document (run-full.ts's `uploadDocument` input, as api-client.ts
 * wrote it into `POST /api/v1/uploads` and the route's `readMultipartForm` read it back): the field
 * `kind`, a `source` for an asset list only, no `label` (so the service's default), and the one file
 * in the field `file` with the document's file name and bytes. The route never kept the file part's
 * declared type: the service finds the file type from the name's extension and the content.
 */
function uploadFormOf(doc: SourceFile): UploadForm {
  return {
    fields: { kind: doc.kind, ...(doc.kind === 'asset_list' ? { source: doc.source } : {}) },
    file: { fieldName: 'file', fileName: doc.fileName, body: Buffer.from(gen.fileBytesOf(doc)) },
  };
}

/** An upload the service refused, as `<status> <code>` (the API's status and code for it; refused in
 * process, it has no reference ID), or null for any other error. */
function refusalOf(err: unknown, apiError: abstract new (...a: never[]) => ApiErrorLike): string | null {
  if (err instanceof apiError) return `${err.getStatus()} ${err.code}`;
  // The form's fields failing their schema: the API answers these 400 validation_failed (errors.ts).
  if (err instanceof Error && err.name === 'ZodError') return '400 validation_failed';
  return null;
}

/** Full pipeline, documents step: each document through UploadsService as the org's Admin person
 * (see the top; FX-001, D263 item 1). */
async function runFullDocuments(target: { orgId: string; adminId: string }): Promise<void> {
  const { AuditService } = await load<{ AuditService: new (db: unknown) => object }>('audit/audit.service.ts');
  const { UploadsService } = await load<{ UploadsService: new (d: object) => UploadsApi }>(
    'intake/uploads/uploads.service.ts',
  );
  const { ApiError } = await load<{ ApiError: abstract new (...a: never[]) => ApiErrorLike }>('common/errors.ts');
  // The api's job sender, send-only like the API program's, through the dev relay (D170).
  const { JobsService } = await load<{
    JobsService: new (o: { connectionString: string; processJobs: boolean }) => {
      start(): Promise<unknown>;
      onApplicationShutdown(): Promise<void>;
    };
  }>('jobs/jobs.module.ts');
  const { toHostAddress } = (await import(
    new URL('./host-address.ts', import.meta.url).href
  )) as typeof import('./host-address.js');

  const jobs = new JobsService({ connectionString: toHostAddress(setting('DATABASE_URL_APP')), processJobs: false });
  let jobsStarted = false;
  try {
    await jobs.start();
    jobsStarted = true;
    // Built as the API's intake module builds it: the same checks, store, audit entry and read job.
    const uploads = new UploadsService({
      db: conn.deps.db,
      audit: new AuditService(conn.deps.db),
      files: conn.deps.files,
      jobs,
    });
    // The Admin as a person: no API key ID, so the uploader is the user (store-upload.ts `actorOf`).
    const caller: AdminCtx = { orgId: target.orgId, userId: target.adminId, role: 'admin', clearance: 'restricted' };
    const documents = documentSources.orgs[0]!.documents;
    console.log(
      `dataset:load: full pipeline, documents step, ${targetSlug} (${target.orgId}) from ${args.folder}: ` +
        `${documents.length} document(s), uploaded in process`,
    );
    const t = performance.now();
    let uploaded = 0;
    let duplicate = 0;
    let refused = 0;
    for (const [i, doc] of documents.entries()) {
      let answer: Awaited<ReturnType<UploadsApi['upload']>>;
      try {
        answer = await uploads.upload(caller, uploadFormOf(doc));
      } catch (err) {
        const refusal = refusalOf(err, ApiError);
        if (refusal === null) throw err;
        console.error(`dataset:load: documents.json row ${i + 1}: the upload was refused: ${refusal}`);
        refused += 1;
        continue;
      }
      if (answer.duplicate) duplicate += 1;
      else uploaded += 1;
    }
    console.log(`  documents uploaded ${uploaded}, repeats ${duplicate} (${seconds(performance.now() - t)})`);
    console.log(
      `  uploaded as the org's Admin (user ${target.adminId}), so processing can match names after this run ends`,
    );
    if (refused > 0) {
      console.error(
        `dataset:load: ${refused} document(s) refused; fix them and run the same command again ` +
          '(the uploaded ones come back as repeats).',
      );
      process.exitCode = 1;
    }
    console.log('The worker reads, embeds and extracts the documents; Data intake and the review queue show them.');
  } catch (err) {
    console.error(`dataset:load: failed: ${errorLine(err)}`);
    console.error('dataset:load: fix the cause and run the same command again; it finishes the missing steps.');
    process.exitCode = 1;
  } finally {
    if (jobsStarted) await jobs.onApplicationShutdown().catch(() => undefined);
  }
}

// ---- Fast load -------------------------------------------------------------------------------

type FastLoad = typeof import('./fast-load.js');
type FastLoadDeps = Parameters<FastLoad['runFastLoad']>[0];

interface ReadTx {
  run(query: string, params?: Record<string, unknown>): Promise<{ records: { get(key: string): unknown }[] }>;
}
interface MappingsApi {
  create(caller: AdminCtx, input: { controlId: string; requirementId: string }): Promise<unknown>;
}

/** The framework mappings of the fast-loaded org, as its Admin through MappingsService (each with its
 * `link.created` entry): controls by `answer-key:<key>`, requirements by framework and code (active
 * ones only), a `link_exists` refusal left alone. */
async function fastMappings(
  graph: { read<T>(orgId: string, fn: (tx: ReadTx) => Promise<T>): Promise<T> },
  mappings: MappingsApi,
  caller: AdminCtx,
): Promise<{ added: number; existing: number }> {
  const rows = folder.frameworkMappings;
  if (rows.length === 0) return { added: 0, existing: 0 };
  const sourceIds = [...new Set(rows.map((r) => gen.fastLoadSourceId(r.controlKey)))];
  const wanted = rows.map((r) => ({ framework: r.framework, code: r.code }));
  const found = await graph.read(caller.orgId, async (tx) => {
    const c = await tx.run(
      `UNWIND $sourceIds AS sid
       MATCH (n:Control) WHERE sid IN n.sourceIds
       RETURN sid, n.id AS id ORDER BY n.status = 'active' DESC, n.number`,
      { sourceIds },
    );
    const q = await tx.run(
      `UNWIND $wanted AS w
       MATCH (n:Requirement {framework: w.framework, code: w.code}) WHERE n.status = 'active'
       RETURN w.framework + ' ' + w.code AS key, n.id AS id ORDER BY n.number`,
      { wanted },
    );
    const controls = new Map<string, string>();
    for (const r of c.records)
      if (!controls.has(r.get('sid') as string)) controls.set(r.get('sid') as string, r.get('id') as string);
    const requirements = new Map<string, string>();
    for (const r of q.records)
      if (!requirements.has(r.get('key') as string)) requirements.set(r.get('key') as string, r.get('id') as string);
    return { controls, requirements };
  });
  let added = 0;
  let existing = 0;
  for (const [i, row] of rows.entries()) {
    const where = `framework-mappings.json row ${i + 1} (${row.controlKey})`;
    const controlId = found.controls.get(gen.fastLoadSourceId(row.controlKey));
    if (!controlId) throw new DatasetMappingError('unknown_control', where);
    const requirementId = found.requirements.get(`${row.framework} ${row.code}`);
    if (!requirementId) throw new DatasetMappingError('unknown_requirement', where);
    try {
      await mappings.create(caller, { controlId, requirementId });
      added += 1;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'link_exists') throw err;
      existing += 1;
    }
  }
  return { added, existing };
}

/** Fast load: straight into the databases from the answer key, then the relay and the chain check. */
async function runFast(target: { orgId: string; adminId: string }): Promise<void> {
  const plan = fastPlan!;
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
  const { MappingsService } = await load<{ MappingsService: new (d: object) => MappingsApi }>(
    'frameworks/mappings.service.ts',
  );
  // The api's job sender, send-only like the API program's, through the dev relay (D170).
  const { JobsService } = await load<{
    JobsService: new (o: { connectionString: string; processJobs: boolean }) => FastLoadDeps['jobs'] & {
      start(): Promise<unknown>;
      onApplicationShutdown(): Promise<void>;
    };
  }>('jobs/jobs.module.ts');
  const { toHostAddress } = (await import(
    new URL('./host-address.ts', import.meta.url).href
  )) as typeof import('./host-address.js');

  const jobs = new JobsService({ connectionString: toHostAddress(setting('DATABASE_URL_APP')), processJobs: false });
  let jobsStarted = false;
  try {
    await jobs.start();
    jobsStarted = true;
    const outbox = new AuditOutbox(conn.deps.graph);
    const audit = new AuditService(conn.deps.db);
    const graph = conn.deps.graph as FastLoadDeps['graph'];
    const deps: FastLoadDeps = {
      db: conn.deps.db as unknown as FastLoadDeps['db'],
      graph,
      outbox,
      audit,
      files: conn.deps.files as FastLoadDeps['files'],
      jobs,
    };
    const counts = plan.orgs[0]!.counts;
    console.log(
      `dataset:load: fast load, ${args.step} step, ${targetSlug} (${target.orgId}) from ${args.folder}: ` +
        `${counts.records} records, ${counts.links} links, ${counts.documents} documents` +
        (args.step === 'base' ? `, ${folder.frameworkMappings.length} framework mapping(s)` : ''),
    );
    let t = performance.now();
    const result = await fl.runFastLoad(deps, plan, [
      { orgKey: answerOrg.key, orgId: target.orgId, ownerId: target.adminId },
    ]);
    const o = result.totals;
    console.log(
      `  records added ${o.recordsCreated}, already there ${o.recordsExisting}; links added ${o.linksCreated}; ` +
        `documents added ${o.documentsCreated}, already there ${o.documentsExisting}; read jobs queued ${o.readJobs}; ` +
        `audit entries ${o.entries} (${seconds(performance.now() - t)})`,
    );

    if (args.step === 'base') {
      t = performance.now();
      const caller: AdminCtx = { orgId: target.orgId, userId: target.adminId, role: 'admin', clearance: 'restricted' };
      const mapped = await fastMappings(
        conn.deps.graph as Parameters<typeof fastMappings>[0],
        new MappingsService({ graph: conn.deps.graph, outbox }),
        caller,
      );
      console.log(
        `  framework mappings: added ${mapped.added}, already there ${mapped.existing} (${seconds(performance.now() - t)})`,
      );
    }

    // The run's entries into the org's Postgres hash chain now (the worker would within seconds),
    // then the chain checked.
    const relayed = await fl.relayOutbox({ graph, audit }, [target.orgId]);
    if (relayed.left > 0) {
      console.error(
        `dataset:load: ${relayed.left} audit entr${relayed.left === 1 ? 'y is' : 'ies are'} still waiting in the outbox; ` +
          'the worker copies them, and a re-run checks again.',
      );
      process.exitCode = 1;
    }
    const check = await audit.verifyChain(target.orgId);
    if (!check.ok) {
      console.error(`dataset:load: the audit chain of ${targetSlug} breaks at entry ${check.brokenAtSeq}.`);
      process.exitCode = 1;
    } else {
      console.log(`Audit trail: entries copied to Postgres; hash chain verified for ${targetSlug}.`);
    }
    if (args.step === 'base') console.log(DUPLICATE_NOTE);
    else {
      console.log(
        o.readJobs > 0
          ? `The worker reads the ${o.readJobs} new document(s) into chunks and embeds them (embed only, no text model).`
          : 'No new documents, so no read jobs were queued.',
      );
    }
  } catch (err) {
    const why = err instanceof fl.FastLoadError ? `${err.code} (${err.where})` : errorLine(err);
    console.error(`dataset:load: failed: ${why}`);
    console.error('dataset:load: fix the cause and run the same command again; it finishes the missing steps.');
    process.exitCode = 1;
  } finally {
    if (jobsStarted) await jobs.onApplicationShutdown().catch(() => undefined);
  }
}

// ---- The run ---------------------------------------------------------------------------------

/** Refuses with exit 2: the problem is printed, nothing was made or sent. */
function refused(lines: readonly string[]): void {
  for (const line of lines) console.error(`dataset:load: ${line}`);
  process.exitCode = 2;
}

/** The org, the documents step's model check, then the load (see the top of the file). */
async function main(): Promise<void> {
  const orgId = orgIdForSlug(targetSlug);
  if (makesOrg) {
    const { AuditOutbox } = await load<{ AuditOutbox: new (graph: unknown) => object }>('audit/outbox.ts');
    const { readCatalogFiles } = await load<{ readCatalogFiles(): unknown }>('frameworks/catalog-files.ts');
    await provisioning.provisionOrg(
      { name: targetName, slug: targetSlug, admin: { email: `admin@${targetSlug}.example`, name: ADMIN_NAME } },
      { ...conn.deps, outbox: new AuditOutbox(conn.deps.graph), catalogs: readCatalogFiles() },
    );
  }
  // The org, which must exist already for `--org` and the documents step, and its Admin at Restricted.
  const found = await common.findOrgAdmin(db, sql, orgId, targetSlug);
  if (!found.found) {
    if (found.missing === 'admin') {
      refused([`the org ${targetSlug} has no Admin who holds Restricted to load it. Nothing was loaded.`]);
    } else {
      refused([
        args.org !== null
          ? `there is no org ${targetSlug}. Nothing was made.`
          : `there is no org ${targetSlug} yet: run --step base first. Nothing was made.`,
      ]);
    }
    return;
  }

  if (args.step === 'documents') {
    const problems = await common.checkDatasetModels(aiSettings!, args.mode);
    if (problems.length > 0) {
      refused([...problems.map((p) => `${p}.`), 'the documents step needs these models answering. Nothing was sent.']);
      return;
    }
  }

  const target = { orgId, adminId: found.adminId };
  if (args.mode === 'fast') {
    await runFast(target);
  } else if (args.step === 'documents') {
    await runFullDocuments(target);
  } else {
    const { AuditService } = await load<{ AuditService: new (db: unknown) => object }>('audit/audit.service.ts');
    const { ApiKeysService } = await load<{ ApiKeysService: new (db: unknown, audit: object) => KeysApi }>(
      'identity/api-keys.service.ts',
    );
    await runFull(target, new ApiKeysService(conn.deps.db, new AuditService(conn.deps.db)));
  }
  console.log(`Folder: ${args.folder}`);
  console.log(`Time: ${seconds(performance.now() - started)}.`);
}

try {
  await main();
} catch (err) {
  console.error(`dataset:load: failed: ${errorLine(err)}`);
  console.error('dataset:load: fix the cause and run the same command again; it finishes the missing steps.');
  process.exitCode = 1;
} finally {
  await conn.close();
}
