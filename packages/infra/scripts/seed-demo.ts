// `pnpm seed:demo` (M0-014, D114): the checkpoint demo. Two orgs, each made by provisionOrg, with
// one user per role (7) at mixed clearances, the Admin at `restricted`. It prints a login list.
// - Every demo user signs in with the password in DEMO_USER_PASSWORD (environment or `.env`;
//   `pnpm setup:secrets` fills it). It is stored hashed in a Better Auth `credential` account and
//   never printed. Under 12 characters (D49) the seed stops before creating anything.
// - Safe to re-run: the orgs, users and members are found again, not duplicated.
// - Then (S1-010) each org's fixed records and links (demo-records.ts), added as the org's Admin
//   through RecordsService and LinksService, so each one is audited like any change (D37, D45.4).
//   Every record carries a fixed source ID, so a re-run finds it and adds nothing (D45.5).
// - DEMO_ORG_SLUG_SUFFIX (optional, lowercase letters and digits) makes each slug
//   `<slug>-<suffix>`. The org IDs come from the slugs, so tests use it to stay off the live demo
//   orgs (D176).
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import type { DemoData, DemoKind } from './demo-records.js';
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, provisioning, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
const { DEMO_DATA, demoSourceId } = (await import(
  new URL('./demo-records.ts', import.meta.url).href
)) as typeof import('./demo-records.js');

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
interface Services {
  graph: Graph;
  records: RecordsApi;
  links: LinksApi;
}

async function services(deps: { db: ScriptDb; graph: unknown }): Promise<Services> {
  const { AuditOutbox } = await load<{ AuditOutbox: new (graph: unknown) => object }>('audit/outbox.ts');
  const { RecordsService } = await load<{ RecordsService: new (d: object) => RecordsApi }>(
    'records/records.service.ts',
  );
  const { LinksService } = await load<{ LinksService: new (d: object) => LinksApi }>('records/links.service.ts');
  const outbox = new AuditOutbox(deps.graph);
  return {
    graph: deps.graph as Graph,
    records: new RecordsService({ graph: deps.graph, outbox, db: deps.db }),
    links: new LinksService({ graph: deps.graph, outbox }),
  };
}

/** A setting the records step needs is missing; its name is safe to print. */
class MissingSetting extends Error {
  constructor(readonly setting: string) {
    super(`missing setting ${setting}`);
    this.name = 'MissingSetting';
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

const conn = await connect();
try {
  const svc = await services(conn.deps);
  const lines: string[] = [];
  for (const org of ORGS) {
    const slug = suffix === '' ? org.slug : `${org.slug}-${suffix}`;
    const people = PEOPLE.map((p) => ({ ...p, email: `${p.local}@${org.domain}`, name: `${p.name} (${org.name})` }));
    const admin = people.find((p) => p.role === 'admin')!;
    const { orgId } = await provisioning.provisionOrg(
      { name: org.name, slug, admin: { email: admin.email, name: admin.name } },
      conn.deps,
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
  }
  console.log('Demo logins (every user signs in with the DEMO_USER_PASSWORD value from .env):');
  console.log(lines.join('\n'));
} catch (err) {
  if (err instanceof MissingSetting) {
    console.error(`seed:demo: missing setting (environment or .env): ${err.setting}. The records were not added.`);
  } else {
    console.error(`seed:demo: failed: ${describeError(err)}`);
  }
  console.error('seed:demo: fix the cause and run it again; it finishes the missing steps.');
  process.exitCode = 1;
} finally {
  await conn.close();
}
