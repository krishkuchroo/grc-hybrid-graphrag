// M0-005 criterion 1: 28 accounts exist (7 roles × 4 clearances), each with read-only privileges.
// Decisions: D50, D51, D57 (one restricted account per role and clearance), D73 (28 read-only
// accounts), D144.
//
// Contract:
// - `queryAccountName(role, clearance)` in packages/api/src/graph/query-accounts.ts returns
//   `grc_ro_<role>_<clearance>`, and throws for an unknown role or clearance (fail safe).
// - `pnpm setup:neo4j` (packages/infra/scripts/setup-neo4j.ts) also creates those 28 accounts and
//   their privileges. It is safe to re-run: a second run changes no user, role or privilege and
//   keeps every password. It never prints a password.
// - Each account is active, needs no password change, and holds only reading rights: ACCESS,
//   TRAVERSE, READ, MATCH (plus SHOW INDEX/CONSTRAINT and plain EXECUTE FUNCTION/PROCEDURE).
//   No write, no management, no DBMS rights (no IMPERSONATE, no boosted or admin procedures),
//   nothing on `system` beyond ACCESS, and no built-in role that can write.
//   D208 gives INDEX and CONSTRAINT MANAGEMENT to grc_writer only; no query account gets
//   any index or constraint right beyond SHOW.
// - Each account can log in with what the builder keeps in `.env`: `GraphService.readAs` works
//   for all 28.
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABELS, ROLES } from '@grc/shared';
import {
  ACCOUNTS,
  LONG,
  createFixtureOrg,
  ThrowawayDatabases,
  loadQueryAccountName,
  newGraph,
  requireReadAs,
  runOn,
  runSetupNeo4j,
  secretValues,
  superDriver,
  type FixtureOrg,
  type QueryGraph,
} from './helpers.js';

let sup: Driver;
let databases: ThrowawayDatabases;
let graph: QueryGraph | undefined;
let org: FixtureOrg;
let firstRun: { status: number | null; stdout: string; stderr: string };

const EXPECTED_NAMES = ACCOUNTS.map((a) => a.name).sort();

interface Snapshot {
  users: Record<string, unknown>[];
  privileges: Record<string, string[]>;
}

