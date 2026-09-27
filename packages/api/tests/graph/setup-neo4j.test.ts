// M0-004 criteria 1 and 4: `pnpm setup:neo4j` creates `grc_admin` and `grc_writer`, and
// each can do only its own job.
// Decisions: D14 (Neo4j Desktop Enterprise), D22 (one database per org), D57 (the admin
// account only creates databases; secrets stay in .env), D73 (one writer, one admin).
//
// Contract:
// - Root script `setup:neo4j` runs packages/infra/scripts/setup-neo4j.ts. It reads
//   NEO4J_URI, NEO4J_DESKTOP_PASSWORD, NEO4J_ADMIN_PASSWORD and NEO4J_WRITER_PASSWORD from
//   the environment (a `.env` in the working folder may fill in missing ones, but never
//   overrides what is already set). It logs in as the Desktop `neo4j` account.
// - `grc_admin` (NEO4J_ADMIN_PASSWORD) may create databases and nothing else: no drop,
//   stop, user, role or privilege management, and no reading or writing of graph data.
// - `grc_writer` (NEO4J_WRITER_PASSWORD) reads and writes in `org-*` databases only, with
//   no admin rights at all.
// - Neither account must change its password on first login.
// - A second run changes nothing: same users, same roles, same privileges, same passwords.
// - The script never prints a password.
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import type { Driver } from 'neo4j-driver';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROOT,
  databaseExists,
  driverAs,
  dropDatabases,
  graphTestEnv,
  newOrgId,
  newTestDatabaseName,
  refused,
  runOn,
  runSetupNeo4j,
  superDriver,
} from './helpers.js';

const LONG = 120_000;
const ACCOUNTS = ['grc_admin', 'grc_writer'] as const;

let sup: Driver;
let admin: Driver;
let writer: Driver;
let firstRun: { status: number | null; stdout: string; stderr: string };

const createdDatabases = new Set<string>();
const probeUser = `grc_probe_${Math.random().toString(36).slice(2, 10)}`;
const probeRole = `grc_probe_role_${Math.random().toString(36).slice(2, 10)}`;

// An org database that exists for the whole file, made by the Desktop account, with one
// node in it that only the Desktop account wrote.
const orgDb = `org-${newOrgId()}`;
// A database whose name doesn't start with `org-`.
const otherDb = newTestDatabaseName();

interface Snapshot {
  users: Record<string, unknown>[];
  privileges: Record<string, string[]>;
}

async function snapshot(): Promise<Snapshot> {
  const users = await runOn(
    sup,
    'system',
    'SHOW USERS YIELD user, roles, passwordChangeRequired, suspended, home WHERE user IN $names RETURN user, roles, passwordChangeRequired, suspended, home ORDER BY user',
    { names: [...ACCOUNTS] },
  );
  const roles = new Set<string>();
  for (const u of users) for (const r of (u['roles'] as string[]) ?? []) if (r !== 'PUBLIC') roles.add(r);
  const privileges: Record<string, string[]> = {};
  for (const role of [...roles].sort()) {
    const rows = await runOn(sup, 'system', `SHOW ROLE \`${role}\` PRIVILEGES AS COMMANDS`);
    privileges[role] = rows.map((r) => String(r['command'])).sort();
  }
  for (const u of users) u['roles'] = [...((u['roles'] as string[]) ?? [])].sort();
  return { users, privileges };
}

beforeAll(async () => {
  const env = graphTestEnv();
  sup = superDriver();
  await runOn(sup, 'system', 'SHOW DATABASES YIELD name RETURN count(*) AS n');

  firstRun = await runSetupNeo4j();

  admin = driverAs('grc_admin', env.adminPassword);
  writer = driverAs('grc_writer', env.writerPassword);

  createdDatabases.add(orgDb);
  createdDatabases.add(otherDb);
  await runOn(sup, 'system', `CREATE DATABASE \`${orgDb}\` IF NOT EXISTS WAIT`);
  await runOn(sup, 'system', `CREATE DATABASE \`${otherDb}\` IF NOT EXISTS WAIT`);
  await runOn(sup, orgDb, 'CREATE (:GrcTestProbe {owner: "desktop"})');
}, LONG);

