// Shared set-up for the M0-003 database tests (D57, D73, D82).
//
// Contract these helpers hold the code to:
// - `src/db/client.ts` exports `createDb(url: string, opts?: { max?: number }): Db`, a Drizzle
//   database over a connection pool. `opts.max` caps the pool size (the tests use 1 to prove
//   that settings don't carry over between pooled uses). The pool is reachable as `db.$client`
//   and has an `end()` method.
// - `src/db/org-context.ts` exports `withOrgContext(db, ctx, fn)`.
// - `packages/api/drizzle.config.ts` reads `DATABASE_URL_MIGRATE`, so `drizzle-kit migrate`
//   runs the migrations in `src/db/migrations` as `grc_migrator`.
// - The cluster roles `grc_app` and `grc_migrator` exist (created by
//   `packages/infra/postgres/init/01-roles.sql`), and their passwords sit in the URLs.
//
// Where the connection details come from:
// - `DATABASE_URL_APP`, `DATABASE_URL_MIGRATE` and `POSTGRES_PASSWORD` are read from the
//   process environment first, then from the nearest `.env` walking up from this package
//   (in an agent worktree that is the main checkout's `.env`).
// - Tests on the Mac reach Postgres at 127.0.0.1:5433 through the dev switch (D61), so the
//   host and port of every URL are replaced with those. The database name is replaced with
//   the throwaway database's name.
//
// Throwaway databases (D82): `test-<random>`, created by the `postgres` superuser with
// `OWNER grc_migrator` (the migration account owns the database it migrates), and dropped
// at the end of each test file.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEST_HOST = '127.0.0.1';
export const TEST_PORT = '5433';

type ClientModule = typeof import('../../src/db/client.js');
type OrgContextModule = typeof import('../../src/db/org-context.js');
type DrizzleModule = typeof import('drizzle-orm');

export type Db = ReturnType<ClientModule['createDb']>;

export interface Loaded {
  createDb: ClientModule['createDb'];
  withOrgContext: OrgContextModule['withOrgContext'];
  sql: DrizzleModule['sql'];
}

// Loads the code under test. Done inside the tests (not at file top) so a missing module
// shows up as a failing test that names the missing file.
export async function load(): Promise<Loaded> {
  const client = (await import('../../src/db/client.js')) as ClientModule;
  const orgContext = (await import('../../src/db/org-context.js')) as OrgContextModule;
  const drizzle = (await import('drizzle-orm')) as DrizzleModule;
  return { createDb: client.createDb, withOrgContext: orgContext.withOrgContext, sql: drizzle.sql };
}

function readDotEnv(): Record<string, string> {
  const found: Record<string, string> = {};
  let dir = API_DIR;
  for (;;) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1]!;
        let value = m[2]!.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in found)) found[key] = value;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export function setting(name: string): string {
  const value = process.env[name] || readDotEnv()[name];
  if (!value) throw new Error(`Test set-up: ${name} is not set in the environment or in .env`);
  return value;
}

// Points a URL at the dev-switch port and at the given database.
export function urlFor(base: string, database: string): string {
  const u = new URL(base);
  u.hostname = TEST_HOST;
  u.port = TEST_PORT;
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export function appUrl(database: string): string {
  return urlFor(setting('DATABASE_URL_APP'), database);
}

export function migrateUrl(database: string): string {
  return urlFor(setting('DATABASE_URL_MIGRATE'), database);
}

export function superUrl(database: string): string {
  const password = encodeURIComponent(setting('POSTGRES_PASSWORD'));
  return `postgres://postgres:${password}@${TEST_HOST}:${TEST_PORT}/${encodeURIComponent(database)}`;
}

// Runs a query and returns its rows, whichever Drizzle driver `createDb` uses
// (node-postgres returns `{ rows }`, postgres.js returns the rows array).
export async function rows<T = Record<string, unknown>>(
  db: { execute: (q: never) => Promise<unknown> },
  query: unknown,
): Promise<T[]> {
  const result = await db.execute(query as never);
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
}

export async function closeDb(db: unknown): Promise<void> {
  const client = (db as { $client?: { end?: () => Promise<void> | void } } | undefined)?.$client;
  await client?.end?.();
}

export function throwawayName(): string {
  return `test-${randomBytes(6).toString('hex')}`;
}

// Creates a throwaway database owned by grc_migrator and returns its name.
export async function createThrowaway(loaded: Loaded): Promise<string> {
  const name = throwawayName();
  const admin = loaded.createDb(superUrl('postgres'));
  try {
    await rows(admin, loaded.sql.raw(`CREATE DATABASE "${name}" OWNER grc_migrator`));
  } finally {
    await closeDb(admin);
  }
  return name;
}

export async function dropThrowaway(loaded: Loaded, name: string): Promise<void> {
  const admin = loaded.createDb(superUrl('postgres'));
  try {
    await rows(admin, loaded.sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  } finally {
    await closeDb(admin);
  }
}

export interface MigrateResult {
  ok: boolean;
  output: string;
}

// Runs `drizzle-kit migrate` in packages/api with DATABASE_URL_MIGRATE set to `url`.
export async function runMigrations(url: string): Promise<MigrateResult> {
  const env = { ...process.env, DATABASE_URL_MIGRATE: url };
  try {
    const { stdout, stderr } = await promisify(execFile)('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
      cwd: API_DIR,
      env,
      timeout: 120_000,
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}` };
  }
}
