// Shared set-up for the M0-009 org-wall tests (D4, D9, D49, D55, D57, D59, D73).
//
// Contract these helpers hold the code to (TASKS.md, brief M0-009):
// - `src/identity/schema.ts` exports the Better Auth Drizzle tables `user`, `session`,
//   `account`, `verification`, `organization`, `member`, `invitation` and `twoFactor`.
//   Their JS keys are Better Auth's field names (`organizationId`, `userId`, `emailVerified`,
//   `createdAt`, …), because the Better Auth Drizzle adapter maps by those keys.
//   - `organization.id` is a uuid.
//   - `member` and `invitation` are org tables: their `organizationId` key is stored in the
//     column `org_id uuid not null` (the M0-009 rule for every org table).
//   - `member.role` accepts only the 7 roles, and `member.clearance` only the 4 labels,
//     defaulting to `internal`.
// - `src/identity/grants.schema.ts` exports `auditorGrants`, `parentLinks` and
//   `breakGlassSessions` (tables `auditor_grants`, `parent_links`, `break_glass_sessions`),
//   each an org table with `org_id uuid not null` and an `id` key. JS keys the tests use:
//   - auditorGrants: `id`, `orgId` (the org the auditor may read), `userId` (the auditor),
//     `expiresAt`, `revokedAt` (null = not revoked).
//   - parentLinks: `id`, `orgId` (the subsidiary, whose data the parent reads), `parentOrgId`,
//     `status`: 'requested' | 'approved' | 'ended'.
//   - breakGlassSessions: `id`, `orgId` (the org being read), `userId` (the operator),
//     `reason`, `expiresAt`, `endedAt` (null = still open).
//   Any column the tests don't pass has a default or is nullable.
// - `src/db/migrations/0001_identity_and_rls.sql` (applied by `drizzle-kit migrate`) creates
//   the tables, the SQL function `app_visible_org(uuid)` and the standard policies.
//
// Seed rows are written by the `postgres` superuser (which RLS never applies to). Everything
// under test runs as `grc_app` through `withOrgContext` (M0-003).
import { randomUUID } from 'node:crypto';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  appUrl,
  closeDb,
  createThrowaway,
  dropThrowaway,
  load,
  migrateUrl,
  rows,
  runMigrations,
  superUrl,
  type Db,
  type Loaded,
} from '../db/helpers.js';

export { rows, type Db, type Loaded } from '../db/helpers.js';

export const ROLES = [
  'admin',
  'risk_manager',
  'compliance_manager',
  'control_owner',
  'auditor',
  'analyst',
  'viewer',
] as const;
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Role = (typeof ROLES)[number];
export type Label = (typeof LABELS)[number];

export const BETTER_AUTH_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'organization',
  'member',
  'invitation',
  'twoFactor',
] as const;
export const GRANT_TABLES = ['auditorGrants', 'parentLinks', 'breakGlassSessions'] as const;
export const GRANT_TABLE_NAMES = ['auditor_grants', 'parent_links', 'break_glass_sessions'] as const;

type Tables = Record<string, PgTable>;

// A table the org wall covers. `key` is the column holding the org: `org_id`, or `id` for
// the organization table itself.
export interface OrgTable {
  schema: string;
  name: string;
  key: 'org_id' | 'id';
}

export interface Wall {
  loaded: Loaded;
  dbName: string;
  sup: Db; // postgres superuser on the throwaway database: seeding and checking only
  app: Db; // grc_app on the throwaway database: everything under test
  identity: Tables;
  grants: Tables;
}

// Loads the code under test. Done inside the set-up (not at file top) so a missing module
// shows up as a failing test that names the missing file.
async function loadSchemas(): Promise<{ identity: Tables; grants: Tables }> {
  const identity = (await import('../../src/identity/schema.js')) as unknown as Tables;
  const grants = (await import('../../src/identity/grants.schema.js')) as unknown as Tables;
  return { identity, grants };
}

// Creates a throwaway database, runs the migrations as grc_migrator, and opens the
// superuser and grc_app pools.
export async function setUpWall(): Promise<Wall> {
  const loaded = await load();
  const dbName = await createThrowaway(loaded);
  const result = await runMigrations(migrateUrl(dbName));
  if (!result.ok) {
    await dropThrowaway(loaded, dbName);
    throw new Error(`drizzle-kit migrate failed:\n${result.output}`);
  }
  let schemas: { identity: Tables; grants: Tables };
  try {
    schemas = await loadSchemas();
  } catch (err) {
    await dropThrowaway(loaded, dbName);
    throw err;
  }
  const sup = loaded.createDb(superUrl(dbName));
  const app = loaded.createDb(appUrl(dbName), { max: 2 });
  return { loaded, dbName, sup, app, ...schemas };
}

export async function tearDownWall(wall: Wall | undefined): Promise<void> {
  if (!wall) return;
  await closeDb(wall.app);
  await closeDb(wall.sup);
  await dropThrowaway(wall.loaded, wall.dbName);
}

export function table(tables: Tables, key: string): PgTable {
  const t = tables[key];
  if (!t) throw new Error(`the schema module does not export \`${key}\``);
  return t;
}

