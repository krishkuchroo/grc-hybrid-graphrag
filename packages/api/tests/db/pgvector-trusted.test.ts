// M0-003 criterion 3 and D142: how pgvector gets installed.
// grc-postgres mounts a secondary `vector--0.8.6.control` with `trusted = true`, so the
// database owner grc_migrator (NOSUPERUSER) can CREATE EXTENSION vector in its own
// database, and grc_app (owns nothing, no CREATE on the database) still can't.
// Throwaway databases are created by the postgres superuser, owned by grc_migrator (see
// helpers.ts), and dropped at the end.
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
  type Loaded,
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

async function asSuper<T>(dbName: string, fn: (db: ReturnType<Loaded['createDb']>) => Promise<T>): Promise<T> {
  const su = loaded.createDb(superUrl(dbName));
  try {
    return await fn(su);
  } finally {
    await closeDb(su);
  }
}

async function vectorRows(dbName: string): Promise<{ extversion: string; owner: string }[]> {
  return asSuper(dbName, (su) =>
    rows<{ extversion: string; owner: string }>(
      su,
      loaded.sql`SELECT extversion, pg_get_userbyid(extowner) AS owner FROM pg_extension WHERE extname = 'vector'`,
    ),
  );
}

// Runs one statement on its own connection and reports whether it failed, and how.
async function attempt(url: string, statement: string): Promise<{ ok: boolean; message: string }> {
  const db = loaded.createDb(url);
  try {
    await rows(db, loaded.sql.raw(statement));
    return { ok: true, message: '' };
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return { ok: false, message: `${e.message ?? ''} ${e.cause?.message ?? ''}` };
  } finally {
    await closeDb(db);
  }
}

describe('the server marks vector as trusted (D142)', () => {
  it('pg_available_extension_versions lists vector 0.8.6 as trusted', async () => {
    const dbName = await freshDatabase();
    const found = await asSuper(dbName, (su) =>
      rows<{ version: string; trusted: boolean }>(
        su,
        loaded.sql`SELECT version, trusted FROM pg_available_extension_versions
                   WHERE name = 'vector' AND version = '0.8.6'`,
      ),
    );
    expect(found).toEqual([{ version: '0.8.6', trusted: true }]);
  });

  it('the default vector version is 0.8.6, the one the trusted control file covers', async () => {
    const dbName = await freshDatabase();
    const [r] = await asSuper(dbName, (su) =>
      rows<{ default_version: string }>(
        su,
        loaded.sql`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`,
      ),
    );
    expect(r?.default_version).toBe('0.8.6');
  });

  it('a new database does not come with vector already installed (no template1 shortcut)', async () => {
    const dbName = await freshDatabase();
    expect(await vectorRows(dbName)).toEqual([]);
  });
});

describe('grc_migrator installs vector without being a superuser (D142, D57)', () => {
  it('grc_migrator is NOSUPERUSER and not a member of any superuser role', async () => {
    const dbName = await freshDatabase();
    const [r] = await asSuper(dbName, (su) =>
      rows<{ rolsuper: boolean; inherits_super: boolean }>(
        su,
        loaded.sql`SELECT r.rolsuper,
                          EXISTS (SELECT 1 FROM pg_roles s
                                  WHERE s.rolsuper AND s.rolname <> 'grc_migrator'
                                    AND pg_has_role('grc_migrator', s.oid, 'MEMBER')) AS inherits_super
                   FROM pg_roles r WHERE r.rolname = 'grc_migrator'`,
      ),
    );
    expect(r).toEqual({ rolsuper: false, inherits_super: false });
  });

  it('CREATE EXTENSION vector as grc_migrator in its own database succeeds', async () => {
    const dbName = await freshDatabase();
    const result = await attempt(migrateUrl(dbName), 'CREATE EXTENSION vector');
    expect(result.ok, result.message).toBe(true);
    const found = await vectorRows(dbName);
    expect(found).toEqual([{ extversion: '0.8.6', owner: 'grc_migrator' }]);
  });

  it('after the migrations, vector 0.8.6 is installed and owned by grc_migrator', async () => {
    const dbName = await freshDatabase();
    const result = await runMigrations(migrateUrl(dbName));
    expect(result.ok, result.output).toBe(true);
    expect(await vectorRows(dbName)).toEqual([{ extversion: '0.8.6', owner: 'grc_migrator' }]);
  }, 180_000);
});

describe('grc_app still cannot install or remove vector (D142, D57)', () => {
  it('CREATE EXTENSION vector as grc_app on a fresh database fails and installs nothing', async () => {
    const dbName = await freshDatabase();
    const result = await attempt(appUrl(dbName), 'CREATE EXTENSION vector');
    expect(result.ok, 'grc_app must not be able to create vector').toBe(false);
    expect(result.message).toMatch(/permission denied/i);
    expect(await vectorRows(dbName)).toEqual([]);
  });

  it('DROP EXTENSION vector as grc_app on a migrated database fails and vector stays', async () => {
    const dbName = await freshDatabase();
    const migrated = await runMigrations(migrateUrl(dbName));
    expect(migrated.ok, migrated.output).toBe(true);
    const result = await attempt(appUrl(dbName), 'DROP EXTENSION vector');
    expect(result.ok, 'grc_app must not be able to drop vector').toBe(false);
    expect(result.message).toMatch(/must be owner|permission denied/i);
    expect(await vectorRows(dbName)).toEqual([{ extversion: '0.8.6', owner: 'grc_migrator' }]);
  }, 180_000);
});
