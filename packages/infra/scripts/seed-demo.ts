// `pnpm seed:demo` (M0-014, D114): the checkpoint demo. Two orgs, each made by provisionOrg, with
// one user per role (7) at mixed clearances, the Admin at `restricted`. It prints a login list.
// - Every demo user signs in with the password in DEMO_USER_PASSWORD (environment or `.env`;
//   `pnpm setup:secrets` fills it). It is stored hashed in a Better Auth `credential` account and
//   never printed. Under 12 characters (D49) the seed stops before creating anything.
// - Safe to re-run: the orgs, users and members are found again, not duplicated.
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, missingSettings, provisioning, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;

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
const missing = missingSettings();
if (missing.length > 0) {
  console.error(`seed:demo: missing settings (environment or .env): ${missing.join(', ')}. Nothing was created.`);
  process.exit(2);
}

const sql = await sqlTag();

// Adds the user (found by email) to the org with this role and clearance, unless they are
// already a member, and sets their demo password.
async function addPerson(
  db: ScriptDb,
  orgId: string,
  person: { email: string; name: string; role: Role; clearance: Label },
  hash: string,
): Promise<void> {
  await db.transaction(async (tx) => {
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
  });
}

const conn = await connect();
try {
  const lines: string[] = [];
  for (const org of ORGS) {
    const people = PEOPLE.map((p) => ({ ...p, email: `${p.local}@${org.domain}`, name: `${p.name} (${org.name})` }));
    const admin = people.find((p) => p.role === 'admin')!;
    const { orgId } = await provisioning.provisionOrg(
      { name: org.name, slug: org.slug, admin: { email: admin.email, name: admin.name } },
      conn.deps,
    );
    lines.push('', `${org.name} (${org.slug}), org ID ${orgId}`);
    for (const person of people) {
      await addPerson(conn.deps.db, orgId, person, await hashPassword(password));
      lines.push(`  ${person.email.padEnd(36)} ${person.role.padEnd(20)} ${person.clearance}`);
    }
  }
  console.log('Demo logins (every user signs in with the DEMO_USER_PASSWORD value from .env):');
  console.log(lines.join('\n'));
} catch (err) {
  console.error(`seed:demo: failed: ${describeError(err)}`);
  console.error('seed:demo: fix the cause and run it again; it finishes the missing steps.');
  process.exitCode = 1;
} finally {
  await conn.close();
}
