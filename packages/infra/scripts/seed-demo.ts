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
// - DEMO_ORG_SLUG_SUFFIX (optional, lowercase letters and digits) makes each slug
//   `<slug>-<suffix>`. The org IDs come from the slugs, so tests use it to stay off the live demo
//   orgs (D176).
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { basename } from 'node:path';
import type { DemoAssetList, DemoIntake, DemoIntakeRole } from './demo-intake/demo-intake.js';
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

const conn = await connect();
let intake: IntakeServices | undefined;
try {
  const svc = await services(conn.deps);
  const isvc = await intakeServices(conn.deps, svc.outbox);
  intake = isvc;
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
  }
  console.log('Demo logins (every user signs in with the DEMO_USER_PASSWORD value from .env):');
  console.log(lines.join('\n'));
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
  } else {
    console.error(`seed:demo: failed: ${describeError(err)}`);
  }
  console.error('seed:demo: fix the cause and run it again; it finishes the missing steps.');
  process.exitCode = 1;
} finally {
  await intake?.jobs.close();
  await conn.close();
}