async function snapshot(): Promise<Snapshot> {
  const users = await runOn(
    sup,
    'system',
    `SHOW USERS YIELD user, roles, passwordChangeRequired, suspended, home
     WHERE user STARTS WITH 'grc_ro_' RETURN user, roles, passwordChangeRequired, suspended, home ORDER BY user`,
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

async function grantsOf(user: string): Promise<{ roles: string[]; grants: string[] }> {
  const rows = await runOn(sup, 'system', 'SHOW USERS YIELD user, roles WHERE user = $u RETURN roles', { u: user });
  const roles = ((rows[0]?.['roles'] as string[]) ?? []).filter((r) => r !== 'PUBLIC');
  const grants: string[] = [];
  for (const role of roles) {
    const privs = await runOn(sup, 'system', `SHOW ROLE \`${role}\` PRIVILEGES AS COMMANDS`);
    for (const p of privs) {
      const cmd = String(p['command']);
      if (cmd.startsWith('GRANT ')) grants.push(cmd);
    }
  }
  return { roles, grants };
}

const READING = /^GRANT (ACCESS|TRAVERSE|READ|MATCH|SHOW (INDEX|CONSTRAINT)|EXECUTE (FUNCTION|PROCEDURE)) /;

beforeAll(async () => {
  sup = superDriver();
  databases = new ThrowawayDatabases(sup);
  firstRun = runSetupNeo4j();
  org = await createFixtureOrg(sup, databases);
  try {
    graph = newGraph();
  } catch {
    graph = undefined;
  }
}, LONG);

afterAll(async () => {
  try {
    await graph?.close();
    if (databases) await databases.dropAll();
  } finally {
    await sup?.close();
  }
}, LONG);

describe('queryAccountName', () => {
  it.each(ACCOUNTS.map((a) => [a.role, a.clearance, a.name] as const))(
    '(%s, %s) is %s',
    async (role, clearance, name) => {
      const queryAccountName = await loadQueryAccountName();
      expect(queryAccountName(role, clearance)).toBe(name);
    },
  );

  it('gives 28 different names', async () => {
    const queryAccountName = await loadQueryAccountName();
    const names = new Set(ROLES.flatMap((r) => LABELS.map((l) => queryAccountName(r, l))));
    expect(names.size).toBe(28);
  });

  it.each([
    ['superuser', 'public'],
    ['admin', 'secret'],
    ['Admin', 'public'],
    ['admin', 'PUBLIC'],
    ['', ''],
    ['admin`; DROP', 'public'],
  ])('throws for role %j and clearance %j', async (role, clearance) => {
    const queryAccountName = await loadQueryAccountName();
    expect(() => queryAccountName(role, clearance)).toThrow();
  });
});

describe('pnpm setup:neo4j creates the 28 accounts (criterion 1)', () => {
  it('exits 0', () => {
    expect(firstRun.status, firstRun.stderr).toBe(0);
  });

  it('never prints a password', () => {
    const out = firstRun.stdout + firstRun.stderr;
    for (const secret of secretValues()) expect(out.includes(secret)).toBe(false);
  });

  it('creates exactly the 28 grc_ro_<role>_<clearance> accounts', async () => {
    const snap = await snapshot();
    expect(snap.users.map((u) => u['user'])).toEqual(EXPECTED_NAMES);
  });

  it('leaves each account active with no forced password change', async () => {
    const snap = await snapshot();
    expect(snap.users).toHaveLength(28);
    for (const u of snap.users) {
      expect(u['suspended'], String(u['user'])).toBe(false);
      expect(u['passwordChangeRequired'], String(u['user'])).toBe(false);
    }
  });

  it(
    'changes nothing when run a second time',
    async () => {
      const before = await snapshot();
      expect(before.users).toHaveLength(28);
      const second = runSetupNeo4j();
      expect(second.status, second.stderr).toBe(0);
      expect(await snapshot()).toEqual(before);
    },
    LONG,
  );
});

describe.each(ACCOUNTS)('$name holds read-only privileges (criterion 1)', (account) => {
  it('has its own roles and none of the built-in roles that can write', async () => {
    const { roles } = await grantsOf(account.name);
    expect(roles.length).toBeGreaterThan(0);
    for (const builtIn of ['admin', 'architect', 'publisher', 'editor']) expect(roles).not.toContain(builtIn);
  });

  it('is granted reading rights only', async () => {
    const { grants } = await grantsOf(account.name);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.filter((g) => !READING.test(g))).toEqual([]);
  });

  it("holds no index or constraint management right (D208: those are the writer's only)", async () => {
    const { roles, grants } = await grantsOf(account.name);
    expect(roles.length, `${account.name} must exist with its own roles`).toBeGreaterThan(0);
    expect(
      grants.filter((g) => /^GRANT ((CREATE|DROP) (INDEX|CONSTRAINT)|INDEX MANAGEMENT|CONSTRAINT MANAGEMENT) /.test(g)),
    ).toEqual([]);
  });

  it('holds nothing on DBMS except plain function and procedure execution', async () => {
    const { roles, grants } = await grantsOf(account.name);
    expect(roles.length, `${account.name} must exist with its own roles`).toBeGreaterThan(0);
    expect(grants.filter((g) => /\bON DBMS\b/.test(g) && !/^GRANT EXECUTE (FUNCTION|PROCEDURE) /.test(g))).toEqual([]);
  });

  it('holds nothing on system beyond access', async () => {
    const { roles, grants } = await grantsOf(account.name);
    expect(roles.length, `${account.name} must exist with its own roles`).toBeGreaterThan(0);
    expect(
      grants.filter((g) => /\bON (DATABASE|GRAPH|HOME DATABASE) `?system`?\b/.test(g) && !/^GRANT ACCESS\b/.test(g)),
    ).toEqual([]);
  });

  it('logs in through GraphService.readAs', async () => {
    const rows = await requireReadAs(graph).readAs(
      org.orgId,
      account.role,
      account.clearance,
      async (tx) => (await tx.run('RETURN 1 AS one')).records.map((r) => r.get('one') as number),
      { timeoutMs: 30_000 },
    );
    expect(rows).toEqual([1]);
  });
});
