// TEST-002 criteria 1, 2 and 5: the test-env doctor's decision logic, with fake probes (D180).
// Decisions: D180 (check-only doctor, one line per item, OK or missing), D57 (never print a
// secret), D61 (127.0.0.1 only), D65 (Caddy root and the hosts line), D73 (the 28 grc_ro_*
// accounts and their DENYs), D164 (error type or code only, never the message).
//
// Contract these tests hold the builder to:
// - `packages/infra/scripts/test-env-checks.ts` is pure: importing it touches no database,
//   container, file, keychain or network. It exports:
//     ITEMS: readonly { id: ItemId }[]  (more fields allowed), in print order, with the ids
//       'stack'       127.0.0.1:5433 (Postgres, dev relay) and 127.0.0.1:8333 (SeaweedFS) answer
//       'migrations'  every `_journal.json` entry is in drizzle.__drizzle_migrations
//       'neo4j'       Neo4j answers and each of the 28 grc_ro_* roles has every DENY setup:neo4j gives it
//       'env'         the required .env keys are present (names only)
//       'caddy-root'  Caddy's local root is trusted in the Mac's keychain
//       'hosts'       /etc/hosts has `127.0.0.1 grc.localhost`
//     REQUIRED_ENV_KEYS: readonly string[]  (at least every key named in `.env.example`)
//     runChecks(probes: DoctorProbes): Promise<{ items: { id; ok; reason }[]; lines: string[]; exitCode: number }>
// - DoctorProbes (the command wires real, read-only probes; these tests pass fakes):
//     portOpen(host: string, port: number): Promise<boolean>
//     journal(): Promise<{ tag: string; when: number }[]>          entries of _journal.json
//     appliedMigrations(): Promise<number[]>                        created_at of each drizzle.__drizzle_migrations row
//     queryRolePrivileges(): Promise<Record<string, string[]>>      each grc_ro_* role found → its
//                                                                   `SHOW ROLE … PRIVILEGES AS COMMANDS` lines, as Neo4j prints them
//     env(): Promise<Record<string, string>>                        settings (environment, then .env), name → value
//     caddyRootTrusted(): Promise<boolean>
//     hostsFile(): Promise<string>                                  the text of /etc/hosts
// - `lines` has one line per item, in ITEMS order, each `OK <id>…` or `missing <id>…` with a
//   short reason. `exitCode` is 0 only if every item is OK.
// - A probe that throws or rejects makes its item `missing` with a reason (the error's type or
//   code, D164), never OK, and never stops the other items being checked.
// - The expected DENYs come from `queryAccountPrivileges` / `QUERY_ACCOUNTS` in
//   packages/api/src/graph/. Neo4j prints them in its own form (backticked role, `NODE` for
//   `NODES`, `RELATIONSHIP` for `RELATIONSHIPS`); the doctor must match them anyway.
//
// The Neo4j fixture `tests/fixtures/test-env/neo4j-query-role-privileges.json` is a read-only
// `SHOW ROLE … PRIVILEGES AS COMMANDS` recording of the live 28 roles (2026-09-28).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(HERE, '..', '..');
const ROOT = resolve(INFRA, '..', '..');
const CHECKS = join(INFRA, 'scripts', 'test-env-checks.ts');
const FIXTURE = join(INFRA, 'tests', 'fixtures', 'test-env', 'neo4j-query-role-privileges.json');
const API_GRAPH = join(ROOT, 'packages', 'api', 'src', 'graph');

type ItemId = 'stack' | 'migrations' | 'neo4j' | 'env' | 'caddy-root' | 'hosts';
const IDS: ItemId[] = ['stack', 'migrations', 'neo4j', 'env', 'caddy-root', 'hosts'];

interface DoctorProbes {
  portOpen(host: string, port: number): Promise<boolean>;
  journal(): Promise<{ tag: string; when: number }[]>;
  appliedMigrations(): Promise<number[]>;
  queryRolePrivileges(): Promise<Record<string, string[]>>;
  env(): Promise<Record<string, string>>;
  caddyRootTrusted(): Promise<boolean>;
  hostsFile(): Promise<string>;
}
interface Item {
  id: string;
  ok: boolean;
  reason: string;
}
interface Result {
  items: Item[];
  lines: string[];
  exitCode: number;
}
interface ChecksModule {
  ITEMS: readonly { id: string }[];
  REQUIRED_ENV_KEYS: readonly string[];
  runChecks(probes: DoctorProbes): Promise<Result>;
}

