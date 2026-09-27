// Shared set-up for the M0-014 org-provisioning tests (D4, D22, D45.5, D53, D57, D73, D114, D133).
//
// Contract these tests hold the code to (TASKS.md, brief M0-014):
// - `src/identity/provision-org.ts` exports
//     provisionOrg(input: { name, slug, admin: { email, name } }, deps): Promise<{ orgId }>
//   where `deps` is
//     { db: Db,        // grc_app (createDb over DATABASE_URL_APP): org rows, the first Admin, the audit event
//       migrator: Db,  // grc_migrator (DATABASE_URL_MIGRATE): createAuditPartition (M0-012)
//       graph: { createOrgDatabase(orgId): Promise<void> },  // GraphService (M0-004)
//       files: { ensureBucket(orgId): Promise<void> } }      // FileStore (M0-006)
//   - `orgId` is a lowercase UUID.
//   - One call creates: the `organization` row (name, slug), its audit partition, `org-<orgId>` in
//     Neo4j, `grc-org-<orgId>` in storage, and the first Admin: a `user` row (email, name) and a
//     `member` row with role `admin` and clearance `restricted`. The first Admin has no password
//     yet (no `account` row with a password) and no MFA (`two_factor_enabled` not true, no
//     `two_factor` row), so both are set at first sign-in.
//   - One `org.created` audit event in the new org's chain, and the chain verifies.
//   - The slug names the org: calling again with the same slug returns the same orgId, finishes
//     any missing step, and duplicates nothing (one org row, one Admin, one org.created event).
// - Root script `pnpm org:create --name … --slug … --admin-email … --admin-name …` (D133,
//   `packages/infra/scripts/create-org.ts`) calls provisionOrg and prints the new org ID. Missing
//   or invalid arguments (empty values, a slug that isn't lowercase letters, digits and single
//   hyphens, an email without `@` and a domain) exit non-zero, name the bad flag, and create nothing.
// - Root script `pnpm seed:demo` (`packages/infra/scripts/seed-demo.ts`) creates two orgs, each
//   with one user per role (7 users), at mixed clearances (the Admin at `restricted`), and prints
//   a login list with every demo email. All demo users share the password in `DEMO_USER_PASSWORD`
//   (from the environment or `.env`; a name with PASSWORD, so `pnpm setup:secrets` fills it). It is
//   stored hashed in a Better Auth `credential` account and never printed. A password shorter than
//   12 characters (D49) makes the seed exit non-zero and create nothing. Re-running is safe.
// - Both scripts read their settings from the environment first, then `.env`: DATABASE_URL_APP,
//   DATABASE_URL_MIGRATE, NEO4J_URI, NEO4J_ADMIN_PASSWORD, NEO4J_WRITER_PASSWORD, S3_ENDPOINT,
//   S3_ACCESS_KEY, S3_SECRET_KEY (and DEMO_USER_PASSWORD for the seed). The tests point them at a
//   throwaway Postgres database, Neo4j Desktop and the dev-switch SeaweedFS.
//
// Throwaway data (D82): each test file makes its own `test-…` Postgres database. Every org in it is
// cleaned up in afterAll: its `org-<orgId>` Neo4j database is dropped and its bucket emptied and
// deleted, so the tests leave nothing behind.
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appUrl, closeDb, migrateUrl, rows, type Db } from '../db/helpers.js';
import { ROOT, databaseStatuses, dropDatabases, graphTestEnv, superDriver } from '../graph/helpers.js';
import { setUpWall, tearDownWall, type Wall } from '../org-wall/helpers.js';
import { bucketFor, liveConfig } from '../storage/helpers.js';

export { ROLES, LABELS, type Role, type Label } from '../org-wall/helpers.js';

export const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProvisionInput {
  name: string;
  slug: string;
  admin: { email: string; name: string };
}

export interface ProvisionDeps {
  db: Db;
  migrator: Db;
  graph: { createOrgDatabase(orgId: string): Promise<void> };
  files: { ensureBucket(orgId: string): Promise<void> };
}

export type ProvisionOrg = (input: ProvisionInput, deps: ProvisionDeps) => Promise<{ orgId: string }>;

interface AuditLike {
  verifyChain(orgId: string): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }>;
}

// Loaded inside the tests, so a missing module fails each test with a message naming the file.
export async function loadProvisionOrg(): Promise<ProvisionOrg> {
  const mod = (await import('../../src/identity/provision-org.js')) as unknown as Record<string, unknown>;
  if (typeof mod['provisionOrg'] !== 'function') {
    throw new Error('src/identity/provision-org.ts must export `provisionOrg`');
  }
  return mod['provisionOrg'] as ProvisionOrg;
}

