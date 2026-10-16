// `pnpm seed:demo` (M0-014, D114): the checkpoint demo. Two orgs, each made by provisionOrg, with
// one user per role (7) at mixed clearances, the Admin at `restricted`. It prints a login list.
// - Every demo user signs in with the password in DEMO_USER_PASSWORD (environment or `.env`;
//   `pnpm setup:secrets` fills it). It is stored hashed in a Better Auth `credential` account and
//   never printed. Under 12 characters (D49) the seed stops before creating anything.
// - Safe to re-run: the orgs, users and members are found again, not duplicated.
// - Then (S1-010) each org's fixed records and links (demo-records.ts), added as the org's Admin
//   through RecordsService and LinksService, so each one is audited like any change (D37, D45.4).
//   Every record carries a fixed source ID, so a re-run finds it and adds nothing (D45.5).
// - Then (S2-008) each org's framework catalogs (loadFrameworkCatalogs; a no-op when provisioning
//   already loaded them) and its fixed control-to-requirement mappings (demo-mappings.ts), added as
//   the org's Admin through MappingsService, so each one gets its `link.created` entry (D37, D56).
//   A control is found by its demo source ID and a requirement by its framework and code; a mapping
//   that is already there is refused (409 `link_exists`) and left alone, so a re-run adds nothing.
// - Then (S3-020) each org's fixed intake (demo-intake/demo-intake.ts), all through the intake
//   services, so each change is audited (D37, D45.4, D56):
//   - the asset list, uploaded as the Admin through UploadsService (`storeUpload`, source
//     `demo-cmdb`), read, and imported through ImportRunService with the demo mapping, which is
//     saved for the source. The seed runs the read and the import itself, here, and waits for
//     them; their jobs never reach pg-boss, so the worker never runs them a second time;
//   - two policy documents and one SOC ticket file, each uploaded as the role named; their
//     `processing.document-read` jobs go to pg-boss as the API sends them, for the worker (S4);
//   - evidence through EvidenceService, as the Control Owner or the Admin, and audit findings
//     through FindingsService, as the Auditor, each created with its CONCERNS link.
//   A file already stored in the org (found by its content hash) is not uploaded again, an import
//   that is done is left alone, evidence already attached (the same file on the same control) and
//   a finding already there (its `sourceReference`) are not added again, so a re-run adds nothing
//   and writes no entry. A run that stopped part-way finishes the missing steps, the import too.
// - Then (S5-007) each org's fixed review findings (demo-intake/demo-review.ts), what processing
//   would have left for the Analyst, with no Gemma and no bge-m3 call (D82):
//   - the few records they need beyond S1's (a pair of assets with close spellings, and in Acme a
//     policy), added as the Admin through RecordsService, found again by their source IDs;
//   - the demo documents they come from get their chunks the way S4's reader stores them
//     (`readDocument`: the stored file read in the file sandbox, the same chunker, the document
//     moved to `processing` and its embed job queued, so the worker later only embeds them). That
//     needs bge-m3's tokenizer file: when it is missing the seed says which command sets it up, as
//     the worker does, and adds those findings on the next run;
//   - each document's Gemma-style answer goes through S4-008's own rules (decide-rules.ts) in the
//     uploader's view: the rule checks, the finding keys and labels, the proposed new records, and
//     the links that pass every check written live like S4's live links (`writeLiveLinks`: origin
//     `ai` with their source, and their `link.created` entries); then, in one Postgres
//     transaction, the `record` and `link` findings. A link the Analyst rejected or removed is
//     never raised again;
//   - the possible duplicate pair and the suggested mappings, with S4-007's and S4-009's keys.
//   Every finding's key is S4's, so a re-run adds nothing, and a live link whose finding is there
//   (whatever its status) is never written again. A removed upload gets nothing more (S5-004).
//   Records or documents a finding needs that aren't there yet (an import still running in the
//   worker, a document that failed) leave it for a later run, and the seed says how many wait.
//   Without the processing and review migrations the whole step is skipped, the others still run,
//   and the seed ends saying so (exit code 1).
// - Then (S6-008) the S6 demo's search and chat (docs/demo/s6.md): its questions are answered from
//   the records, links and mappings above and from the passages of the demo documents. The review
//   step reads only the documents its findings come from, so this step reads the others (the
//   Confidential policy documents) into chunks the same way, in case their S3 read job never ran
//   (`seedSearchChunks`). A document that has chunks already, or is processed, failed or removed,
//   is left alone, so a re-run adds nothing. Nothing calls Gemma or bge-m3 (D82): once Ollama is up,
//   the worker embeds the chunks (and Gemma reads them), and the questions find their passages. It
//   needs the processing migration and bge-m3's tokenizer file, as the review step does.
// - DEMO_ORG_SLUG_SUFFIX (optional, lowercase letters and digits) makes each slug
//   `<slug>-<suffix>`. The org IDs come from the slugs, so tests use it to stay off the live demo
//   orgs (D176).
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { basename } from 'node:path';
import type { DemoAssetList, DemoIntake, DemoIntakeRole } from './demo-intake/demo-intake.js';
import type {
  DemoAnswerLink,
  DemoAnswerRecord,
  DemoDocumentAnswer,
  DemoMatched,
  DemoRequirementRef,
  DemoReview,
  DemoReviewKind,
} from './demo-intake/demo-review.js';
import type { DemoMapping } from './demo-mappings.js';
import type { DemoData, DemoKind } from './demo-records.js';
import type { ScriptDb, ScriptTx } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, provisioning, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
const { DEMO_DATA, demoSourceId } = (await import(
  new URL('./demo-records.ts', import.meta.url).href
)) as typeof import('./demo-records.js');
const { DEMO_MAPPINGS } = (await import(
  new URL('./demo-mappings.ts', import.meta.url).href
)) as typeof import('./demo-mappings.js');
const { DEMO_INTAKE, demoIntakeFile, demoValidUntil } = (await import(
  new URL('./demo-intake/demo-intake.ts', import.meta.url).href
)) as typeof import('./demo-intake/demo-intake.js');
const { DEMO_REVIEW } = (await import(
  new URL('./demo-intake/demo-review.ts', import.meta.url).href
)) as typeof import('./demo-intake/demo-review.js');
const { toHostAddress } = (await import(
  new URL('./host-address.ts', import.meta.url).href
)) as typeof import('./host-address.js');

type Role = 'admin' | 'risk_manager' | 'compliance_manager' | 'control_owner' | 'auditor' | 'analyst' | 'viewer';
type Label = 'public' | 'internal' | 'confidential' | 'restricted';

// One user per role, at mixed clearances (D50, D51).
const PEOPLE: { role: Role; clearance: Label; local: string; name: string }[] = [
  { role: 'admin', clearance: 'restricted', local: 'admin', name: 'Admin' },
  { role: 'risk_manager', clearance: 'confidential', local: 'risk.manager', name: 'Risk Manager' },
  { role: 'compliance_manager', clearance: 'confidential', local: 'compliance.manager', name: 'Compliance Manager' },
  { role: 'control_owner', clearance: 'internal', local: 'control.owner', name: 'Control Owner' },
  { role: 'auditor', clearance: 'confidential', local: 'auditor', name: 'Auditor' },
  { role: 'analyst', clearance: 'internal', local: 'analyst', name: 'Analyst' },
  { role: 'viewer', clearance: 'public', local: 'viewer', name: 'Viewer' },
];

const ORGS = [
  { name: 'Acme Corp', slug: 'demo-acme', domain: 'acme.example' },
  { name: 'Globex Ltd', slug: 'demo-globex', domain: 'globex.example' },
];

const MIN_PASSWORD = 12; // D49

// Better Auth's password hash: scrypt (N 16384, r 16, p 1, 64 bytes) over the NFKC password,
// salted with 16 random bytes in hex, stored as `<salt>:<key>` in hex.
function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (err, key) =>
      err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`),
    );
  });
}

const password = setting('DEMO_USER_PASSWORD');
if (password.length < MIN_PASSWORD) {
  console.error(
    `seed:demo: DEMO_USER_PASSWORD must be set (environment or .env) and at least ${MIN_PASSWORD} characters. ` +
      'Run `pnpm setup:secrets` to generate one. Nothing was created.',
  );
  process.exit(2);
}
const suffix = setting('DEMO_ORG_SLUG_SUFFIX');
if (suffix !== '' && !/^[a-z0-9]+$/.test(suffix)) {
  console.error('seed:demo: DEMO_ORG_SLUG_SUFFIX may hold only lowercase letters and digits. Nothing was created.');
  process.exit(2);
}
const missing = missingSettings();
if (missing.length > 0) {
  console.error(`seed:demo: missing settings (environment or .env): ${missing.join(', ')}. Nothing was created.`);
  process.exit(2);
}

const sql = await sqlTag();

// Adds the user (found by email) to the org with this role and clearance, unless they are
// already a member, and sets their demo password. Returns the user's ID.
async function addPerson(
  db: ScriptDb,
  orgId: string,
  person: { email: string; name: string; role: Role; clearance: Label },
  hash: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES (${randomUUID()}, ${person.name}, ${person.email})
          ON CONFLICT (email) DO NOTHING`,
    );
    const found = await tx.execute(sql`SELECT id FROM "user" WHERE email = ${person.email}`);
    const userId = String(found.rows[0]!['id']);
    const member = await tx.execute(sql`SELECT 1 FROM "member" WHERE org_id = ${orgId}::uuid AND user_id = ${userId}`);
    if (member.rows.length === 0) {
      await tx.execute(
        sql`INSERT INTO "member" (id, org_id, user_id, role, clearance)
            VALUES (${randomUUID()}, ${orgId}::uuid, ${userId}, ${person.role}, ${person.clearance})`,
      );
    }
    const updated = await tx.execute(
      sql`UPDATE "account" SET password = ${hash}, updated_at = now()
          WHERE user_id = ${userId} AND provider_id = 'credential' RETURNING id`,
    );
    if (updated.rows.length === 0) {
      await tx.execute(
        sql`INSERT INTO "account" (id, account_id, provider_id, user_id, password)
            VALUES (${randomUUID()}, ${userId}, 'credential', ${userId}, ${hash})`,
      );
    }
    return userId;
  });
}