afterAll(async () => {
  if (sup) {
    // Undo anything a wrongly-allowed command managed to do.
    await runOn(sup, 'system', `DROP USER \`${probeUser}\` IF EXISTS`).catch(() => undefined);
    await runOn(sup, 'system', `DROP ROLE \`${probeRole}\` IF EXISTS`).catch(() => undefined);
    for (const u of ACCOUNTS) {
      await runOn(sup, 'system', `ALTER USER \`${u}\` IF EXISTS SET STATUS ACTIVE`).catch(() => undefined);
      await runOn(sup, 'system', `REVOKE ROLE admin FROM \`${u}\``).catch(() => undefined);
    }
    await runOn(sup, 'system', 'REVOKE GRANT ALL GRAPH PRIVILEGES ON GRAPH * FROM PUBLIC').catch(() => undefined);
    await runOn(sup, 'neo4j', 'MATCH (n:GrcTestProbe) DETACH DELETE n').catch(() => undefined);
    await dropDatabases(sup, createdDatabases).catch(() => undefined);
  }
  await admin?.close();
  await writer?.close();
  await sup?.close();
}, LONG);

describe('pnpm setup:neo4j (criterion 1)', () => {
  it('is a root script that runs packages/infra/scripts/setup-neo4j.ts', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['setup:neo4j']).toMatch(/packages\/infra\/scripts\/setup-neo4j\.ts/);
  });

  it('exits 0', () => {
    expect(firstRun.status, firstRun.stderr).toBe(0);
  });

  it('never prints a password', () => {
    const env = graphTestEnv();
    const out = firstRun.stdout + firstRun.stderr;
    for (const secret of [env.desktopPassword, env.adminPassword, env.writerPassword]) {
      expect(out.includes(secret)).toBe(false);
    }
  });

  it('creates grc_admin and grc_writer, active, with no forced password change', async () => {
    const snap = await snapshot();
    expect(snap.users.map((u) => u['user'])).toEqual(['grc_admin', 'grc_writer']);
    for (const u of snap.users) {
      expect(u['suspended']).toBe(false);
      expect(u['passwordChangeRequired']).toBe(false);
    }
  });

  it('gives neither account a built-in admin or all-powerful role', async () => {
    const snap = await snapshot();
    for (const u of snap.users) {
      expect(u['roles']).not.toContain('admin');
      expect(u['roles']).not.toContain('architect');
      expect(u['roles']).not.toContain('publisher');
      expect(u['roles']).not.toContain('editor');
    }
  });

  it('lets both accounts log in with the passwords from .env', async () => {
    await expect(admin.verifyAuthentication()).resolves.toBe(true);
    await expect(writer.verifyAuthentication()).resolves.toBe(true);
  });

  it(
    'changes nothing when run a second time',
    async () => {
      const before = await snapshot();
      const second = await runSetupNeo4j();
      expect(second.status, second.stderr).toBe(0);
      const after = await snapshot();
      expect(after).toEqual(before);
      // Passwords were not reset.
      await expect(admin.verifyAuthentication()).resolves.toBe(true);
      await expect(writer.verifyAuthentication()).resolves.toBe(true);
    },
    LONG,
  );
});

describe('grc_admin may create databases and nothing else (criterion 1, D57)', () => {
  it(
    'can create an org database',
    async () => {
      const name = `org-${newOrgId()}`;
      createdDatabases.add(name);
      await runOn(admin, 'system', `CREATE DATABASE \`${name}\` WAIT`);
      expect(await databaseExists(sup, name)).toBe(true);
    },
    LONG,
  );

  it('cannot drop a database', async () => {
    await refused(runOn(admin, 'system', `DROP DATABASE \`${orgDb}\``));
    expect(await databaseExists(sup, orgDb)).toBe(true);
  });

  it('cannot stop a database', async () => {
    await refused(runOn(admin, 'system', `STOP DATABASE \`${orgDb}\``));
    const rows = await runOn(sup, 'system', 'SHOW DATABASES YIELD name, requestedStatus WHERE name = $name', {
      name: orgDb,
    });
    expect(rows[0]?.['requestedStatus']).toBe('online');
  });

  it('cannot create a user', async () => {
    await refused(
      runOn(admin, 'system', `CREATE USER \`${probeUser}\` SET PASSWORD 'probe-password-123' CHANGE NOT REQUIRED`),
    );
  });

  it('cannot create a role', async () => {
    await refused(runOn(admin, 'system', `CREATE ROLE \`${probeRole}\``));
  });

  it('cannot give itself a role', async () => {
    await refused(runOn(admin, 'system', 'GRANT ROLE admin TO grc_admin'));
  });

  it('cannot grant privileges', async () => {
    await refused(runOn(admin, 'system', 'GRANT ALL GRAPH PRIVILEGES ON GRAPH * TO PUBLIC'));
  });

  it('cannot suspend another user', async () => {
    await refused(runOn(admin, 'system', 'ALTER USER grc_writer SET STATUS SUSPENDED'));
  });

  it('cannot list users', async () => {
    await refused(runOn(admin, 'system', 'SHOW USERS'));
  });

  it('cannot write graph data in an org database', async () => {
    await refused(runOn(admin, orgDb, 'CREATE (:GrcTestProbe {owner: "admin"})'));
    const rows = await runOn(sup, orgDb, 'MATCH (n:GrcTestProbe {owner: "admin"}) RETURN count(n) AS n');
    expect(rows[0]?.['n']).toBe(0);
  });

  it('cannot read graph data in an org database', async () => {
    let seen = 0;
    try {
      const rows = await runOn(admin, orgDb, 'MATCH (n:GrcTestProbe) RETURN count(n) AS n');
      seen = Number(rows[0]?.['n'] ?? 0);
    } catch (err) {
      // A refusal is also fine, but only a real Neo4j refusal.
      expect(String((err as { code?: string }).code)).toMatch(/^Neo\.ClientError\.Security\./);
    }
    expect(seen).toBe(0);
  });
});