// Loaded on use, so a missing file fails each test with a clear message.
async function checks(): Promise<ChecksModule> {
  if (!existsSync(CHECKS)) throw new Error('packages/infra/scripts/test-env-checks.ts does not exist yet');
  const mod = (await import(/* @vite-ignore */ CHECKS)) as Partial<ChecksModule>;
  if (typeof mod.runChecks !== 'function') throw new Error('test-env-checks.ts must export runChecks');
  if (!Array.isArray(mod.ITEMS)) throw new Error('test-env-checks.ts must export ITEMS');
  if (!Array.isArray(mod.REQUIRED_ENV_KEYS)) throw new Error('test-env-checks.ts must export REQUIRED_ENV_KEYS');
  return mod as ChecksModule;
}

// ---------------------------------------------------------------------------------------------
// Fakes: a healthy environment, and ways to break one thing at a time.

const SENTINEL = 'S3NTINEL-do-not-print-7f3a9c';

const ENV_EXAMPLE_KEYS = readFileSync(join(ROOT, '.env.example'), 'utf8')
  .split('\n')
  .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
  .filter((k): k is string => k !== undefined);

const ROLE_PRIVILEGES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>;
const ROLE_NAMES = Object.keys(ROLE_PRIVILEGES).sort();

const JOURNAL = [
  { tag: '0000_roles_and_extensions', when: 1790496000000 },
  { tag: '0001_pgboss', when: 1790582400000 },
  { tag: '0002_identity_and_rls', when: 1790668800000 },
  { tag: '0003_audit', when: 1790755200000 },
];

function healthyEnv(keys: readonly string[]): Record<string, string> {
  // Every value holds the sentinel, so any value printed anywhere is caught.
  return Object.fromEntries(keys.map((k, i) => [k, `${SENTINEL}-${i}`]));
}

function copyPrivileges(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(ROLE_PRIVILEGES).map(([r, cmds]) => [r, [...cmds]]));
}

interface Fake {
  probes: DoctorProbes;
  portCalls: [string, number][];
}

function fake(overrides: Partial<DoctorProbes> = {}, envKeys: readonly string[] = ENV_EXAMPLE_KEYS): Fake {
  const portCalls: [string, number][] = [];
  const probes: DoctorProbes = {
    async portOpen(host, port) {
      portCalls.push([host, port]);
      return true;
    },
    journal: async () => JOURNAL.map((e) => ({ ...e })),
    appliedMigrations: async () => JOURNAL.map((e) => e.when),
    queryRolePrivileges: async () => copyPrivileges(),
    env: async () => healthyEnv(envKeys),
    caddyRootTrusted: async () => true,
    hostsFile: async () =>
      '##\n# Host Database\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1 localhost\n127.0.0.1 grc.localhost\n',
    ...overrides,
  };
  if (overrides.portOpen) {
    const inner = overrides.portOpen;
    probes.portOpen = async (host, port) => {
      portCalls.push([host, port]);
      return inner(host, port);
    };
  }
  return { probes, portCalls };
}

async function run(overrides: Partial<DoctorProbes> = {}): Promise<Result> {
  const mod = await checks();
  return mod.runChecks(fake(overrides, mod.REQUIRED_ENV_KEYS).probes);
}

const LINE = /^(OK|missing)\s+([a-z0-9-]+)\b/;

function lineFor(result: Result, id: ItemId): string {
  const found = result.lines.filter((l) => LINE.exec(l)?.[2] === id);
  expect(found, `exactly one line for ${id} in:\n${result.lines.join('\n')}`).toHaveLength(1);
  return found[0]!;
}

function itemFor(result: Result, id: ItemId): Item {
  const found = result.items.find((i) => i.id === id);
  expect(found, `an item ${id}`).toBeDefined();
  return found!;
}

function expectOnlyMissing(result: Result, id: ItemId): void {
  expect(lineFor(result, id)).toMatch(/^missing\s/);
  expect(itemFor(result, id).ok).toBe(false);
  expect(itemFor(result, id).reason.trim()).not.toBe('');
  for (const other of IDS.filter((i) => i !== id)) expect(lineFor(result, other)).toMatch(/^OK\s/);
  expect(result.exitCode).not.toBe(0);
}

