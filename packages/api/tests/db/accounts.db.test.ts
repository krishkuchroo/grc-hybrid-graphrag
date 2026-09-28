// M0-003 criterion 1: the two Postgres accounts (D57, D73).
// - `grc_migrator` owns every table.
// - `grc_app` can log in, is NOSUPERUSER and NOBYPASSRLS, owns nothing, and has only the
//   grants the migrations give it.
// See helpers.ts for the connection contract and the throwaway database.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_DIR,
  appUrl,
  closeDb,
  createThrowaway,
  dropThrowaway,
  load,
  runMigrations,
  migrateUrl,
  rows,
  superUrl,
  type Db,
  type Loaded,
} from './helpers.js';

let loaded: Loaded;
let dbName = '';
let su: Db | undefined;

beforeAll(async () => {
  loaded = await load();
  dbName = await createThrowaway(loaded);
  const result = await runMigrations(migrateUrl(dbName));
  if (!result.ok) throw new Error(`drizzle-kit migrate failed:\n${result.output}`);
  su = loaded.createDb(superUrl(dbName));
}, 180_000);

afterAll(async () => {
  await closeDb(su);
  if (loaded && dbName) await dropThrowaway(loaded, dbName);
});

function db(): Db {
  if (!su) throw new Error('set-up did not finish');
  return su;
}

describe('grc_app role attributes', () => {
  it('can log in, and is NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOCREATEROLE', async () => {
    const [r] = await rows<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      db(),
      loaded.sql`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
                 FROM pg_roles WHERE rolname = 'grc_app'`,
    );
    expect(r).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it('inherits no superuser or RLS-bypass power through role membership', async () => {
    const powered = await rows<{ rolname: string }>(
      db(),
      loaded.sql`SELECT r.rolname FROM pg_roles r
                 WHERE r.rolname <> 'grc_app'
                   AND pg_has_role('grc_app', r.oid, 'MEMBER')
                   AND (r.rolsuper OR r.rolbypassrls OR r.rolname = 'grc_migrator')`,
    );
    expect(powered).toEqual([]);
  });

  it('logs in through DATABASE_URL_APP as grc_app', async () => {
    const app = loaded.createDb(appUrl(dbName));
    try {
      const [r] = await rows<{ who: string }>(app, loaded.sql`SELECT current_user AS who`);
      expect(r?.who).toBe('grc_app');
    } finally {
      await closeDb(app);
    }
  });
});

describe('ownership after migrations', () => {
  it('grc_migrator owns every table, view and sequence outside the system schemas', async () => {
    const all = await rows<{ name: string; owner: string }>(
      db(),
      loaded.sql`SELECT n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND n.nspname NOT LIKE 'pg_temp%'`,
    );
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((t) => t.owner !== 'grc_migrator')).toEqual([]);
  });

  it('grc_app owns no relation, schema, function or type in the database', async () => {
    const owned = await rows<{ kind: string; name: string }>(
      db(),
      loaded.sql`SELECT 'relation' AS kind, relname::text AS name FROM pg_class
                   WHERE relowner = 'grc_app'::regrole
                 UNION ALL SELECT 'schema', nspname::text FROM pg_namespace WHERE nspowner = 'grc_app'::regrole
                 UNION ALL SELECT 'function', proname::text FROM pg_proc WHERE proowner = 'grc_app'::regrole
                 UNION ALL SELECT 'type', typname::text FROM pg_type WHERE typowner = 'grc_app'::regrole`,
    );
    expect(owned).toEqual([]);
  });

  it('grc_app does not own the database', async () => {
    const [r] = await rows<{ owner: string }>(
      db(),
      loaded.sql`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`,
    );
    expect(r?.owner).not.toBe('grc_app');
  });
});

describe('grc_app has only the grants the migrations give it', () => {
  it('cannot create objects in the database or in the public schema', async () => {
    const [r] = await rows<{ db_create: boolean; schema_create: boolean }>(
      db(),
      loaded.sql`SELECT has_database_privilege('grc_app', current_database(), 'CREATE') AS db_create,
                        has_schema_privilege('grc_app', 'public', 'CREATE') AS schema_create`,
    );
    expect(r).toEqual({ db_create: false, schema_create: false });
  });

  it('has no rights on the migration bookkeeping tables', async () => {
    const granted = await rows<{ name: string; privilege: string }>(
      db(),
      loaded.sql`SELECT table_schema || '.' || table_name AS name, privilege_type AS privilege
                 FROM information_schema.role_table_grants
                 WHERE grantee = 'grc_app' AND table_name ILIKE '%migrations%'`,
    );
    expect(granted).toEqual([]);
  });

  it('every table right grc_app holds is granted to it by name in a migration file', async () => {
    const migrationsDir = join(API_DIR, 'src', 'db', 'migrations');
    const sqlText = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
      .join('\n')
      .toLowerCase();

    const granted = await rows<{ table: string; privilege: string }>(
      db(),
      loaded.sql`SELECT table_name AS "table", lower(privilege_type) AS privilege
                 FROM information_schema.role_table_grants WHERE grantee = 'grc_app'`,
    );
    const unexplained = granted.filter(
      (g) =>
        !new RegExp(`grant[^;]*\\b${g.privilege}\\b[^;]*\\b${g.table}\\b[^;]*\\bto\\s+grc_app\\b`).test(sqlText) &&
        !new RegExp(`grant[^;]*\\ball\\b[^;]*\\b${g.table}\\b[^;]*\\bto\\s+grc_app\\b`).test(sqlText),
    );
    expect(unexplained).toEqual([]);
  });
});