// The slices of the api's services the seed uses (loaded from packages/api/src at run time).
interface Caller {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
}
interface ReadTx {
  run(query: string, params: Record<string, unknown>): Promise<{ records: { get(key: string): unknown }[] }>;
}
interface Graph {
  read<T>(orgId: string, fn: (tx: ReadTx) => Promise<T>): Promise<T>;
}
interface RecordsApi {
  create(caller: Caller, kind: DemoKind, input: unknown, options: { sourceIds: string[] }): Promise<{ id: string }>;
}
interface LinksApi {
  create(caller: Caller, input: { type: string; fromId: string; toId: string }): Promise<unknown>;
}
interface MappingsApi {
  create(caller: Caller, input: { controlId: string; requirementId: string }): Promise<unknown>;
}
/** Node counts of one framework's load (the loader's report). */
interface CatalogCounts {
  added: number;
  updated: number;
  retired: number;
}
interface CatalogReport {
  frameworks: CatalogCounts[];
  mapsTo: { added: number; retired: number };
}
interface Services {
  graph: Graph;
  records: RecordsApi;
  links: LinksApi;
  mappings: MappingsApi;
  /** The audit outbox the services write through; provisioning uses the same one. */
  outbox: object;
  /** The framework catalog files, read and checked once. */
  catalogs: unknown;
  loadCatalogs(orgId: string): Promise<CatalogReport>;
}

async function services(deps: { db: ScriptDb; graph: unknown }): Promise<Services> {
  const { AuditOutbox } = await load<{ AuditOutbox: new (graph: unknown) => object }>('audit/outbox.ts');
  const { RecordsService } = await load<{ RecordsService: new (d: object) => RecordsApi }>(
    'records/records.service.ts',
  );
  const { LinksService } = await load<{ LinksService: new (d: object) => LinksApi }>('records/links.service.ts');
  const { MappingsService } = await load<{ MappingsService: new (d: object) => MappingsApi }>(
    'frameworks/mappings.service.ts',
  );
  const { readCatalogFiles } = await load<{ readCatalogFiles(): unknown }>('frameworks/catalog-files.ts');
  const { loadFrameworkCatalogs } = await load<{
    loadFrameworkCatalogs(deps: { outbox: object }, orgId: string, catalogs: unknown): Promise<CatalogReport>;
  }>('frameworks/catalog-loader.ts');
  const outbox = new AuditOutbox(deps.graph);
  const catalogs = readCatalogFiles();
  return {
    graph: deps.graph as Graph,
    records: new RecordsService({ graph: deps.graph, outbox, db: deps.db }),
    links: new LinksService({ graph: deps.graph, outbox }),
    mappings: new MappingsService({ graph: deps.graph, outbox }),
    outbox,
    catalogs,
    loadCatalogs: (orgId) => loadFrameworkCatalogs({ outbox }, orgId, catalogs),
  };
}

/** A setting the records step needs is missing; its name is safe to print. */
class MissingSetting extends Error {
  constructor(readonly setting: string) {
    super(`missing setting ${setting}`);
    this.name = 'MissingSetting';
  }
}

/** The fixed demo data names something the org's graph doesn't hold. Prints only which kind of
 * thing is missing and its place in the list, never a value (D164). */
class DemoDataError extends Error {
  constructor(
    readonly code: 'unknown_control' | 'unknown_requirement',
    readonly index: number,
  ) {
    super(`demo mapping ${index}: ${code}`);
    this.name = 'DemoDataError';
  }
}

const NODE_LABEL: Record<DemoKind, string> = {
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
};

// Adds the org's demo records and links that aren't there yet. A record is found by its source
// ID; a link that already exists is refused by LinksService (409 `link_exists`) and left alone.
async function seedRecords(
  svc: Services,
  admin: Caller,
  data: DemoData,
  userOf: (role: string) => string,
): Promise<{ records: number; links: number }> {
  const ids = new Map<string, string>();
  let records = 0;
  let links = 0;
  for (const rec of data.records) {
    const sourceId = demoSourceId(rec.key);
    const found = await svc.graph.read(admin.orgId, async (tx) => {
      const res = await tx.run(
        `MATCH (n:${NODE_LABEL[rec.kind]}) WHERE $sourceId IN n.sourceIds RETURN n.id AS id LIMIT 1`,
        { sourceId },
      );
      return res.records[0]?.get('id') as string | undefined;
    });
    if (found !== undefined) {
      ids.set(rec.key, found);
      continue;
    }
    const input = { name: rec.name, label: rec.label, owner: userOf(rec.owner), ...rec.fields };
    const created = await svc.records.create(admin, rec.kind, input, { sourceIds: [sourceId] });
    ids.set(rec.key, created.id);
    records += 1;
  }
  for (const link of data.links) {
    const fromId = ids.get(link.from);
    const toId = ids.get(link.to);
    if (!fromId || !toId) throw new Error(`demo link ${link.type} names an unknown record`);
    try {
      await svc.links.create(admin, { type: link.type, fromId, toId });
      links += 1;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'link_exists') throw err;
    }
  }
  return { records, links };
}

// Adds the org's demo mappings that aren't there yet, as `caller` through MappingsService (its
// checks and its audit entry, D37, D212 (3)). The controls are found by their demo source IDs and
// the requirements by framework and code (active ones only), each in one read. A mapping already
// there is refused (409 `link_exists`) and left alone. Returns how many were added.
async function seedMappings(svc: Services, caller: Caller, mappings: DemoMapping[]): Promise<number> {
  const sourceIds = [...new Set(mappings.map((m) => m.control))];
  const wanted = mappings.map((m) => ({ framework: m.framework, code: m.code }));
  const { controls, requirements } = await svc.graph.read(caller.orgId, async (tx) => {
    const c = await tx.run(
      `UNWIND $sourceIds AS sid
       MATCH (n:Control) WHERE sid IN n.sourceIds
       RETURN sid, n.id AS id`,
      { sourceIds },
    );
    const q = await tx.run(
      `UNWIND $wanted AS w
       MATCH (n:Requirement {framework: w.framework, code: w.code}) WHERE n.status = 'active'
       RETURN w.framework + ' ' + w.code AS key, n.id AS id`,
      { wanted },
    );
    return {
      controls: new Map(c.records.map((r) => [r.get('sid') as string, r.get('id') as string])),
      requirements: new Map(q.records.map((r) => [r.get('key') as string, r.get('id') as string])),
    };
  });
  let added = 0;
  for (const [index, m] of mappings.entries()) {
    const controlId = controls.get(m.control);
    if (!controlId) throw new DemoDataError('unknown_control', index);
    const requirementId = requirements.get(`${m.framework} ${m.code}`);
    if (!requirementId) throw new DemoDataError('unknown_requirement', index);
    try {
      await svc.mappings.create(caller, { controlId, requirementId });
      added += 1;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'link_exists') throw err;
    }
  }
  return added;
}

/** The sum of one count over every framework of a catalog load. */
function total(report: CatalogReport, key: keyof CatalogCounts): number {
  return report.frameworks.reduce((sum, f) => sum + f[key], 0);
}

// ---- S3-020: the demo intake ----

/** A multipart form as the intake services take it (what the upload routes read from a request). */
interface Form {
  fields: Record<string, string>;
  file?: { fieldName: string; fileName: string; body: Buffer };
}
interface UploadsApi {
  upload(caller: Caller, form: Form): Promise<{ document: { id: string }; duplicate: boolean }>;
}
interface ImportRunApi {
  run(caller: Caller, id: string, body: unknown): Promise<{ jobId: string }>;
}
interface EvidenceApi {
  create(caller: Caller, form: Form): Promise<{ id: string }>;
}
interface FindingsApi {
  create(caller: Caller, input: unknown): Promise<{ id: string }>;
}
interface ImportCountsOut {
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  linksAdded: number;
}
/** What one asset-list read or import run did (the job handlers' outcomes). */
interface JobOutcome {
  status: string;
  code?: string;
  counts?: ImportCountsOut;
}
/** The slice of JobsService (pg-boss) the seed uses. */
interface JobsLike {
  start(): Promise<JobsLike>;
  sendInTx(tx: unknown, queue: string, data: object, opts?: { singletonKey?: string }): Promise<string | null>;
  onApplicationShutdown(): Promise<void>;
}
interface OrgContext {
  orgId: string;
  userId: string;
  role: string;
  clearance: string;
}

/**
 * The seed's job sender. The asset-list read and import jobs run right here in the seed, which
 * waits for them (and a test's throwaway database has no worker), so they get an ID and are kept
 * in `held` instead of going to pg-boss, where the worker would pick them up as well. Every other
 * job (the documents' `processing.document-read`) goes to pg-boss inside the upload's transaction,
 * as the API sends it, for the worker. pg-boss is started only when the first such job is sent.
 */
class SeedJobs {
  readonly held = new Map<string, { queue: string; data: object }>();
  private boss: Promise<JobsLike> | undefined;

  constructor(
    private readonly inline: ReadonlySet<string>,
    private readonly openBoss: () => JobsLike,
  ) {}

  async sendInTx(
    tx: unknown,
    queue: string,
    data: object,
    opts: { singletonKey?: string } = {},
  ): Promise<string | null> {
    if (this.inline.has(queue)) {
      const id = randomUUID();
      this.held.set(id, { queue, data });
      return id;
    }
    this.boss ??= this.openBoss().start();
    return (await this.boss).sendInTx(tx, queue, data, opts);
  }

  async close(): Promise<void> {
    const boss = await this.boss?.catch(() => undefined);
    await boss?.onApplicationShutdown();
  }
}

interface IntakeServices {
  uploads: UploadsApi;
  importRun: ImportRunApi;
  evidence: EvidenceApi;
  findings: FindingsApi;
  jobs: SeedJobs;
  readAssetList(data: object): Promise<JobOutcome>;
  runAssetImport(job: { id: string; data: object }): Promise<JobOutcome>;
  /** The runner a person's import job names (role and clearance), as the run route makes it. */
  runnerOf(caller: Caller): object;
  /** A transaction in the org's intake system context (the org wall applies, R10). */
  inSystemContext<T>(orgId: string, fn: (tx: ScriptTx) => Promise<T>): Promise<T>;
  /** Today's date, `YYYY-MM-DD` (UTC), as the evidence and finding rules count it. */
  today(): string;
}