function removeFirst(list: string[], pattern: RegExp): string {
  const idx = list.findIndex((c) => pattern.test(c));
  expect(idx, `a command matching ${pattern}`).toBeGreaterThanOrEqual(0);
  return list.splice(idx, 1)[0]!;
}

// ---------------------------------------------------------------------------------------------

describe('the fixture matches the code the doctor compares with (D73)', () => {
  it('records exactly the 28 grc_ro_* roles of QUERY_ACCOUNTS', async () => {
    const { QUERY_ACCOUNTS } = (await import(/* @vite-ignore */ join(API_GRAPH, 'query-accounts.ts'))) as {
      QUERY_ACCOUNTS: readonly { name: string }[];
    };
    expect(ROLE_NAMES).toEqual(QUERY_ACCOUNTS.map((a) => a.name).sort());
    expect(ROLE_NAMES).toHaveLength(28);
  });

  it('holds, per role, as many DENYs as queryAccountPrivileges gives it', async () => {
    const { QUERY_ACCOUNTS } = (await import(/* @vite-ignore */ join(API_GRAPH, 'query-accounts.ts'))) as {
      QUERY_ACCOUNTS: readonly { name: string; role: string; clearance: string }[];
    };
    const { queryAccountPrivileges } = (await import(/* @vite-ignore */ join(API_GRAPH, 'privileges.ts'))) as {
      queryAccountPrivileges(role: string, clearance: string): string[];
    };
    for (const a of QUERY_ACCOUNTS) {
      const expected = queryAccountPrivileges(a.role, a.clearance).filter((s) => s.startsWith('DENY '));
      const recorded = (ROLE_PRIVILEGES[a.name] ?? []).filter((s) => s.startsWith('DENY '));
      expect(recorded.length, a.name).toBe(expected.length);
    }
  });
});

describe('the items (criterion 1)', () => {
  it('lists the six items, in order', async () => {
    const { ITEMS } = await checks();
    expect(ITEMS.map((i) => i.id)).toEqual(IDS);
  });

  it('requires every key named in .env.example', async () => {
    const { REQUIRED_ENV_KEYS } = await checks();
    expect(ENV_EXAMPLE_KEYS.length).toBeGreaterThan(0);
    for (const key of ENV_EXAMPLE_KEYS) expect(REQUIRED_ENV_KEYS, key).toContain(key);
  });
});

