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
// - `grc_writer` (NEO4J_WRITER_PASSWORD) reads and writes graph data, with write denied on
//   the default `neo4j` database, and can never change `system`: no database, user, role,
//   alias or privilege management and no DBMS privileges at all (D144: Neo4j 2026.05
//   can't grant on a name pattern like `org-*`, so the writer is limited by `neo4j` and
//   `system` only; our code refuses Cypher with `USE`).
// - D208: `grc_writer` also holds INDEX MANAGEMENT and CONSTRAINT MANAGEMENT ON DATABASE *,
//   so `ensureOrgSchema` (S1-002) can build each org database's constraints and indexes.
//   `grc_admin` stays at CREATE DATABASE only (D57); neither of those two grants goes to it.
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
  graphTestEnv,
  newOrgId,
  refused,
  runOn,
  runSetupNeo4j,
  superDriver,
} from './helpers.js';
import { ThrowawayDatabases } from './throwaway-databases.js';

const LONG = 120_000;

async function ownGrants(user: string): Promise<string[]> {
  const users = await runOn(sup, 'system', 'SHOW USERS YIELD user, roles WHERE user = $u RETURN roles', { u: user });
  const roles = ((users[0]?.['roles'] as string[]) ?? []).filter((r) => r !== 'PUBLIC');
  expect(roles.length, `${user} must exist with its own roles`).toBeGreaterThan(0);
  const grants: string[] = [];
  for (const role of roles) {
    const rows = await runOn(sup, 'system', `SHOW ROLE \`${role}\` PRIVILEGES AS COMMANDS`);
    for (const r of rows) {
      const cmd = String(r['command']);
      if (cmd.startsWith('GRANT ')) grants.push(cmd);
    }
  }
  return grants;
}

const INDEX_MANAGEMENT = /^GRANT INDEX MANAGEMENT ON DATABASE \* TO /;
const CONSTRAINT_MANAGEMENT = /^GRANT CONSTRAINT MANAGEMENT ON DATABASE \* TO /;
const ANY_SCHEMA_RIGHT = /^GRANT ((CREATE|DROP) (INDEX|CONSTRAINT)|INDEX MANAGEMENT|CONSTRAINT MANAGEMENT) /;
const ACCOUNTS = ['grc_admin', 'grc_writer'] as const;

let sup: Driver;
let admin: Driver;
let writer: Driver;
let firstRun: { status: number | null; stdout: string; stderr: string };

let databases: ThrowawayDatabases;
const probeUser = `grc_probe_${Math.random().toString(36).slice(2, 10)}`;
const probeRole = `grc_probe_role_${Math.random().toString(36).slice(2, 10)}`;

// An org database that exists for the whole file, made by the Desktop account, with one
// node in it that only the Desktop account wrote.
const orgDb = `org-${newOrgId()}`;

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
  databases = new ThrowawayDatabases(sup);
  await runOn(sup, 'system', 'SHOW DATABASES YIELD name RETURN count(*) AS n');

  firstRun = await runSetupNeo4j();

  admin = driverAs('grc_admin', env.adminPassword);
  writer = driverAs('grc_writer', env.writerPassword);

  databases.track(orgDb);
  await runOn(sup, 'system', `CREATE DATABASE \`${orgDb}\` IF NOT EXISTS WAIT`);
  await runOn(sup, orgDb, 'CREATE (:GrcTestProbe {owner: "desktop"})');
}, LONG);