export function tableName(t: PgTable): { schema: string; name: string } {
  const config = getTableConfig(t);
  return { schema: config.schema ?? 'public', name: config.name };
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(t: { schema: string; name: string }): string {
  return `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
}

export async function insert(db: Db, t: PgTable, values: Record<string, unknown>): Promise<void> {
  await db.insert(t).values(values as never);
}

// Every table the org wall covers, as the superuser sees the catalog: every ordinary or
// partitioned table (not a partition) with an `org_id` column, plus the organization table.
export async function orgTables(wall: Wall): Promise<OrgTable[]> {
  const { sql } = wall.loaded;
  const found = await rows<{ schema: string; name: string }>(
    wall.sup,
    sql`SELECT n.nspname AS schema, c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
        ORDER BY 1, 2`,
  );
  const org = tableName(table(wall.identity, 'organization'));
  return [{ ...org, key: 'id' as const }, ...found.map((f) => ({ ...f, key: 'org_id' as const }))];
}

export interface Ctx {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
}

type Exec = { execute: (q: never) => Promise<unknown> };

// Runs `fn` as grc_app inside `withOrgContext`.
export function asApp<T>(wall: Wall, ctx: Ctx, fn: (tx: Exec) => Promise<T>): Promise<T> {
  return wall.loaded.withOrgContext(wall.app, ctx, (tx) => fn(tx as unknown as Exec));
}

// How many rows of `orgId` the caller sees in `t`.
export async function countFor(wall: Wall, db: Exec, t: OrgTable, orgId: string): Promise<number> {
  const { sql } = wall.loaded;
  const [r] = await rows<{ n: string | number }>(
    db,
    sql`SELECT count(*) AS n FROM ${sql.raw(qualified(t))} WHERE ${sql.raw(quoteIdent(t.key))} = ${orgId}::uuid`,
  );
  return Number(r!.n);
}

// The distinct orgs whose rows the caller sees in `t`.
export async function orgsSeen(wall: Wall, db: Exec, t: OrgTable): Promise<string[]> {
  const { sql } = wall.loaded;
  const found = await rows<{ org: string }>(
    db,
    sql`SELECT DISTINCT ${sql.raw(quoteIdent(t.key))}::text AS org FROM ${sql.raw(qualified(t))} ORDER BY 1`,
  );
  return found.map((f) => f.org);
}

// A fingerprint of every row of every org table, read by the superuser. Equal fingerprints
// before and after an attempt mean the attempt changed nothing.
export async function fingerprint(wall: Wall): Promise<Record<string, string>> {
  const { sql } = wall.loaded;
  const out: Record<string, string> = {};
  for (const t of await orgTables(wall)) {
    const [r] = await rows<{ h: string | null }>(
      wall.sup,
      sql`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${sql.raw(qualified(t))} x`,
    );
    out[`${t.schema}.${t.name}`] = r!.h ?? '';
  }
  return out;
}

// Runs `fn` and swallows any error: used for writes that must either fail or change nothing.
export async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // refused: fine, the caller checks nothing changed
  }
}

// Thrown inside a transaction to roll it back after a successful write.
export class Rollback extends Error {}

export async function rolledBack(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Rollback) return;
    throw err;
  }
  throw new Error('expected the transaction to end with Rollback');
}

export interface SeededOrg {
  id: string;
  name: string;
  adminId: string;
}

let counter = 0;

// Adds a user and returns its id (a UUID string, which suits a text or a uuid column).
export async function addUser(wall: Wall, label: string): Promise<string> {
  const id = randomUUID();
  counter += 1;
  const now = new Date();
  await insert(wall.sup, table(wall.identity, 'user'), {
    id,
    name: label,
    email: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${counter}@org-wall.test`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function addMember(
  wall: Wall,
  orgId: string,
  userId: string,
  role: Role,
  clearance?: Label,
): Promise<void> {
  await insert(wall.sup, table(wall.identity, 'member'), {
    id: randomUUID(),
    organizationId: orgId,
    userId,
    role,
    ...(clearance ? { clearance } : {}),
    createdAt: new Date(),
  });
}

// Seeds an org with its organization row, an admin member, a viewer member and a pending
// invitation, so every Better Auth org table holds rows for it.
export async function seedOrg(wall: Wall, name: string): Promise<SeededOrg> {
  const id = randomUUID();
  await insert(wall.sup, table(wall.identity, 'organization'), {
    id,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 8)}`,
    createdAt: new Date(),
  });
  const adminId = await addUser(wall, `${name} admin`);
  await addMember(wall, id, adminId, 'admin', 'restricted');
  const viewerId = await addUser(wall, `${name} viewer`);
  await addMember(wall, id, viewerId, 'viewer');
  await insert(wall.sup, table(wall.identity, 'invitation'), {
    id: randomUUID(),
    organizationId: id,
    email: `invitee.${id.slice(0, 8)}@org-wall.test`,
    role: 'viewer',
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    inviterId: adminId,
    createdAt: new Date(),
  });
  return { id, name, adminId };
}

export function adminCtx(org: SeededOrg): Ctx {
  return { orgId: org.id, userId: org.adminId, role: 'admin', clearance: 'restricted' };
}

export function sqlOf(wall: Wall): Loaded['sql'] {
  return wall.loaded.sql;
}

// The full text of an error, including its causes. Drizzle wraps Postgres errors in
// "Failed query: …", with the Postgres message in `cause`.
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 5; i++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join(' <- ');
}

// Runs `fn` and returns the error text it fails with, or throws if it succeeds.
export async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return errorText(err);
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}