describe('everything present (criterion 1)', () => {
  it('prints one OK line per item and exits 0', async () => {
    const result = await run();
    expect(result.lines).toHaveLength(IDS.length);
    expect(result.lines.map((l) => LINE.exec(l)?.[2])).toEqual(IDS);
    for (const id of IDS) expect(lineFor(result, id)).toMatch(/^OK\s/);
    expect(result.items.every((i) => i.ok)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('asks only 127.0.0.1, on 5433 and 8333 (D61)', async () => {
    const mod = await checks();
    const f = fake({}, mod.REQUIRED_ENV_KEYS);
    await mod.runChecks(f.probes);
    expect(f.portCalls.length).toBeGreaterThan(0);
    for (const [host] of f.portCalls) expect(host).toBe('127.0.0.1');
    const ports = f.portCalls.map(([, p]) => p);
    expect(ports).toContain(5433);
    expect(ports).toContain(8333);
  });

  it('accepts the hosts line with tabs, extra names and a trailing comment', async () => {
    const result = await run({ hostsFile: async () => '127.0.0.1\tlocalhost   grc.localhost # grc\n' });
    expect(lineFor(result, 'hosts')).toMatch(/^OK\s/);
    expect(result.exitCode).toBe(0);
  });

  it('does not mind a migrations row that is not in the journal', async () => {
    const result = await run({
      appliedMigrations: async () => [...JOURNAL.map((e) => e.when), 1790841600000],
    });
    expect(lineFor(result, 'migrations')).toMatch(/^OK\s/);
    expect(result.exitCode).toBe(0);
  });
});

describe('one item missing (criterion 1)', () => {
  it('stack: Postgres on 127.0.0.1:5433 does not answer, and the line says 5433', async () => {
    const result = await run({ portOpen: async (_h, port) => port !== 5433 });
    expectOnlyMissing(result, 'stack');
    expect(lineFor(result, 'stack')).toContain('5433');
  });

  it('stack: SeaweedFS on 127.0.0.1:8333 does not answer, and the line says 8333', async () => {
    const result = await run({ portOpen: async (_h, port) => port !== 8333 });
    expectOnlyMissing(result, 'stack');
    expect(lineFor(result, 'stack')).toContain('8333');
  });

  it('migrations: a journal entry not applied is named by its tag', async () => {
    const result = await run({ appliedMigrations: async () => JOURNAL.slice(0, 3).map((e) => e.when) });
    expectOnlyMissing(result, 'migrations');
    expect(lineFor(result, 'migrations')).toContain('0003_audit');
  });

  it('migrations: no migrations applied at all', async () => {
    const result = await run({ appliedMigrations: async () => [] });
    expectOnlyMissing(result, 'migrations');
  });

  it('neo4j: a missing grc_ro_* role is named', async () => {
    const result = await run({
      queryRolePrivileges: async () => {
        const p = copyPrivileges();
        delete p['grc_ro_auditor_confidential'];
        return p;
      },
    });
    expectOnlyMissing(result, 'neo4j');
    expect(lineFor(result, 'neo4j')).toContain('grc_ro_auditor_confidential');
  });

  it('neo4j: no grc_ro_* roles at all', async () => {
    const result = await run({ queryRolePrivileges: async () => ({}) });
    expectOnlyMissing(result, 'neo4j');
  });

  const DENY_KINDS: [string, RegExp][] = [
    ['the audit outbox DENY TRAVERSE', /^DENY TRAVERSE .*AuditOutbox/],
    ['DENY LOAD', /^DENY LOAD /],
    ['the apoc.load.* DENY', /^DENY EXECUTE PROCEDURE apoc\.load\.\*/],
    ['the apoc.bolt.* DENY', /^DENY EXECUTE PROCEDURE apoc\.bolt\.\*/],
  ];

  it.each(DENY_KINDS)('neo4j: %s missing on one of the 28 roles names that role only', async (_what, pattern) => {
    const target = 'grc_ro_analyst_internal';
    const result = await run({
      queryRolePrivileges: async () => {
        const p = copyPrivileges();
        removeFirst(p[target]!, pattern);
        return p;
      },
    });
    expectOnlyMissing(result, 'neo4j');
    const line = lineFor(result, 'neo4j');
    expect(line).toContain(target);
    for (const other of ROLE_NAMES.filter((r) => r !== target)) expect(line).not.toContain(other);
  });

  it('neo4j: a DENY turned into a GRANT still counts as missing', async () => {
    const target = 'grc_ro_viewer_restricted';
    const result = await run({
      queryRolePrivileges: async () => {
        const p = copyPrivileges();
        const cmd = removeFirst(p[target]!, /^DENY LOAD /);
        p[target]!.push(cmd.replace(/^DENY /, 'GRANT '));
        return p;
      },
    });
    expectOnlyMissing(result, 'neo4j');
    expect(lineFor(result, 'neo4j')).toContain(target);
  });

  it('env: an absent key is named, and no value is printed', async () => {
    const mod = await checks();
    const keys = mod.REQUIRED_ENV_KEYS.filter((k) => k !== 'NEO4J_QUERY_SECRET');
    const result = await mod.runChecks(fake({}, keys).probes);
    expectOnlyMissing(result, 'env');
    expect(lineFor(result, 'env')).toContain('NEO4J_QUERY_SECRET');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('env: a key with an empty value counts as missing', async () => {
    const mod = await checks();
    const env = healthyEnv(mod.REQUIRED_ENV_KEYS);
    env['BETTER_AUTH_SECRET'] = '';
    const result = await mod.runChecks(fake({ env: async () => env }, mod.REQUIRED_ENV_KEYS).probes);
    expectOnlyMissing(result, 'env');
    expect(lineFor(result, 'env')).toContain('BETTER_AUTH_SECRET');
  });

  it('caddy-root: the root is not trusted in the keychain', async () => {
    const result = await run({ caddyRootTrusted: async () => false });
    expectOnlyMissing(result, 'caddy-root');
  });

  it.each([
    ['an empty hosts file', ''],
    ['the line commented out', '# 127.0.0.1 grc.localhost\n'],
    ['another address', '127.0.0.2 grc.localhost\n'],
    ['0.0.0.0', '0.0.0.0 grc.localhost\n'],
    ['only the IPv6 loopback', '::1 grc.localhost\n'],
    ['a longer name', '127.0.0.1 grc.localhost.example\n'],
    ['a different name', '127.0.0.1 localhost\n'],
  ])('hosts: %s', async (_what, text) => {
    const result = await run({ hostsFile: async () => text });
    expectOnlyMissing(result, 'hosts');
  });
});

describe("an item it can't check is missing, never OK (criterion 2)", () => {
  const failures: [ItemId, keyof DoctorProbes][] = [
    ['stack', 'portOpen'],
    ['migrations', 'appliedMigrations'],
    ['migrations', 'journal'],
    ['neo4j', 'queryRolePrivileges'],
    ['env', 'env'],
    ['caddy-root', 'caddyRootTrusted'],
    ['hosts', 'hostsFile'],
  ];

  it.each(failures)('%s: its probe %s throws; the item is missing with the error code', async (id, probe) => {
    const err = Object.assign(new Error('probe failed'), { code: 'EACCES' });
    const result = await run({
      [probe]: async () => {
        throw err;
      },
    } as Partial<DoctorProbes>);
    expectOnlyMissing(result, id);
    expect(lineFor(result, id)).toContain('EACCES');
    expect(result.lines).toHaveLength(IDS.length);
  });

  it('a probe that throws synchronously does not crash the doctor', async () => {
    const result = await run({
      caddyRootTrusted: (() => {
        throw new TypeError('keychain unreadable');
      }) as DoctorProbes['caddyRootTrusted'],
    });
    expectOnlyMissing(result, 'caddy-root');
  });

  it('Neo4j refusing the login: missing, named by the error code', async () => {
    const err = Object.assign(new Error('The client is unauthorized due to authentication failure.'), {
      name: 'Neo4jError',
      code: 'Neo.ClientError.Security.Unauthorized',
    });
    const result = await run({
      queryRolePrivileges: async () => {
        throw err;
      },
    });
    expectOnlyMissing(result, 'neo4j');
    expect(lineFor(result, 'neo4j')).toContain('Neo.ClientError.Security.Unauthorized');
  });

  it('every probe failing: six missing lines and a non-zero exit', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    const result = await run({
      portOpen: boom,
      journal: boom,
      appliedMigrations: boom,
      queryRolePrivileges: boom,
      env: boom,
      caddyRootTrusted: boom,
      hostsFile: boom,
    });
    expect(result.lines).toHaveLength(IDS.length);
    for (const id of IDS) expect(lineFor(result, id)).toMatch(/^missing\s/);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('never prints a secret (criterion 5, D57, D164)', () => {
  it('a thrown error holding a password URL shows only its type or code', async () => {
    const leaky = Object.assign(
      new Error(`connect failed for postgres://grc_migrator:${SENTINEL}@127.0.0.1:5433/grc`),
      { code: '28P01', detail: SENTINEL, url: `postgres://grc_migrator:${SENTINEL}@127.0.0.1:5433/grc` },
    );
    const result = await run({
      appliedMigrations: async () => {
        throw leaky;
      },
    });
    expectOnlyMissing(result, 'migrations');
    expect(lineFor(result, 'migrations')).toContain('28P01');
    const all = JSON.stringify(result);
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('postgres://');
    expect(all).not.toContain('connect failed');
  });

  it('a thrown non-error value holding a secret prints none of it', async () => {
    const result = await run({
      hostsFile: async () => {
        throw `${SENTINEL} as a string`;
      },
    });
    expectOnlyMissing(result, 'hosts');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('no .env value appears anywhere in the result, all OK or not', async () => {
    const ok = await run();
    expect(JSON.stringify(ok)).not.toContain(SENTINEL);
    const broken = await run({ caddyRootTrusted: async () => false, portOpen: async () => false });
    expect(JSON.stringify(broken)).not.toContain(SENTINEL);
  });
});