async function intakeServices(deps: { db: ScriptDb; graph: unknown; files: unknown }, outbox: object) {
  const { AuditService } = await load<{ AuditService: new (db: ScriptDb) => object }>('audit/audit.service.ts');
  const { JobsService } = await load<{
    JobsService: new (o: { connectionString: string; processJobs: boolean }) => JobsLike;
  }>('jobs/jobs.module.ts');
  const { UploadsService } = await load<{ UploadsService: new (d: object) => UploadsApi }>(
    'intake/uploads/uploads.service.ts',
  );
  const { ImportRunService, runnerOf } = await load<{
    ImportRunService: new (d: object) => ImportRunApi;
    runnerOf(caller: Caller): object;
  }>('intake/imports/run.service.ts');
  const { readAssetList } = await load<{ readAssetList(d: object, data: unknown): Promise<JobOutcome> }>(
    'intake/imports/asset-list-reader.job.ts',
  );
  const { runAssetImport } = await load<{
    runAssetImport(d: object, job: { id: string; data: unknown }): Promise<JobOutcome>;
  }>('intake/imports/asset-import.job.ts');
  const { EvidenceService } = await load<{ EvidenceService: new (d: object) => EvidenceApi }>(
    'intake/evidence/evidence.service.ts',
  );
  const { FindingsService } = await load<{ FindingsService: new (d: object) => FindingsApi }>(
    'intake/audit-findings/findings.service.ts',
  );
  const { utcToday } = await load<{ utcToday(): string }>('intake/audit-findings/finding-queries.ts');
  const { withOrgContext } = await load<{
    withOrgContext<T>(db: ScriptDb, ctx: OrgContext, fn: (tx: ScriptTx) => Promise<T>): Promise<T>;
  }>('db/org-context.ts');
  const { INTAKE_QUEUES, INTAKE_SYSTEM_CONTEXT } = await load<{
    INTAKE_QUEUES: { assetListRead: string; assetImport: string; documentRead: string };
    INTAKE_SYSTEM_CONTEXT(orgId: string): OrgContext;
  }>('intake/queues.ts');
  const { createLogger } = await load<{
    createLogger(stream?: { write(line: string): void }): { level: string };
  }>('common/logger.ts');

  // The services' own log lines (codes, counts and IDs only, D164): warnings and errors, on stderr.
  const log = createLogger({ write: (line) => void process.stderr.write(line) });
  log.level = 'warn';
  const db = deps.db;
  const audit = new AuditService(db);
  const jobs = new SeedJobs(
    new Set([INTAKE_QUEUES.assetListRead, INTAKE_QUEUES.assetImport]),
    () => new JobsService({ connectionString: toHostAddress(setting('DATABASE_URL_APP')), processJobs: false }),
  );
  const common = { db, audit, files: deps.files, log };
  const services: IntakeServices = {
    uploads: new UploadsService({ ...common, jobs }),
    importRun: new ImportRunService({ db, audit, jobs }),
    evidence: new EvidenceService({ ...common, graph: deps.graph, outbox }),
    findings: new FindingsService({ db, graph: deps.graph, outbox, log }),
    jobs,
    readAssetList: (data) => readAssetList({ ...common, jobs }, data),
    runAssetImport: (job) => runAssetImport({ ...common, graph: deps.graph, outbox }, job),
    runnerOf,
    inSystemContext: (orgId, fn) => withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), fn),
    today: () => utcToday(),
  };
  return services;
}

/** The demo intake data is wrong for the org's graph or files. Prints only what kind of problem it
 * is, the list and the place in it, and a fixed code: never a name, a value or a file's contents
 * (D164). */
class DemoIntakeError extends Error {
  constructor(
    readonly code: 'unknown_record' | 'asset_list_unreadable' | 'import_missing' | 'import_failed' | 'import_stuck',
    readonly list: 'evidence' | 'findings' | 'assetList',
    readonly index: number,
    readonly detail?: string,
  ) {
    super(`demo intake ${list} ${index}: ${code}`);
    this.name = 'DemoIntakeError';
  }
}