afterAll(async () => {
  try {
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
      await databases.dropAll();
    }
  } finally {
    await admin?.close();
    await writer?.close();
    await sup?.close();
  }
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
      databases.track(name);
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

  it('holds CREATE DATABASE ON DBMS and no index or constraint right (D57, D208)', async () => {
    const grants = await ownGrants('grc_admin');
    expect(
      grants.some((g) => /^GRANT CREATE DATABASE ON DBMS TO /.test(g)),
      grants.join('\n'),
    ).toBe(true);
    expect(grants.filter((g) => ANY_SCHEMA_RIGHT.test(g))).toEqual([]);
  });

  it('cannot create an index in an org database (D208)', async () => {
    await refused(
      runOn(admin, orgDb, 'CREATE INDEX grc_probe_admin_idx IF NOT EXISTS FOR (n:GrcTestProbe) ON (n.owner)'),
    );
    const rows = await runOn(
      sup,
      orgDb,
      "SHOW INDEXES YIELD name WHERE name = 'grc_probe_admin_idx' RETURN count(*) AS n",
    );
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

describe('grc_writer reads and writes org databases, never neo4j or system (criteria 1 and 4, D144)', () => {
  it('can write and read in an org database', async () => {
    await runOn(writer, orgDb, 'CREATE (:GrcTestProbe {owner: "writer"})');
    const rows = await runOn(writer, orgDb, 'MATCH (n:GrcTestProbe) RETURN n.owner AS owner ORDER BY owner');
    expect(rows.map((r) => r['owner'])).toEqual(['desktop', 'writer']);
  });

  it('holds INDEX MANAGEMENT and CONSTRAINT MANAGEMENT on DATABASE * (D208)', async () => {
    const grants = await ownGrants('grc_writer');
    expect(
      grants.filter((g) => INDEX_MANAGEMENT.test(g)),
      grants.join('\n'),
    ).toHaveLength(1);
    expect(
      grants.filter((g) => CONSTRAINT_MANAGEMENT.test(g)),
      grants.join('\n'),
    ).toHaveLength(1);
  });

  it(
    'can create and drop an index and a uniqueness constraint in an org database (D208)',
    async () => {
      const idx = 'grc_probe_writer_idx';
      const con = 'grc_probe_writer_unique';
      try {
        await runOn(writer, orgDb, `CREATE INDEX ${idx} IF NOT EXISTS FOR (n:GrcTestProbe) ON (n.owner)`);
        await runOn(
          writer,
          orgDb,
          `CREATE CONSTRAINT ${con} IF NOT EXISTS FOR (n:GrcTestProbeUnique) REQUIRE n.key IS UNIQUE`,
        );
        const idxRows = await runOn(sup, orgDb, 'SHOW INDEXES YIELD name WHERE name = $n RETURN count(*) AS c', {
          n: idx,
        });
        const conRows = await runOn(sup, orgDb, 'SHOW CONSTRAINTS YIELD name WHERE name = $n RETURN count(*) AS c', {
          n: con,
        });
        expect(idxRows[0]?.['c']).toBe(1);
        expect(conRows[0]?.['c']).toBe(1);
        await runOn(writer, orgDb, `DROP CONSTRAINT ${con} IF EXISTS`);
        await runOn(writer, orgDb, `DROP INDEX ${idx} IF EXISTS`);
      } finally {
        await runOn(sup, orgDb, `DROP CONSTRAINT ${con} IF EXISTS`).catch(() => undefined);
        await runOn(sup, orgDb, `DROP INDEX ${idx} IF EXISTS`).catch(() => undefined);
      }
    },
    LONG,
  );

  it('cannot write in the default neo4j database', async () => {
    await refused(runOn(writer, 'neo4j', 'CREATE (:GrcTestProbe {owner: "writer"})'));
    const rows = await runOn(sup, 'neo4j', 'MATCH (n:GrcTestProbe {owner: "writer"}) RETURN count(n) AS n');
    expect(rows[0]?.['n']).toBe(0);
  });

  it('holds no DBMS privilege and nothing on system beyond access, through its own roles', async () => {
    const users = await runOn(sup, 'system', 'SHOW USERS YIELD user, roles WHERE user = $u RETURN roles', {
      u: 'grc_writer',
    });
    const roles = ((users[0]?.['roles'] as string[]) ?? []).filter((r) => r !== 'PUBLIC');
    expect(roles.length).toBeGreaterThan(0);
    const grants: string[] = [];
    for (const role of roles) {
      const rows = await runOn(sup, 'system', `SHOW ROLE \`${role}\` PRIVILEGES AS COMMANDS`);
      for (const r of rows) {
        const cmd = String(r['command']);
        if (cmd.startsWith('GRANT ')) grants.push(cmd);
      }
    }
    expect(grants.filter((c) => /\bON DBMS\b/.test(c))).toEqual([]);
    expect(grants.filter((c) => /\bON (DATABASE|GRAPH) `?system`?\b/.test(c) && !/^GRANT ACCESS\b/.test(c))).toEqual(
      [],
    );
    // Database-level rights on every database (`*`) would reach system too (stop, alter).
    expect(
      grants.filter(
        (c) =>
          /\bON DATABASE \*/.test(c) &&
          !/^GRANT (ACCESS|(CREATE|DROP|SHOW) (INDEX|CONSTRAINT)|INDEX MANAGEMENT|CONSTRAINT MANAGEMENT|NAME MANAGEMENT|CREATE NEW (NODE )?LABEL|CREATE NEW (RELATIONSHIP )?TYPE|CREATE NEW (PROPERTY )?NAME)\b/.test(
            c,
          ),
      ),
    ).toEqual([]);
  });

  it('cannot change a database setting in system', async () => {
    await refused(runOn(writer, 'system', `ALTER DATABASE \`${orgDb}\` SET ACCESS READ ONLY`));
    const rows = await runOn(sup, 'system', 'SHOW DATABASES YIELD name, access WHERE name = $name', { name: orgDb });
    expect(rows[0]?.['access']).toBe('read-write');
  });

  it('cannot create a database alias in system', async () => {
    const alias = `grc-probe-alias-${newOrgId().slice(0, 8)}`;
    await refused(runOn(writer, 'system', `CREATE ALIAS \`${alias}\` FOR DATABASE \`${orgDb}\``));
    await runOn(sup, 'system', `DROP ALIAS \`${alias}\` IF EXISTS FOR DATABASE`).catch(() => undefined);
  });

  it(
    'cannot run CREATE DATABASE',
    async () => {
      const name = `org-${newOrgId()}`;
      databases.track(name);
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