export interface ProvEnv {
  wall: Wall;
  sup: Db; // postgres superuser on the throwaway database: checking only
  appDb: Db; // grc_app
  migrator: Db; // grc_migrator
  graph: { createOrgDatabase(orgId: string): Promise<void>; close(): Promise<void> };
  files: { ensureBucket(orgId: string): Promise<void> };
  audit: AuditLike;
}

export async function setUpProvision(): Promise<ProvEnv> {
  const wall = await setUpWall();
  try {
    const g = graphTestEnv();
    const { GraphService } = await import('../../src/graph/graph.service.js');
    const { SeaweedFileStore } = await import('../../src/storage/seaweed-file-store.js');
    const { AuditService } = await import('../../src/audit/audit.service.js');
    const appDb = wall.loaded.createDb(appUrl(wall.dbName), { max: 4 });
    const migrator = wall.loaded.createDb(migrateUrl(wall.dbName), { max: 2 });
    return {
      wall,
      sup: wall.sup,
      appDb,
      migrator,
      graph: new GraphService({ uri: g.uri, adminPassword: g.adminPassword, writerPassword: g.writerPassword }),
      files: new SeaweedFileStore(liveConfig()),
      audit: new AuditService(appDb),
    };
  } catch (err) {
    await tearDownWall(wall);
    throw err;
  }
}

export function deps(env: ProvEnv, overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return { db: env.appDb, migrator: env.migrator, graph: env.graph, files: env.files, ...overrides };
}

/** Drops every org's Neo4j database and bucket, then the throwaway Postgres database. */
export async function tearDownProvision(env: ProvEnv | undefined): Promise<void> {
  if (!env) return;
  let orgIds: string[] = [];
  try {
    orgIds = await allOrgIds(env);
  } catch {
    // the organization table may be missing if the set-up failed early
  }
  try {
    await removeOrgDatabases(orgIds);
    await removeBuckets(orgIds);
  } finally {
    await env.graph.close();
    await closeDb(env.appDb);
    await closeDb(env.migrator);
    await tearDownWall(env.wall);
  }
}

let n = 0;
/** A unique slug, name and Admin for one test. */
export function newOrgInput(label = 'acme'): ProvisionInput {
  n += 1;
  const tag = randomBytes(4).toString('hex');
  return {
    name: `${label} ${tag} Ltd`,
    slug: `${label}-${tag}-${n}`,
    admin: { email: `admin.${tag}.${n}@provision.test`, name: `Admin ${tag}` },
  };
}

// ---- Postgres checks (as the superuser, which RLS never applies to) ----

export async function allOrgIds(env: ProvEnv): Promise<string[]> {
  const { sql } = env.wall.loaded;
  const found = await rows<{ id: string }>(env.sup, sql`SELECT id::text AS id FROM "organization" ORDER BY 1`);
  return found.map((r) => r.id);
}

export async function orgsWithSlug(env: ProvEnv, slug: string): Promise<{ id: string; name: string }[]> {
  const { sql } = env.wall.loaded;
  return rows<{ id: string; name: string }>(
    env.sup,
    sql`SELECT id::text AS id, name FROM "organization" WHERE slug = ${slug}`,
  );
}