/** The words for a DemoIntakeError: the list, the place in it and a fixed code, nothing more. */
function intakeProblem(err: DemoIntakeError): string {
  const where = 'demo-intake/demo-intake.ts';
  // The read's or the import's own code, from their fixed lists of codes.
  const code = err.detail !== undefined && /^[a-z_]{1,40}$/.test(err.detail) ? ` (${err.detail})` : '';
  switch (err.code) {
    case 'unknown_record': {
      const thing = err.list === 'evidence' ? 'control' : 'control or risk';
      return `demo intake ${err.list} item ${err.index} (${where}) names a ${thing} the org's graph doesn't hold.`;
    }
    case 'asset_list_unreadable':
      return `the demo asset list (${where}) could not be read${code}.`;
    case 'import_missing':
      return "the demo asset list's file is stored in the org, but not as an asset list with its import.";
    case 'import_failed':
      return `the demo asset list's import failed${code}.`;
    case 'import_stuck':
      return "the demo asset list's import did not finish.";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The ID of the org's document with this content, whoever uploaded it, or undefined. */
async function documentWithContent(
  isvc: IntakeServices,
  orgId: string,
  contentHash: string,
): Promise<string | undefined> {
  return isvc.inSystemContext(orgId, async (tx) => {
    const found = await tx.execute(
      sql`SELECT id::text AS id FROM documents WHERE org_id = ${orgId}::uuid AND content_hash = ${contentHash} LIMIT 1`,
    );
    const id = found.rows[0]?.['id'];
    return typeof id === 'string' ? id : undefined;
  });
}

interface ImportState {
  id: string;
  status: string;
  jobId: string | null;
  hasColumns: boolean;
  counts: ImportCountsOut | null;
}

/** The latest import of a document, or of one import by its ID. */
async function importState(
  isvc: IntakeServices,
  orgId: string,
  by: { documentId: string } | { importId: string },
): Promise<ImportState | undefined> {
  return isvc.inSystemContext(orgId, async (tx) => {
    const where = 'documentId' in by ? sql`document_id = ${by.documentId}::uuid` : sql`id = ${by.importId}::uuid`;
    const found = await tx.execute(
      sql`SELECT id::text AS id, status, job_id::text AS job_id, columns IS NOT NULL AS has_columns, counts
          FROM imports WHERE org_id = ${orgId}::uuid AND ${where}
          ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const row = found.rows[0];
    if (!row) return undefined;
    return {
      id: String(row['id']),
      status: String(row['status']),
      jobId: typeof row['job_id'] === 'string' ? row['job_id'] : null,
      hasColumns: row['has_columns'] === true,
      counts: (row['counts'] as ImportCountsOut | null) ?? null,
    };
  });
}

/** Whether pg-boss holds a job with this ID that is still waiting or running (the worker's). */
async function jobStillQueued(db: ScriptDb, jobId: string): Promise<boolean> {
  if (!UUID.test(jobId)) return false;
  return db.transaction(async (tx) => {
    const found = await tx.execute(
      sql`SELECT 1 FROM pgboss.job WHERE id = ${jobId}::uuid AND state IN ('created', 'retry', 'active') LIMIT 1`,
    );
    return found.rows.length > 0;
  });
}

type ImportResult =
  { status: 'imported'; counts: ImportCountsOut | null } | { status: 'already_done' } | { status: 'running_in_worker' };

/**
 * Takes the demo asset list's import to `done` as the Admin, from whichever step it is at: read the
 * file (`reading`), run it with the demo mapping, saved for the source (`needs_mapping`, or
 * `failed` after its columns were read), or run its queued job (`queued` or `importing`). A queued
 * job that pg-boss holds belongs to the worker, which is left to finish it.
 */
async function finishImport(
  db: ScriptDb,
  isvc: IntakeServices,
  admin: Caller,
  list: DemoAssetList,
  documentId: string,
): Promise<ImportResult> {
  const first = await importState(isvc, admin.orgId, { documentId });
  if (!first) throw new DemoIntakeError('import_missing', 'assetList', 0);
  if (first.status === 'done') return { status: 'already_done' };
  const importId = first.id;
  const run = { mapping: list.mapping, saveForSource: true };
  for (let step = 0; step < 6; step += 1) {
    const imp = step === 0 ? first : await importState(isvc, admin.orgId, { importId });
    if (!imp) throw new DemoIntakeError('import_missing', 'assetList', 0);
    switch (imp.status) {
      case 'done':
        return { status: 'imported', counts: imp.counts };
      case 'reading': {
        const read = await isvc.readAssetList({ orgId: admin.orgId, importId, documentId });
        if (read.status === 'failed') throw new DemoIntakeError('asset_list_unreadable', 'assetList', 0, read.code);
        break;
      }
      case 'needs_mapping':
        await isvc.importRun.run(admin, importId, run);
        break;
      case 'failed':
        if (!imp.hasColumns) throw new DemoIntakeError('asset_list_unreadable', 'assetList', 0);
        await isvc.importRun.run(admin, importId, run);
        break;
      case 'queued':
      case 'importing': {
        if (imp.jobId === null) throw new DemoIntakeError('import_stuck', 'assetList', 0);
        let data = isvc.jobs.held.get(imp.jobId)?.data;
        if (data === undefined) {
          // Not this run's job: the worker's while pg-boss holds it, else a seed run's that stopped.
          if (await jobStillQueued(db, imp.jobId)) return { status: 'running_in_worker' };
          data = { orgId: admin.orgId, importId, runner: isvc.runnerOf(admin) };
        }
        const done = await isvc.runAssetImport({ id: imp.jobId, data });
        if (done.status === 'failed') throw new DemoIntakeError('import_failed', 'assetList', 0, done.code);
        break;
      }
      default:
        throw new DemoIntakeError('import_stuck', 'assetList', 0);
    }
  }
  throw new DemoIntakeError('import_stuck', 'assetList', 0);
}

/** The IDs of the org's demo records with these S1 keys, among the given node labels. */
async function demoRecordIds(
  svc: Services,
  orgId: string,
  labels: readonly ('Control' | 'Risk')[],
  keys: string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(keys)].map((key) => ({ key, sourceId: demoSourceId(key) }));
  const match = labels.map((l) => `n:${l}`).join(' OR ');
  return svc.graph.read(orgId, async (tx) => {
    const res = await tx.run(
      `UNWIND $wanted AS w
       MATCH (n) WHERE (${match}) AND w.sourceId IN n.sourceIds
       RETURN w.key AS key, n.id AS id`,
      { wanted },
    );
    return new Map(res.records.map((r) => [r.get('key') as string, r.get('id') as string]));
  });
}

/** True when the query's one row says `there`. */
async function graphHas(svc: Services, orgId: string, query: string, params: Record<string, unknown>) {
  return svc.graph.read(orgId, async (tx) => {
    const res = await tx.run(query, params);
    return res.records[0]?.get('there') === true;
  });
}

interface IntakeAdded {
  uploads: number;
  assetImport: ImportResult;
  evidence: number;
  findings: number;
}

// Adds the org's demo intake that isn't there yet (see the top of the file).
async function seedIntake(
  svc: Services,
  isvc: IntakeServices,
  db: ScriptDb,
  data: DemoIntake,
  callerOf: (role: DemoIntakeRole) => Caller,
  userOf: (role: string) => string,
): Promise<IntakeAdded> {
  const admin = callerOf('admin');
  const orgId = admin.orgId;
  let uploads = 0;

  // Uploads: the asset list, then the other documents. A file the org already has isn't sent again.
  const upload = async (caller: Caller, path: string, fields: Record<string, string>): Promise<string> => {
    const body = demoIntakeFile(path);
    const found = await documentWithContent(isvc, orgId, sha256Hex(body));
    if (found !== undefined) return found;
    const answer = await isvc.uploads.upload(caller, {
      fields,
      file: { fieldName: 'file', fileName: basename(path), body },
    });
    if (!answer.duplicate) uploads += 1;
    return answer.document.id;
  };
  const list = data.assetList;
  const listDocumentId = await upload(admin, list.file, {
    kind: 'asset_list',
    source: list.source,
    label: list.label,
  });
  const assetImport = await finishImport(db, isvc, admin, list, listDocumentId);
  for (const doc of data.documents) {
    await upload(callerOf(doc.uploader), doc.file, { kind: doc.kind, label: doc.label });
  }

  // Evidence, on the demo controls named by their S1 keys.
  let evidence = 0;
  const controls = await demoRecordIds(
    svc,
    orgId,
    ['Control'],
    data.evidence.map((e) => e.control),
  );
  const today = isvc.today();
  for (const [index, item] of data.evidence.entries()) {
    const controlId = controls.get(item.control);
    if (!controlId) throw new DemoIntakeError('unknown_record', 'evidence', index);
    const body = demoIntakeFile(item.file);
    const attached = await graphHas(
      svc,
      orgId,
      `MATCH (e:Evidence {fileHash: $fileHash})-[:SUPPORTS]->(:Control {id: $controlId})
       RETURN count(e) > 0 AS there`,
      { fileHash: sha256Hex(body), controlId },
    );
    if (attached) continue;
    const validUntil = demoValidUntil(item, today);
    const fields: Record<string, string> = {
      controlId,
      name: item.name,
      collectedDate: item.collectedDate,
      label: item.label,
      ...(validUntil !== null ? { validUntil } : {}),
    };
    try {
      await isvc.evidence.create(callerOf(item.addedBy), {
        fields,
        file: { fieldName: 'file', fileName: basename(item.file), body },
      });
      evidence += 1;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'evidence_exists') throw err;
    }
  }

  // Audit findings, as the Auditor, each concerning a demo control or risk.
  let findings = 0;
  const auditor = callerOf('auditor');
  const targets = await demoRecordIds(
    svc,
    orgId,
    ['Control', 'Risk'],
    data.findings.map((f) => f.concerns),
  );
  for (const [index, f] of data.findings.entries()) {
    const there = await graphHas(
      svc,
      orgId,
      'MATCH (n:AuditFinding {sourceReference: $ref}) RETURN count(n) > 0 AS there',
      { ref: f.sourceReference },
    );
    if (there) continue;
    const concernsId = targets.get(f.concerns);
    if (!concernsId) throw new DemoIntakeError('unknown_record', 'findings', index);
    await isvc.findings.create(auditor, {
      name: f.name,
      severity: f.severity,
      findingStatus: f.findingStatus,
      owner: userOf(f.owner),
      sourceReference: f.sourceReference,
      rootCause: f.rootCause,
      remediationPlan: f.remediationPlan,
      identifiedDate: f.identifiedDate,
      dueDate: f.dueDate,
      ...(f.closedDate !== undefined ? { closedDate: f.closedDate } : {}),
      description: f.description,
      label: f.label,
      concernsId,
    });
    findings += 1;
  }

  return { uploads, assetImport, evidence, findings };
}

/** One line about the asset import: counts and a status only. */
function importLine(result: ImportResult): string {
  if (result.status === 'already_done') return 'asset list import already done';
  if (result.status === 'running_in_worker') return 'asset list import running in the worker';
  const c = result.counts;
  return c
    ? `asset list imported: added ${c.added}, updated ${c.updated}, unchanged ${c.unchanged}, ` +
        `failed ${c.failed}, links added ${c.linksAdded}`
    : 'asset list imported';
}

// ---- S5-007: the demo review findings ----

type MatchStep = 'exact' | 'spelling' | 'meaning';

/** A record a name may mean, as S4-007's matcher answers it (`MatchCandidate`). */
interface MatchCandidate {
  recordId: string;
  number: string;
  name: string;
  step: MatchStep;
  score: number;
}
/** What a name means (S4-007's `NameMatch`). */
type NameMatch =
  | { outcome: 'clear'; match: MatchCandidate; label: Label }
  | { outcome: 'uncertain'; candidates: MatchCandidate[]; label: Label }
  | { outcome: 'none' };
/** A record and a link of an extraction answer (S4-001's `ExtractionRecord`, `ExtractionLink`). */
interface AnswerRecord {
  ref: string;
  kind: DemoReviewKind;
  name: string;
  details?: Record<string, string>;
}
type AnswerLink = Pick<DemoAnswerLink, 'type' | 'from' | 'to' | 'sentence'>;
/** One link after S4-008's rule checks (decide-rules.ts `EvaluatedLink`), the parts used here. */
interface EvaluatedLink {
  key: string;
  type: string;
  sentence: string;
  failed: string[];
  from: { kind: DemoReviewKind; match: { recordId: string; label: Label } | null };
  to: { kind: DemoReviewKind; match: { recordId: string; label: Label } | null };
  label: Label;
}
/** A proposed new record (decide-rules.ts `ProposedRecord`). */
interface ProposedRecord {
  key: string;
  proposal: object;
}
/** Whose view a document's processing works in (S4's `MatchView`). */
interface MatchView {
  role: Role;
  clearance: Label;
  userId?: string;
}
/** Where a chunk's live links came from, and one link to write (live-links.ts). */
interface LiveLinkSource {
  documentId: string;
  chunkId: string;
  model: string;
  promptVersion: string;
  sourceLabel: Label;
  sourceRecordType: string;
}
interface LiveLinkWrite {
  key: string;
  type: string;
  from: { kind: DemoReviewKind; id: string };
  to: { kind: DemoReviewKind; id: string };
  sentence: string;
}
type LiveLinkOutcome = 'created' | 'ours' | 'exists';
type Parser = { safeParse(value: unknown): { success: boolean } };

/** The slices of @grc/shared and of the api's processing code the review step uses. */
interface ReviewServices {
  editSimilarity(a: string, b: string): number;
  isRecordVisible(viewer: MatchView, end: { recordType: string; label: string; isOwner?: boolean }): boolean;
  extractionAnswerSchema: Parser;
  duplicateProposalSchema: Parser;
  mappingProposalSchema: Parser;
  // S4-008's decision rules (processing/decide/decide-rules.ts); `Ends` passes through unread.
  matchedEnds(documentId: string, records: readonly AnswerRecord[], matches: readonly NameMatch[]): Ends;
  proposedRecords(records: readonly AnswerRecord[], ends: Ends): ProposedRecord[];
  evaluateLinks(input: {
    chunkId: string;
    chunkText: string;
    documentLabel: Label;
    links: readonly AnswerLink[];
    ends: Ends;
  }): EvaluatedLink[];
  linkProposal(link: EvaluatedLink, recordFindingIds: ReadonlyMap<string, string>): object | null;
  endsCoverSource(
    source: { recordType: string; label: Label },
    from: { kind: DemoReviewKind; label: Label },
    to: { kind: DemoReviewKind; label: Label },
  ): boolean;
  identityOfLink(link: EvaluatedLink): unknown;
  identityOfProposal(raw: unknown): unknown;
  isRefused(link: unknown, refused: readonly unknown[]): boolean;
  /** S4-004's reader, with the seed's job sender (the embed job goes to pg-boss for the worker). */
  readDocument(job: { orgId: string; documentId: string }): Promise<{ status: string; code?: string }>;
  /** Whether bge-m3's tokenizer files are set up; the message naming the command when they aren't. */
  tokenizerProblem(): Promise<string | null>;
  /** The same, but only if a document needed the tokenizer in this run (null otherwise). */
  tokenizerProblemIfAsked(): Promise<string | null>;
  writeLiveLinks(
    orgId: string,
    view: MatchView,
    source: LiveLinkSource,
    links: readonly LiveLinkWrite[],
  ): Promise<Map<string, LiveLinkOutcome>>;
  isLinkEndsChanged(err: unknown): boolean;
  uploaderView(
    tx: ScriptTx,
    doc: { orgId: string; uploaderType: string; uploaderId: string },
  ): Promise<MatchView | null>;
  duplicateFindingKey(kind: DemoReviewKind, a: string, b: string): string;
  mappingFindingKey(type: string, fromId: string, toId: string): string;
  /** The text model processing names on what it proposes (`AI_TEXT_MODEL`, gemma4:12b by default). */
  textModel: string;
  extractionPromptVersion: string;
  suggestPromptVersion: string;
}
type Ends = ReadonlyMap<string, unknown>;

async function reviewServices(
  deps: { db: ScriptDb; files: unknown },
  outbox: object,
  jobs: SeedJobs,
): Promise<ReviewServices> {
  const shared = (await import(new URL('../../shared/src/index.ts', import.meta.url).href)) as Pick<
    ReviewServices,
    | 'editSimilarity'
    | 'isRecordVisible'
    | 'extractionAnswerSchema'
    | 'duplicateProposalSchema'
    | 'mappingProposalSchema'
  >;
  const rules = await load<
    Pick<
      ReviewServices,
      | 'matchedEnds'
      | 'proposedRecords'
      | 'evaluateLinks'
      | 'linkProposal'
      | 'endsCoverSource'
      | 'identityOfLink'
      | 'identityOfProposal'
      | 'isRefused'
    >
  >('processing/decide/decide-rules.ts');
  const { readDocument } = await load<{
    readDocument(d: object, data: unknown): Promise<{ status: string; code?: string }>;
  }>('processing/reader/document-read.job.ts');
  const { BgeM3Tokenizer, TokenizerUnavailableError } = await load<{
    BgeM3Tokenizer: new () => { get(): Promise<unknown>; check(): Promise<void> };
    TokenizerUnavailableError: new (...args: never[]) => Error;
  }>('processing/reader/tokenizer.ts');
  const { writeLiveLinks, LinkEndsChanged } = await load<{
    writeLiveLinks(
      d: { outbox: object },
      orgId: string,
      view: MatchView,
      source: LiveLinkSource,
      links: readonly LiveLinkWrite[],
    ): Promise<Map<string, LiveLinkOutcome>>;
    LinkEndsChanged: new (...args: never[]) => Error;
  }>('processing/decide/live-links.ts');
  const { uploaderView } = await load<Pick<ReviewServices, 'uploaderView'>>('processing/decide/uploader-view.ts');
  const { duplicateFindingKey } = await load<Pick<ReviewServices, 'duplicateFindingKey'>>(
    'processing/match/record-dedupe.job.ts',
  );
  const { mappingFindingKey } = await load<Pick<ReviewServices, 'mappingFindingKey'>>(
    'processing/suggest/mapping-suggest.job.ts',
  );
  const { SUGGEST_PROMPT_VERSION } = await load<{ SUGGEST_PROMPT_VERSION: string }>(
    'processing/suggest/suggest-prompt.ts',
  );
  const { EXTRACTION_PROMPT_VERSION } = await load<{ EXTRACTION_PROMPT_VERSION: string }>(
    'processing/extract/prompt.ts',
  );
  const { aiSettingsFromEnv } = await load<{
    aiSettingsFromEnv(env: Record<string, string | undefined>): { textModel: string };
  }>('ai/ai-settings.ts');
  const { createLogger } = await load<{
    createLogger(stream?: { write(line: string): void }): { level: string };
  }>('common/logger.ts');

  // The reader's own log lines (codes, counts and IDs only, D164): warnings and errors, on stderr.
  const log = createLogger({ write: (line) => void process.stderr.write(line) });
  log.level = 'warn';
  // Loaded on the first document that needs its chunks (about 170 MB), and only then.
  const tokenizer = new BgeM3Tokenizer();
  let tokenizerChecked: Promise<string | null> | undefined;
  const readerDeps = { db: deps.db, files: deps.files, jobs, tokenizer: () => tokenizer.get(), log };
  const tokenizerProblem = (): Promise<string | null> =>
    (tokenizerChecked ??= tokenizer.check().then(
      () => null,
      (err: unknown) => {
        if (err instanceof TokenizerUnavailableError) return err.message;
        throw err;
      },
    ));
  return {
    editSimilarity: shared.editSimilarity,
    isRecordVisible: shared.isRecordVisible,
    extractionAnswerSchema: shared.extractionAnswerSchema,
    duplicateProposalSchema: shared.duplicateProposalSchema,
    mappingProposalSchema: shared.mappingProposalSchema,
    matchedEnds: rules.matchedEnds,
    proposedRecords: rules.proposedRecords,
    evaluateLinks: rules.evaluateLinks,
    linkProposal: rules.linkProposal,
    endsCoverSource: rules.endsCoverSource,
    identityOfLink: rules.identityOfLink,
    identityOfProposal: rules.identityOfProposal,
    isRefused: rules.isRefused,
    readDocument: (job) => readDocument(readerDeps, job),
    tokenizerProblem,
    tokenizerProblemIfAsked: () => (tokenizerChecked === undefined ? Promise.resolve(null) : tokenizerProblem()),
    writeLiveLinks: (orgId, view, source, links) => writeLiveLinks({ outbox }, orgId, view, source, links),
    isLinkEndsChanged: (err) => err instanceof LinkEndsChanged,
    uploaderView,
    duplicateFindingKey,
    mappingFindingKey,
    textModel: aiSettingsFromEnv({ AI_TEXT_MODEL: setting('AI_TEXT_MODEL') || undefined }).textModel,
    extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
    suggestPromptVersion: SUGGEST_PROMPT_VERSION,
  };
}

/** The fixed demo review data doesn't fit the fixed demo files or S4's schemas. Prints only the list,
 * the place in it and a fixed code, never a name or a sentence (D164). */
class DemoReviewError extends Error {
  constructor(
    readonly code: 'sentence_not_found' | 'bad_answer' | 'bad_proposal',
    readonly list: 'answers' | 'duplicates' | 'mappings',
    readonly index: number,
  ) {
    super(`demo review ${list} ${index}: ${code}`);
    this.name = 'DemoReviewError';
  }
}

function reviewProblem(err: DemoReviewError): string {
  const where = `demo review ${err.list} item ${err.index} (demo-intake/demo-review.ts)`;
  switch (err.code) {
    case 'sentence_not_found':
      return `${where} has a link whose sentence isn't in any chunk of its document.`;
    case 'bad_answer':
      return `${where} isn't an answer S4's extraction schema accepts.`;
    case 'bad_proposal':
      return `${where} makes a proposal S4's finding schemas refuse.`;
  }
}

const LABEL_ORDER: readonly Label[] = ['public', 'internal', 'confidential', 'restricted'];

function isKnownLabel(value: unknown): value is Label {
  return typeof value === 'string' && (LABEL_ORDER as readonly string[]).includes(value);
}

function higherOf(a: Label, b: Label): Label {
  return LABEL_ORDER.indexOf(a) >= LABEL_ORDER.indexOf(b) ? a : b;
}

/** Text with its spacing ignored, as S4's `same_sentence` check compares it. */
function squashSpacing(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

/** A record of the org's graph, found by one of its source IDs. */
interface FoundRecord {
  id: string;
  number: string;
  name: string;
  label: Label;
  status: string;
  owner: string;
}

function foundKey(kind: string, sourceId: string): string {
  return `${kind} ${sourceId}`;
}

function requirementKey(ref: DemoRequirementRef): string {
  return `${ref.framework} ${ref.code}`;
}

/** The records of these kinds carrying these source IDs, whatever their status, by `foundKey`. */
async function recordsBySourceId(
  svc: Services,
  orgId: string,
  wanted: readonly { kind: DemoReviewKind; sourceId: string }[],
): Promise<Map<string, FoundRecord>> {
  const out = new Map<string, FoundRecord>();
  const kinds = [...new Set(wanted.map((w) => w.kind))];
  for (const kind of kinds) {
    const sourceIds = [...new Set(wanted.filter((w) => w.kind === kind).map((w) => w.sourceId))];
    const rows = await svc.graph.read(orgId, async (tx) => {
      const res = await tx.run(
        `UNWIND $sourceIds AS sid
         MATCH (n:${NODE_LABEL[kind]}) WHERE sid IN n.sourceIds
         RETURN sid, n.id AS id, n.number AS number, n.name AS name, n.sensitivity AS label,
                n.status AS status, n.owner AS owner`,
        { sourceIds },
      );
      return res.records;
    });
    for (const row of rows) {
      const key = foundKey(kind, row.get('sid') as string);
      if (out.has(key)) continue;
      const label = row.get('label');
      out.set(key, {
        id: String(row.get('id')),
        number: String(row.get('number')),
        name: typeof row.get('name') === 'string' ? (row.get('name') as string) : '',
        // A node without a known label is invisible to every reader; treated as Restricted, as S4 does.
        label: isKnownLabel(label) ? label : 'restricted',
        status: String(row.get('status') ?? ''),
        owner: String(row.get('owner') ?? ''),
      });
    }
  }
  return out;
}

/** The catalog requirements with these framework keys and codes, whatever their status. */
async function requirementsByCode(
  svc: Services,
  orgId: string,
  wanted: readonly DemoRequirementRef[],
): Promise<Map<string, FoundRecord>> {
  const rows = await svc.graph.read(orgId, async (tx) => {
    const res = await tx.run(
      `UNWIND $wanted AS w
       MATCH (n:Requirement {framework: w.framework, code: w.code})
       RETURN w.framework + ' ' + w.code AS key, n.id AS id, n.number AS number, n.name AS name,
              n.sensitivity AS label, n.status AS status, n.owner AS owner
       ORDER BY CASE n.status WHEN 'active' THEN 0 ELSE 1 END`,
      { wanted: wanted.map((w) => ({ framework: w.framework, code: w.code })) },
    );
    return res.records;
  });
  const out = new Map<string, FoundRecord>();
  for (const row of rows) {
    const key = row.get('key') as string;
    if (out.has(key)) continue;
    const label = row.get('label');
    out.set(key, {
      id: String(row.get('id')),
      number: String(row.get('number')),
      name: typeof row.get('name') === 'string' ? (row.get('name') as string) : '',
      label: isKnownLabel(label) ? label : 'restricted',
      status: String(row.get('status') ?? ''),
      owner: String(row.get('owner') ?? ''),
    });
  }
  return out;
}

/** Every record the org's review data names by source ID, and every requirement by code. */
function wantedOf(review: DemoReview): {
  records: { kind: DemoReviewKind; sourceId: string }[];
  requirements: DemoRequirementRef[];
} {
  const records: { kind: DemoReviewKind; sourceId: string }[] = [];
  const requirements: DemoRequirementRef[] = [];
  for (const answer of review.answers) {
    for (const rec of answer.records) {
      const named =
        rec.match.outcome === 'clear'
          ? [rec.match.match]
          : rec.match.outcome === 'uncertain'
            ? rec.match.candidates
            : [];
      for (const m of named) records.push({ kind: rec.kind, sourceId: m.record });
    }
  }
  for (const d of review.duplicates) records.push({ kind: d.kind, sourceId: d.a }, { kind: d.kind, sourceId: d.b });
  for (const m of review.mappings) {
    if (m.type === 'SATISFIES') records.push({ kind: 'control', sourceId: m.control });
    else requirements.push(m.from);
    requirements.push(m.to);
  }
  return { records, requirements };
}

/** What the review step added in one org, and what waits for a later run. */
interface ReviewAdded {
  records: number;
  documentsRead: number;
  links: number;
  live: number;
  proposed: number;
  duplicates: number;
  mappings: number;
  /** Findings not added yet: a record, a readable document or the tokenizer they need is missing. */
  waiting: number;
}

interface ReviewContext {
  svc: Services;
  isvc: IntakeServices;
  rsvc: ReviewServices;
  orgId: string;
  found: Map<string, FoundRecord>;
  requirements: Map<string, FoundRecord>;
  added: ReviewAdded;
}

/** True when the database has the review migration's `review_findings.outcome` (and so the
 * processing migration's tables before it). Reads only the catalog, so it needs no org context. */
async function reviewTablesReady(db: ScriptDb): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(
      sql`SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'review_findings' AND column_name = 'outcome'
          ) AS ready`,
    );
    return found.rows[0]?.['ready'] === true;
  });
}

interface DocumentRow {
  status: string;
  label: Label;
  uploaderType: string;
  uploaderId: string;
}

async function documentRow(ctx: ReviewContext, documentId: string): Promise<DocumentRow | undefined> {
  return ctx.isvc.inSystemContext(ctx.orgId, async (tx) => {
    const found = await tx.execute(
      sql`SELECT status, label, uploader_type, uploader_id FROM documents
          WHERE org_id = ${ctx.orgId}::uuid AND id = ${documentId}::uuid`,
    );
    const row = found.rows[0];
    if (!row) return undefined;
    return {
      status: String(row['status']),
      label: isKnownLabel(row['label']) ? row['label'] : 'restricted',
      uploaderType: String(row['uploader_type']),
      uploaderId: String(row['uploader_id']),
    };
  });
}

interface ChunkRow {
  id: string;
  text: string;
  label: Label;
  recordType: string;
}

/** The document's chunks, in order. */
async function documentChunks(ctx: ReviewContext, documentId: string): Promise<ChunkRow[]> {
  return ctx.isvc.inSystemContext(ctx.orgId, async (tx) => {
    const found = await tx.execute(
      sql`SELECT id::text AS id, text, label, record_type FROM chunks
          WHERE org_id = ${ctx.orgId}::uuid AND document_id = ${documentId}::uuid
          ORDER BY position`,
    );
    return found.rows.map((row) => ({
      id: String(row['id']),
      text: String(row['text']),
      label: isKnownLabel(row['label']) ? row['label'] : 'restricted',
      recordType: String(row['record_type']),
    }));
  });
}

/** `[a, b]` as a JSON list, for `jsonb_array_elements_text`: one parameter for any number of values. */
function jsonList(values: readonly string[]): string {
  return JSON.stringify(values);
}

/** The finding keys among `keys` the org already has, whatever their status. */
async function existingKeys(ctx: ReviewContext, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  return ctx.isvc.inSystemContext(ctx.orgId, async (tx) => {
    const found = await tx.execute(
      sql`SELECT finding_key FROM review_findings
          WHERE org_id = ${ctx.orgId}::uuid
            AND finding_key IN (SELECT jsonb_array_elements_text(${jsonList(keys)}::jsonb))`,
    );
    return new Set(found.rows.map((row) => String(row['finding_key'])));
  });
}

/** What the Analyst refused (rejected, or removed once live) among the org's links of these types. */
async function refusedLinks(ctx: ReviewContext, types: readonly string[]): Promise<unknown[]> {
  if (types.length === 0) return [];
  const rows = await ctx.isvc.inSystemContext(ctx.orgId, async (tx) => {
    const found = await tx.execute(
      sql`SELECT proposal FROM review_findings
          WHERE org_id = ${ctx.orgId}::uuid AND kind = 'link' AND status IN ('rejected', 'removed')
            AND proposal ->> 'type' IN (SELECT jsonb_array_elements_text(${jsonList(types)}::jsonb))`,
    );
    return found.rows;
  });
  return rows.map((row) => ctx.rsvc.identityOfProposal(row['proposal'])).filter((identity) => identity !== null);
}

/** Locks the document's row for the rest of the transaction; its status then (undefined when gone). */
async function lockDocument(tx: ScriptTx, orgId: string, documentId: string, mode: 'update' | 'share') {
  const found = await tx.execute(
    mode === 'update'
      ? sql`SELECT status FROM documents WHERE org_id = ${orgId}::uuid AND id = ${documentId}::uuid FOR UPDATE`
      : sql`SELECT status FROM documents WHERE org_id = ${orgId}::uuid AND id = ${documentId}::uuid FOR SHARE`,
  );
  const status = found.rows[0]?.['status'];
  return typeof status === 'string' ? status : undefined;
}

/** One `review_findings` row as processing writes it (S4 shared notes, "`review_findings`"). */
interface FindingInsert {
  kind: 'link' | 'record' | 'duplicate' | 'mapping';
  status: 'pending' | 'live';
  key: string;
  proposal: object;
  documentId: string | null;
  chunkId: string | null;
  sentence: string | null;
  failedChecks: readonly string[];
  label: Label;
  model: string | null;
  promptVersion: string | null;
}

/** Adds the finding unless its key is there already (then nothing); answers the new row. */
async function insertFinding(
  tx: ScriptTx,
  orgId: string,
  f: FindingInsert,
): Promise<{ id: string; status: string } | undefined> {
  const added = await tx.execute(
    sql`INSERT INTO review_findings
          (org_id, kind, status, finding_key, proposal, document_id, chunk_id, sentence, failed_checks,
           label, model, prompt_version)
        VALUES (${orgId}::uuid, ${f.kind}, ${f.status}, ${f.key}, ${JSON.stringify(f.proposal)}::jsonb,
                ${f.documentId}::uuid, ${f.chunkId}::uuid, ${f.sentence},
                ARRAY(SELECT jsonb_array_elements_text(${jsonList(f.failedChecks)}::jsonb)),
                ${f.label}, ${f.model}, ${f.promptVersion})
        ON CONFLICT (org_id, finding_key) DO NOTHING
        RETURNING id::text AS id, status`,
  );
  const row = added.rows[0];
  return row ? { id: String(row['id']), status: String(row['status']) } : undefined;
}

/**
 * What a name of the answer means, as S4-007's matcher would answer in the uploader's view: only
 * active records the uploader could see are matched (D51), each scored as its step scores it (the
 * same name 1, a close spelling by `editSimilarity`, a close meaning as the data gives it). Null
 * when a record it names isn't in the org at all yet (the links naming it wait for a later run).
 */
function nameMatchOf(ctx: ReviewContext, rec: DemoAnswerRecord, view: MatchView | null): NameMatch | null {
  const { rsvc } = ctx;
  const m = rec.match;
  if (m.outcome === 'none') return { outcome: 'none' };
  const seen = (matched: DemoMatched): { label: Label; candidate: MatchCandidate } | 'missing' | 'unseen' => {
    const r = ctx.found.get(foundKey(rec.kind, matched.record));
    if (!r) return 'missing';
    const isOwner = view !== null && typeof view.userId === 'string' && view.userId !== '' && r.owner === view.userId;
    if (
      r.status !== 'active' ||
      !view ||
      !rsvc.isRecordVisible(view, { recordType: rec.kind, label: r.label, isOwner })
    ) {
      return 'unseen';
    }
    const score =
      matched.step === 'meaning' ? matched.score : matched.step === 'exact' ? 1 : rsvc.editSimilarity(rec.name, r.name);
    return { label: r.label, candidate: { recordId: r.id, number: r.number, name: r.name, step: matched.step, score } };
  };
  if (m.outcome === 'clear') {
    const s = seen(m.match);
    if (s === 'missing') return null;
    return s === 'unseen' ? { outcome: 'none' } : { outcome: 'clear', match: s.candidate, label: s.label };
  }
  const kept: { label: Label; candidate: MatchCandidate }[] = [];
  for (const c of m.candidates) {
    const s = seen(c);
    if (s === 'missing') return null;
    // A merged-away record's source IDs move to the one kept: the same record is one candidate.
    if (s !== 'unseen' && !kept.some((k) => k.candidate.recordId === s.candidate.recordId)) kept.push(s);
  }
  if (kept.length === 0) return { outcome: 'none' };
  return {
    outcome: 'uncertain',
    candidates: kept.map((k) => k.candidate),
    label: kept.map((k) => k.label).reduce(higherOf),
  };
}

/** A link that passed every rule check, both ends clear, whose document everyone who sees both ends
 * may see (D51), as a live link to write (S4-008's `toWrite`); none for any other. */
function liveWriteOf(rsvc: ReviewServices, link: EvaluatedLink, source: { recordType: string; label: Label }) {
  const from = link.from.match;
  const to = link.to.match;
  if (link.failed.length > 0 || !from || !to) return [];
  if (
    !rsvc.endsCoverSource(source, { kind: link.from.kind, label: from.label }, { kind: link.to.kind, label: to.label })
  ) {
    return [];
  }
  const write: LiveLinkWrite = {
    key: link.key,
    type: link.type,
    from: { kind: link.from.kind, id: from.recordId },
    to: { kind: link.to.kind, id: to.recordId },
    sentence: link.sentence,
  };
  return [write];
}

/**
 * One chunk's share of a document's answer, decided as S4-008 decides a chunk Gemma has read: the
 * rule checks, without the links the Analyst refused before; the confident links made live in one
 * Neo4j transaction with their `link.created` entries, while the document's row is held shared
 * and isn't removed; then, in one Postgres transaction holding the document's row, the proposed
 * records' findings and the links' findings (`live` for one made live, else `pending`).
 */
async function seedChunkAnswer(
  ctx: ReviewContext,
  index: number,
  doc: DocumentRow & { id: string },
  chunk: ChunkRow,
  records: readonly AnswerRecord[],
  matches: readonly NameMatch[],
  links: readonly AnswerLink[],
  view: MatchView | null,
): Promise<void> {
  const { rsvc, orgId, added } = ctx;
  if (!rsvc.extractionAnswerSchema.safeParse({ records, links }).success) {
    throw new DemoReviewError('bad_answer', 'answers', index);
  }
  const ends = rsvc.matchedEnds(doc.id, records, matches);
  const proposed = rsvc.proposedRecords(records, ends);
  const label = higherOf(chunk.label, doc.label);
  const evaluated = rsvc.evaluateLinks({ chunkId: chunk.id, chunkText: chunk.text, documentLabel: label, links, ends });
  const refused = await refusedLinks(ctx, [...new Set(evaluated.map((l) => l.type))]);
  const kept = evaluated.filter((link) => !rsvc.isRefused(rsvc.identityOfLink(link), refused));

  // A link whose finding is already there was decided (or made live) before: never written again.
  const known = await existingKeys(
    ctx,
    kept.map((l) => l.key),
  );
  const source = { recordType: chunk.recordType, label };
  const confident = kept.filter((l) => !known.has(l.key)).flatMap((l) => liveWriteOf(rsvc, l, source));
  const model = rsvc.textModel;
  const promptVersion = rsvc.extractionPromptVersion;
  let outcomes = new Map<string, LiveLinkOutcome>();
  if (view !== null && confident.length > 0) {
    const liveSource: LiveLinkSource = {
      documentId: doc.id,
      chunkId: chunk.id,
      model,
      promptVersion,
      sourceLabel: label,
      sourceRecordType: chunk.recordType,
    };
    try {
      const written = await ctx.isvc.inSystemContext(orgId, async (tx) => {
        const status = await lockDocument(tx, orgId, doc.id, 'share');
        if (status === undefined || status === 'removed') return null;
        return rsvc.writeLiveLinks(orgId, view, liveSource, confident);
      });
      if (written === null) return;
      outcomes = written;
    } catch (err) {
      // A record changed since it was matched (S4 runs the chunk again later): left for a later run.
      if (!rsvc.isLinkEndsChanged(err)) throw err;
      added.waiting += kept.length;
      return;
    }
  }

  const saved = await ctx.isvc.inSystemContext(orgId, async (tx) => {
    const status = await lockDocument(tx, orgId, doc.id, 'update');
    if (status === undefined || status === 'removed') return null;
    const ids = new Map<string, string>();
    let proposedAdded = 0;
    for (const p of proposed) {
      const row = await insertFinding(tx, orgId, {
        kind: 'record',
        status: 'pending',
        key: p.key,
        proposal: p.proposal,
        documentId: doc.id,
        chunkId: chunk.id,
        sentence: null,
        failedChecks: [],
        label,
        model,
        promptVersion,
      });
      if (row) {
        ids.set(p.key, row.id);
        proposedAdded += 1;
      }
    }
    // Proposed before (by this chunk or another of the document): point to that finding.
    const missing = proposed.map((p) => p.key).filter((key) => !ids.has(key));
    if (missing.length > 0) {
      const found = await tx.execute(
        sql`SELECT id::text AS id, finding_key FROM review_findings
            WHERE org_id = ${orgId}::uuid
              AND finding_key IN (SELECT jsonb_array_elements_text(${jsonList(missing)}::jsonb))`,
      );
      for (const row of found.rows) ids.set(String(row['finding_key']), String(row['id']));
    }
    let linksAdded = 0;
    let liveAdded = 0;
    for (const link of kept) {
      const proposal = rsvc.linkProposal(link, ids);
      if (!proposal) throw new DemoReviewError('bad_proposal', 'answers', index);
      const outcome = outcomes.get(link.key);
      const row = await insertFinding(tx, orgId, {
        kind: 'link',
        status: outcome === 'created' || outcome === 'ours' ? 'live' : 'pending',
        key: link.key,
        proposal,
        documentId: doc.id,
        chunkId: chunk.id,
        sentence: link.sentence,
        failedChecks: link.failed,
        label: link.label,
        model,
        promptVersion,
      });
      if (row) {
        linksAdded += 1;
        if (row.status === 'live') liveAdded += 1;
      }
    }
    return { proposedAdded, linksAdded, liveAdded };
  });
  if (!saved) return;
  added.proposed += saved.proposedAdded;
  added.links += saved.linksAdded;
  added.live += saved.liveAdded;
}

/**
 * One demo document's answer: its document (found by the demo file's content hash), its chunks
 * (stored here the way S4's reader stores them, if it has none yet), what each name means in the
 * uploader's view, and each chunk's share of the answer (the links whose sentence it holds).
 */
async function seedDocumentAnswer(ctx: ReviewContext, index: number, answer: DemoDocumentAnswer): Promise<void> {
  const { orgId, added, rsvc } = ctx;
  const documentId = await documentWithContent(ctx.isvc, orgId, sha256Hex(demoIntakeFile(answer.document)));
  if (documentId === undefined) {
    added.waiting += answer.links.length;
    return;
  }
  const row = await documentRow(ctx, documentId);
  // A removed upload is never processed again (S5-004, D52.5).
  if (!row || row.status === 'removed') return;
  const doc = { ...row, id: documentId };

  let chunks = await documentChunks(ctx, documentId);
  if (chunks.length === 0) {
    // Only a stored document is read; one that failed keeps its findings back.
    if ((doc.status !== 'stored' && doc.status !== 'processing') || (await rsvc.tokenizerProblem()) !== null) {
      added.waiting += answer.links.length;
      return;
    }
    const read = await rsvc.readDocument({ orgId, documentId });
    if (read.status === 'processing') added.documentsRead += 1;
    chunks = await documentChunks(ctx, documentId);
    if (chunks.length === 0) {
      added.waiting += answer.links.length;
      return;
    }
  }

  const view = await ctx.isvc.inSystemContext(orgId, (tx) =>
    rsvc.uploaderView(tx, { orgId, uploaderType: doc.uploaderType, uploaderId: doc.uploaderId }),
  );
  const matches = new Map<string, NameMatch>();
  for (const rec of answer.records) {
    const m = nameMatchOf(ctx, rec, view);
    if (m !== null) matches.set(rec.ref, m);
  }

  // Each link goes with the first chunk whose text holds its whole sentence (spacing ignored).
  const byChunk = new Map<string, AnswerLink[]>();
  for (const link of answer.links) {
    if (!matches.has(link.from) || !matches.has(link.to)) {
      added.waiting += 1;
      continue;
    }
    const sentence = squashSpacing(link.sentence);
    const chunk = chunks.find((c) => squashSpacing(c.text).includes(sentence));
    if (!chunk) throw new DemoReviewError('sentence_not_found', 'answers', index);
    const list = byChunk.get(chunk.id) ?? [];
    list.push({ type: link.type, from: link.from, to: link.to, sentence: link.sentence });
    byChunk.set(chunk.id, list);
  }
  for (const chunk of chunks) {
    const links = byChunk.get(chunk.id);
    if (!links) continue;
    const refs = new Set(links.flatMap((l) => [l.from, l.to]));
    const named = answer.records.filter((r) => refs.has(r.ref));
    const records: AnswerRecord[] = named.map((r) => ({
      ref: r.ref,
      kind: r.kind,
      name: r.name,
      ...(r.details !== undefined ? { details: r.details } : {}),
    }));
    await seedChunkAnswer(
      ctx,
      index,
      doc,
      chunk,
      records,
      named.map((r) => matches.get(r.ref)!),
      links,
      view,
    );
  }
}

/** The possible duplicate pairs, as S4-007 flags them (close spelling): kept is the older record. */
async function seedDuplicates(ctx: ReviewContext, review: DemoReview): Promise<void> {
  const { rsvc, orgId, added } = ctx;
  for (const [index, d] of review.duplicates.entries()) {
    const a = ctx.found.get(foundKey(d.kind, d.a));
    const b = ctx.found.get(foundKey(d.kind, d.b));
    if (!a || !b) {
      added.waiting += 1;
      continue;
    }
    // Merged into one already, or one is retired: nothing left to ask.
    if (a.id === b.id || a.status !== 'active' || b.status !== 'active') continue;
    const [kept, other] = a.number <= b.number ? [a, b] : [b, a];
    const proposal = {
      kind: d.kind,
      kept: { recordId: kept.id, number: kept.number },
      other: { recordId: other.id, number: other.number },
      step: 'spelling',
      score: rsvc.editSimilarity(a.name, b.name),
    };
    if (!rsvc.duplicateProposalSchema.safeParse(proposal).success) {
      throw new DemoReviewError('bad_proposal', 'duplicates', index);
    }
    const row = await ctx.isvc.inSystemContext(orgId, (tx) =>
      insertFinding(tx, orgId, {
        kind: 'duplicate',
        status: 'pending',
        key: rsvc.duplicateFindingKey(d.kind, a.id, b.id),
        proposal,
        documentId: null,
        chunkId: null,
        sentence: null,
        failedChecks: [],
        label: higherOf(a.label, b.label),
        model: null,
        promptVersion: null,
      }),
    );
    if (row) added.duplicates += 1;
  }
}

/** The suggested mappings, as S4-009 leaves them: never for a pair already linked. */
async function seedMappingSuggestions(ctx: ReviewContext, review: DemoReview): Promise<void> {
  const { rsvc, orgId, added, svc } = ctx;
  for (const [index, m] of review.mappings.entries()) {
    const from =
      m.type === 'SATISFIES'
        ? ctx.found.get(foundKey('control', m.control))
        : ctx.requirements.get(requirementKey(m.from));
    const to = ctx.requirements.get(requirementKey(m.to));
    if (!from || !to) {
      added.waiting += 1;
      continue;
    }
    if (from.status !== 'active' || to.status !== 'active') continue;
    const key = rsvc.mappingFindingKey(m.type, from.id, to.id);
    if ((await existingKeys(ctx, [key])).size > 0) continue;
    const linked = await graphHas(
      svc,
      orgId,
      m.type === 'SATISFIES'
        ? 'MATCH (:Control {id: $fromId})-[r:SATISFIES]->(:Requirement {id: $toId}) RETURN count(r) > 0 AS there'
        : 'MATCH (:Requirement {id: $fromId})-[r:MAPS_TO]-(:Requirement {id: $toId}) RETURN count(r) > 0 AS there',
      { fromId: from.id, toId: to.id },
    );
    if (linked) continue;
    const proposal = {
      type: m.type,
      from: { recordId: from.id, number: from.number },
      to: { recordId: to.id, number: to.number },
      reason: m.reason,
    };
    if (!rsvc.mappingProposalSchema.safeParse(proposal).success) {
      throw new DemoReviewError('bad_proposal', 'mappings', index);
    }
    const row = await ctx.isvc.inSystemContext(orgId, (tx) =>
      insertFinding(tx, orgId, {
        kind: 'mapping',
        status: 'pending',
        key,
        proposal,
        documentId: null,
        chunkId: null,
        sentence: null,
        failedChecks: [],
        label: higherOf(from.label, to.label),
        model: rsvc.textModel,
        promptVersion: rsvc.suggestPromptVersion,
      }),
    );
    if (row) added.mappings += 1;
  }
}

// Adds the org's demo review findings that aren't there yet (see the top of the file).
async function seedReview(
  svc: Services,
  isvc: IntakeServices,
  rsvc: ReviewServices,
  admin: Caller,
  review: DemoReview,
  userOf: (role: string) => string,
): Promise<ReviewAdded> {
  const orgId = admin.orgId;
  const added: ReviewAdded = {
    records: 0,
    documentsRead: 0,
    links: 0,
    live: 0,
    proposed: 0,
    duplicates: 0,
    mappings: 0,
    waiting: 0,
  };
  added.records = (await seedRecords(svc, admin, { records: review.records, links: [] }, userOf)).records;
  const wanted = wantedOf(review);
  const ctx: ReviewContext = {
    svc,
    isvc,
    rsvc,
    orgId,
    found: await recordsBySourceId(svc, orgId, wanted.records),
    requirements: await requirementsByCode(svc, orgId, wanted.requirements),
    added,
  };
  for (const [index, answer] of review.answers.entries()) await seedDocumentAnswer(ctx, index, answer);
  await seedDuplicates(ctx, review);
  await seedMappingSuggestions(ctx, review);
  return added;
}

/** One line about the review step: counts only. */
function reviewLine(r: ReviewAdded): string {
  const line =
    `  review records added: ${r.records}; documents read into chunks: ${r.documentsRead}; review findings added: ` +
    `links ${r.links} (live ${r.live}), new records ${r.proposed}, possible duplicates ${r.duplicates}, ` +
    `suggested mappings ${r.mappings}`;
  return r.waiting > 0 ? `${line}; waiting for what they need: ${r.waiting} (run seed:demo again later)` : line;
}

// ---- S6-008: every demo document's passages, for search and chat ----

/** What the search step did in one org. */
interface SearchAdded {
  /** Demo documents read into chunks by this run. */
  documentsRead: number;
  /** Demo documents with no chunks yet that this run could not read: not uploaded, or no tokenizer. */
  waiting: number;
  /** Demo documents that ended `failed` (unreadable), here or before: never read again. */
  failed: number;
}

/** The document's status and whether it has any chunk yet; undefined when it isn't there. */
async function documentChunkState(
  isvc: IntakeServices,
  orgId: string,
  documentId: string,
): Promise<{ status: string; hasChunks: boolean } | undefined> {
  return isvc.inSystemContext(orgId, async (tx) => {
    const found = await tx.execute(
      sql`SELECT d.status,
                 EXISTS (SELECT 1 FROM chunks c WHERE c.org_id = d.org_id AND c.document_id = d.id) AS has_chunks
          FROM documents d
          WHERE d.org_id = ${orgId}::uuid AND d.id = ${documentId}::uuid`,
    );
    const row = found.rows[0];
    if (!row) return undefined;
    return { status: String(row['status']), hasChunks: row['has_chunks'] === true };
  });
}

/**
 * Makes sure every demo document (the policy documents and the SOC ticket file uploaded by the S3
 * step) has its chunks, so each demo question of docs/demo/s6.md finds its passages once the worker
 * has embedded them. The review step already read the documents its findings come from; this reads
 * the others (the Confidential policy documents) the same way, with S4's reader (`readDocument`:
 * the stored file read in the file sandbox, the same chunker, the document moved to `processing` and
 * its embed job queued for the worker). No Gemma and no bge-m3 call: the worker embeds the chunks
 * when it runs (D82). Only a `stored` or `processing` document with no chunk at all is read; one
 * already read, processed, failed or removed (S5-004) is left alone, so a re-run adds nothing.
 */
async function seedSearchChunks(
  isvc: IntakeServices,
  rsvc: ReviewServices,
  orgId: string,
  data: DemoIntake,
): Promise<SearchAdded> {
  const added: SearchAdded = { documentsRead: 0, waiting: 0, failed: 0 };
  for (const doc of data.documents) {
    const documentId = await documentWithContent(isvc, orgId, sha256Hex(demoIntakeFile(doc.file)));
    if (documentId === undefined) {
      added.waiting += 1;
      continue;
    }
    const state = await documentChunkState(isvc, orgId, documentId);
    if (!state || state.hasChunks) continue;
    if (state.status === 'failed') {
      added.failed += 1;
      continue;
    }
    if (state.status !== 'stored' && state.status !== 'processing') continue;
    if ((await rsvc.tokenizerProblem()) !== null) {
      added.waiting += 1;
      continue;
    }
    const read = await rsvc.readDocument({ orgId, documentId });
    if (read.status === 'processing') added.documentsRead += 1;
    else if (read.status === 'failed') added.failed += 1;
  }
  return added;
}

/** One line about the search step: counts only. */
function searchLine(s: SearchAdded): string {
  let line = `  search: demo documents read into chunks: ${s.documentsRead}`;
  if (s.waiting > 0) line += `; waiting to be read: ${s.waiting} (run seed:demo again later)`;
  if (s.failed > 0) line += `; could not be read (Failed in Data intake): ${s.failed}`;
  return line;
}

const conn = await connect();
let intake: IntakeServices | undefined;
try {
  const svc = await services(conn.deps);
  const isvc = await intakeServices(conn.deps, svc.outbox);
  intake = isvc;
  const rsvc = await reviewServices(conn.deps, svc.outbox, isvc.jobs);
  // The review step needs the processing and review migrations; without them every other step still runs.
  const reviewReady = await reviewTablesReady(conn.deps.db);
  const lines: string[] = [];
  for (const org of ORGS) {
    const slug = suffix === '' ? org.slug : `${org.slug}-${suffix}`;
    const people = PEOPLE.map((p) => ({ ...p, email: `${p.local}@${org.domain}`, name: `${p.name} (${org.name})` }));
    const admin = people.find((p) => p.role === 'admin')!;
    const { orgId } = await provisioning.provisionOrg(
      { name: org.name, slug, admin: { email: admin.email, name: admin.name } },
      { ...conn.deps, outbox: svc.outbox, catalogs: svc.catalogs },
    );
    lines.push('', `${org.name} (${slug}), org ID ${orgId}`);
    const userIds = new Map<string, string>();
    for (const person of people) {
      userIds.set(person.role, await addPerson(conn.deps.db, orgId, person, await hashPassword(password)));
      lines.push(`  ${person.email.padEnd(36)} ${person.role.padEnd(20)} ${person.clearance}`);
    }
    const userOf = (role: string): string => {
      const id = userIds.get(role);
      if (!id) throw new Error(`no demo user for role ${role}`);
      return id;
    };
    // The links step reads as the Admin's role x clearance account, whose password derives from it.
    if (!setting('NEO4J_QUERY_SECRET')) {
      throw new MissingSetting('NEO4J_QUERY_SECRET');
    }
    const caller: Caller = { orgId, userId: userOf('admin'), role: 'admin', clearance: 'restricted' };
    const added = await seedRecords(svc, caller, DEMO_DATA[org.slug]!, userOf);
    lines.push(`  records added: ${added.records}, links added: ${added.links}`);
    // S2-008: the catalogs (already loaded by provisioning, so normally nothing changes), then the
    // demo mappings.
    const catalogs = await svc.loadCatalogs(orgId);
    const mapped = await seedMappings(svc, caller, DEMO_MAPPINGS[org.slug]!);
    lines.push(
      `  framework catalogs: ${catalogs.frameworks.length} frameworks, items added ${total(catalogs, 'added')}, ` +
        `updated ${total(catalogs, 'updated')}, retired ${total(catalogs, 'retired')}; mappings added: ${mapped}`,
    );
    // S3-020: the uploads, the asset import, the evidence and the audit findings.
    const callerOf = (role: DemoIntakeRole): Caller => {
      const person = PEOPLE.find((p) => p.role === role);
      if (!person) throw new Error(`no demo user for role ${role}`);
      return { orgId, userId: userOf(role), role, clearance: person.clearance };
    };
    const fed = await seedIntake(svc, isvc, conn.deps.db, DEMO_INTAKE[org.slug]!, callerOf, userOf);
    lines.push(
      `  uploads added: ${fed.uploads}; ${importLine(fed.assetImport)}; evidence added: ${fed.evidence}, ` +
        `audit findings added: ${fed.findings}`,
    );
    // S5-007: the review findings, with the few records they need.
    if (reviewReady) {
      const reviewed = await seedReview(svc, isvc, rsvc, caller, DEMO_REVIEW[org.slug]!, userOf);
      lines.push(reviewLine(reviewed));
      // S6-008: the rest of the demo documents read into chunks, for search and chat.
      lines.push(searchLine(await seedSearchChunks(isvc, rsvc, orgId, DEMO_INTAKE[org.slug]!)));
    } else {
      lines.push('  review findings: not added (the review migrations are not applied)');
      lines.push('  search: demo documents not read into chunks (the processing migration is not applied)');
    }
  }
  console.log('Demo logins (every user signs in with the DEMO_USER_PASSWORD value from .env):');
  console.log(lines.join('\n'));
  if (!reviewReady) {
    console.error(
      "seed:demo: the database doesn't have the review tables yet: the processing and review migrations " +
        "aren't applied. Apply the migrations, then run it again: it adds the review findings and reads the " +
        'demo documents into chunks.',
    );
    process.exitCode = 1;
  }
  // Like the worker, the seed names the command that sets bge-m3's tokenizer up; the findings that
  // need the documents' chunks are added by the next run.
  const tokenizerProblem = await rsvc.tokenizerProblemIfAsked();
  if (tokenizerProblem !== null) {
    console.error(`seed:demo: ${tokenizerProblem}`);
    console.error(
      'seed:demo: the demo documents could not be read into chunks, so their review findings and search ' +
        'passages were not added; run seed:demo again once that is done: it adds them.',
    );
    process.exitCode = 1;
  }
} catch (err) {
  if (err instanceof MissingSetting) {
    console.error(`seed:demo: missing setting (environment or .env): ${err.setting}. The records were not added.`);
  } else if (err instanceof DemoDataError) {
    const thing = err.code === 'unknown_control' ? 'a control' : 'an active requirement';
    console.error(
      `seed:demo: demo mapping ${err.index} (demo-mappings.ts) names ${thing} the org's graph doesn't hold.`,
    );
  } else if (err instanceof DemoIntakeError) {
    console.error(`seed:demo: ${intakeProblem(err)}`);
  } else if (err instanceof DemoReviewError) {
    console.error(`seed:demo: ${reviewProblem(err)}`);
  } else {
    console.error(`seed:demo: failed: ${describeError(err)}`);
  }
  console.error('seed:demo: fix the cause and run it again; it finishes the missing steps.');
  process.exitCode = 1;
} finally {
  await intake?.jobs.close();
  await conn.close();
}
