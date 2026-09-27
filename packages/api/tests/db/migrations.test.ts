// M0-003 criteria 2 and 3 (D13, D33, D57, D71).
// 2. Migrations run with `grc_migrator` only, and running them twice changes nothing.
// 3. The `vector` extension is installed at 0.8.x, and `SHOW server_version` starts with `18.`.
// Migrations run through `drizzle-kit migrate` with DATABASE_URL_MIGRATE (see helpers.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type MigrateResult,
} from './helpers.js';

let loaded: Loaded;
const created: string[] = [];

beforeAll(async () => {
  loaded = await load();
});

afterAll(async () => {
  if (!loaded) return;
  for (const name of created) await dropThrowaway(loaded, name);
});

async function freshDatabase(): Promise<string> {
  const name = await createThrowaway(loaded);
  created.push(name);
  return name;
}

// Everything a migration can change, as the superuser sees it: objects with owners and
// rights, extensions, and every row of every table (the migration bookkeeping included).
async function snapshot(db: Db): Promise<unknown> {
  const { sql } = loaded;
  const relations = await rows<{ schema: string; name: string; kind: string; owner: string; acl: string | null }>(
    db,
    sql`SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
               pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
        ORDER BY 1, 2`,
  );
  const schemas = await rows(
    db,
    sql`SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner, nspacl::text AS acl
        FROM pg_namespace ORDER BY 1`,
  );
  const extensions = await rows(db, sql`SELECT extname, extversion FROM pg_extension ORDER BY 1`);
  const functions = await rows(
    db,
    sql`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
               pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1`,
  );
  const policies = await rows(db, sql`SELECT schemaname, tablename, policyname FROM pg_policies ORDER BY 1, 2, 3`);
  const database = await rows(
    db,
    sql`SELECT pg_get_userbyid(datdba) AS owner, datacl::text AS acl FROM pg_database
        WHERE datname = current_database()`,
  );
  const tableRows: Record<string, unknown[]> = {};
  for (const r of relations.filter((x) => x.kind === 'r' || x.kind === 'p')) {
    const q = `SELECT * FROM "${r.schema.replace(/"/g, '""')}"."${r.name.replace(/"/g, '""')}"`;
    tableRows[`${r.schema}.${r.name}`] = await rows(db, sql.raw(q));
  }
  return { relations, schemas, extensions, functions, policies, database, tableRows };
}

describe('migrations run as grc_migrator (criterion 2)', () => {
  let dbName = '';
  let first: MigrateResult;
  let second: MigrateResult;
  let before: unknown;
  let after: unknown;

  beforeAll(async () => {
    dbName = await freshDatabase();
    first = await runMigrations(migrateUrl(dbName));
    const su = loaded.createDb(superUrl(dbName));
    try {
      before = await snapshot(su);
      second = await runMigrations(migrateUrl(dbName));
      after = await snapshot(su);
    } finally {
      await closeDb(su);
    }
  }, 240_000);

  it('the first run succeeds', () => {
    expect(first.ok, first.output).toBe(true);
  });

  it('the migration role is grc_migrator', async () => {
    const mig = loaded.createDb(migrateUrl(dbName));
    try {
      const [r] = await rows<{ who: string }>(mig, loaded.sql`SELECT current_user AS who`);
      expect(r?.who).toBe('grc_migrator');
    } finally {
      await closeDb(mig);
    }
  });

  it('a second run succeeds and changes nothing', () => {
    expect(second.ok, second.output).toBe(true);
    expect(after).toEqual(before);
  });

  it('records each migration it applied', () => {
    const snap = before as { tableRows: Record<string, unknown[]> };
    const bookkeeping = Object.entries(snap.tableRows).filter(([name]) => /migrations/i.test(name));
    expect(bookkeeping.length).toBeGreaterThan(0);
    expect(bookkeeping.some(([, r]) => r.length > 0)).toBe(true);
  });
});

describe('grc_app cannot run migrations (criterion 2)', () => {
  it('drizzle-kit migrate fails when pointed at a fresh database as grc_app, and creates nothing', async () => {
    const dbName = await freshDatabase();
    const asApp = await runMigrations(appUrl(dbName));
    expect(asApp.ok, 'migrating as grc_app must fail').toBe(false);

    const su = loaded.createDb(superUrl(dbName));
    try {
      const made = await rows(
        su,
        loaded.sql`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                     AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'`,
      );
      const extensions = await rows<{ extname: string }>(
        su,
        loaded.sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(made).toEqual([]);
      expect(extensions).toEqual([]);
    } finally {
      await closeDb(su);
    }
  }, 180_000);
});

describe('versions (criterion 3)', () => {
  let dbName = '';

  beforeAll(async () => {
    dbName = await freshDatabase();
    const result = await runMigrations(migrateUrl(dbName));
    if (!result.ok) throw new Error(`drizzle-kit migrate failed:\n${result.output}`);
  }, 180_000);

  it('the vector extension is installed at 0.8.x', async () => {
    const app = loaded.createDb(appUrl(dbName));
    try {
      const found = await rows<{ extversion: string }>(
        app,
        loaded.sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.extversion).toMatch(/^0\.8\./);
    } finally {
      await closeDb(app);
    }
  });

  it('the vector type works for the app account', async () => {
    const app = loaded.createDb(appUrl(dbName));
    try {
      const [r] = await rows<{ d: number | string }>(
        app,
        loaded.sql`SELECT '[1,0,0]'::vector <=> '[0,1,0]'::vector AS d`,
      );
      expect(Number(r?.d)).toBeCloseTo(1, 5);
    } finally {
      await closeDb(app);
    }
  });

  it('SHOW server_version starts with 18.', async () => {
    const app = loaded.createDb(appUrl(dbName));
    try {
      const [r] = await rows<{ server_version: string }>(app, loaded.sql`SHOW server_version`);
      expect(r?.server_version).toMatch(/^18\./);
    } finally {
      await closeDb(app);
    }
  });
});