export async function countRows(env: ProvEnv, table: 'organization' | 'user' | 'member'): Promise<number> {
  const { sql } = env.wall.loaded;
  const [r] = await rows<{ n: number }>(env.sup, sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)}`);
  return r!.n;
}

export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  role: string;
  clearance: string;
}

export async function membersOf(env: ProvEnv, orgId: string): Promise<MemberRow[]> {
  const { sql } = env.wall.loaded;
  return rows<MemberRow>(
    env.sup,
    sql`SELECT u.id AS "userId", u.email, u.name, m.role, m.clearance
        FROM "member" m JOIN "user" u ON u.id = m.user_id
        WHERE m.org_id = ${orgId}::uuid ORDER BY u.email`,
  );
}

export async function usersWithEmail(env: ProvEnv, email: string): Promise<number> {
  const { sql } = env.wall.loaded;
  const [r] = await rows<{ n: number }>(env.sup, sql`SELECT count(*)::int AS n FROM "user" WHERE email = ${email}`);
  return r!.n;
}

export interface Credentials {
  twoFactorEnabled: boolean | null;
  twoFactorRows: number;
  passwords: { providerId: string; password: string }[];
}

export async function credentialsOf(env: ProvEnv, userId: string): Promise<Credentials> {
  const { sql } = env.wall.loaded;
  const [u] = await rows<{ tfa: boolean | null }>(
    env.sup,
    sql`SELECT two_factor_enabled AS tfa FROM "user" WHERE id = ${userId}`,
  );
  const [t] = await rows<{ n: number }>(
    env.sup,
    sql`SELECT count(*)::int AS n FROM "two_factor" WHERE user_id = ${userId}`,
  );
  const passwords = await rows<{ providerId: string; password: string }>(
    env.sup,
    sql`SELECT provider_id AS "providerId", password FROM "account"
        WHERE user_id = ${userId} AND password IS NOT NULL`,
  );
  return { twoFactorEnabled: u?.tfa ?? null, twoFactorRows: t!.n, passwords };
}

export async function auditPartitions(env: ProvEnv, orgId: string): Promise<number> {
  const { sql } = env.wall.loaded;
  const [r] = await rows<{ n: number }>(
    env.sup,
    sql`SELECT count(*)::int AS n
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'public.audit_events'::regclass
          AND pg_get_expr(c.relpartbound, c.oid) LIKE ${`%${orgId}%`}`,
  );
  return r!.n;
}

export async function auditActions(env: ProvEnv, orgId: string): Promise<{ seq: number; action: string }[]> {
  const { sql } = env.wall.loaded;
  const found = await rows<{ seq: string | number; action: string }>(
    env.sup,
    sql`SELECT seq, action FROM "audit_events" WHERE org_id = ${orgId}::uuid ORDER BY seq`,
  );
  return found.map((r) => ({ seq: Number(r.seq), action: r.action }));
}

// ---- Neo4j and storage checks ----

export async function orgDatabaseStatuses(orgId: string): Promise<string[]> {
  const driver = superDriver();
  try {
    return await databaseStatuses(driver, `org-${orgId}`);
  } finally {
    await driver.close();
  }
}

async function removeOrgDatabases(orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const driver = superDriver();
  try {
    await dropDatabases(
      driver,
      orgIds.filter((id) => LOWERCASE_UUID.test(id)).map((id) => `org-${id}`),
    );
  } finally {
    await driver.close();
  }
}

function s3(): S3Client {
  const cfg = liveConfig();
  return new S3Client({
    endpoint: cfg.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
}

function isMissingBucket(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchBucket' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export async function bucketExists(orgId: string): Promise<boolean> {
  const client = s3();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketFor(orgId) }));
    return true;
  } catch (err) {
    if (isMissingBucket(err)) return false;
    throw err;
  } finally {
    client.destroy();
  }
}

async function removeBuckets(orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const client = s3();
  const left: string[] = [];
  try {
    for (const org of orgIds) {
      const Bucket = bucketFor(org);
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch (err) {
        if (isMissingBucket(err)) continue;
        throw err;
      }
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }));
        for (const obj of page.Contents ?? []) {
          if (obj.Key !== undefined) await client.send(new DeleteObjectCommand({ Bucket, Key: obj.Key }));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      await client.send(new DeleteBucketCommand({ Bucket }));
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        left.push(Bucket);
      } catch (err) {
        if (!isMissingBucket(err)) throw err;
      }
    }
  } finally {
    client.destroy();
  }
  if (left.length > 0) throw new Error(`test buckets left behind on SeaweedFS: ${left.join(', ')}`);
}

// ---- Root scripts (`pnpm org:create`, `pnpm seed:demo`) ----

/** The settings the root scripts read, pointed at this file's throwaway database. */
export function scriptEnv(env: ProvEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const g = graphTestEnv();
  const s = liveConfig();
  return {
    ...process.env,
    DATABASE_URL_APP: appUrl(env.wall.dbName),
    DATABASE_URL_MIGRATE: migrateUrl(env.wall.dbName),
    NEO4J_URI: g.uri,
    NEO4J_ADMIN_PASSWORD: g.adminPassword,
    NEO4J_WRITER_PASSWORD: g.writerPassword,
    S3_ENDPOINT: s.endpoint,
    S3_ACCESS_KEY: s.accessKey,
    S3_SECRET_KEY: s.secretKey,
    ...extra,
  };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `pnpm <script> <args…>` from the repo root. */
export async function runRoot(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', [script, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