describe('grc_writer reads and writes org-* only, with no admin rights (criteria 1 and 4)', () => {
  it('can write and read in an org database', async () => {
    await runOn(writer, orgDb, 'CREATE (:GrcTestProbe {owner: "writer"})');
    const rows = await runOn(writer, orgDb, 'MATCH (n:GrcTestProbe) RETURN n.owner AS owner ORDER BY owner');
    expect(rows.map((r) => r['owner'])).toEqual(['desktop', 'writer']);
  });

  it('cannot write in a database whose name does not start with org-', async () => {
    await refused(runOn(writer, otherDb, 'CREATE (:GrcTestProbe {owner: "writer"})'));
    const rows = await runOn(sup, otherDb, 'MATCH (n:GrcTestProbe) RETURN count(n) AS n');
    expect(rows[0]?.['n']).toBe(0);
  });

  it('cannot write in the default neo4j database', async () => {
    await refused(runOn(writer, 'neo4j', 'CREATE (:GrcTestProbe {owner: "writer"})'));
    const rows = await runOn(sup, 'neo4j', 'MATCH (n:GrcTestProbe {owner: "writer"}) RETURN count(n) AS n');
    expect(rows[0]?.['n']).toBe(0);
  });

  it(
    'cannot run CREATE DATABASE',
    async () => {
      const name = `org-${newOrgId()}`;
      createdDatabases.add(name);
      await refused(runOn(writer, 'system', `CREATE DATABASE \`${name}\``));
      expect(await databaseExists(sup, name)).toBe(false);
    },
    LONG,
  );

  it('cannot run DROP DATABASE', async () => {
    await refused(runOn(writer, 'system', `DROP DATABASE \`${orgDb}\``));
    expect(await databaseExists(sup, orgDb)).toBe(true);
  });

  it('cannot stop a database', async () => {
    await refused(runOn(writer, 'system', `STOP DATABASE \`${orgDb}\``));
  });

  it('cannot create a user', async () => {
    await refused(
      runOn(writer, 'system', `CREATE USER \`${probeUser}\` SET PASSWORD 'probe-password-123' CHANGE NOT REQUIRED`),
    );
  });

  it('cannot create a role', async () => {
    await refused(runOn(writer, 'system', `CREATE ROLE \`${probeRole}\``));
  });

  it('cannot give itself a role', async () => {
    await refused(runOn(writer, 'system', 'GRANT ROLE admin TO grc_writer'));
  });

  it('cannot grant privileges', async () => {
    await refused(runOn(writer, 'system', 'GRANT ALL GRAPH PRIVILEGES ON GRAPH * TO PUBLIC'));
  });

  it('cannot suspend another user', async () => {
    await refused(runOn(writer, 'system', 'ALTER USER grc_admin SET STATUS SUSPENDED'));
  });

  it('cannot list users', async () => {
    await refused(runOn(writer, 'system', 'SHOW USERS'));
  });

  it('cannot list role privileges', async () => {
    await refused(runOn(writer, 'system', 'SHOW PRIVILEGES'));
  });
});
