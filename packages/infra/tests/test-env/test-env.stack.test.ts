// TEST-002 criteria 1 and 3: `pnpm test:env` against the real stack (D180).
// Decisions: D180 (check-only doctor), D57 (never print a secret), D61, D65, D73, D176 (never
// change live state).
//
// What it holds the command to:
// - Run from the repo root, it prints one line per item of ITEMS in
//   packages/infra/scripts/test-env-checks.ts, each `OK <id>…` or `missing <id>…`, and with the
//   stack healthy it exits 0 (every line OK).
// - It changes nothing (criterion 3). Before and after the run, this test takes a read-only
//   snapshot of: the Neo4j grc_* users and every grc_* role's privileges (SHOW … AS COMMANDS,
//   as the Desktop `neo4j` account); the rows of drizzle.__drizzle_migrations and the grc_*
//   Postgres roles (as the superuser on 127.0.0.1:5433); the grc-* containers' states
//   (`docker ps`); the Caddy certificates in the keychain (`security find-certificate`); the
//   hashes of `.env` and /etc/hosts; and `git status` of this checkout. All must be identical.
// - No `.env` value appears in its output (D57).
//
// Needs the running stack: the grc-* containers with the dev relay, Neo4j Desktop on
// 127.0.0.1:7687 with `pnpm setup:neo4j` applied, Caddy's root trusted and the hosts line in
// place. If any of those is missing, this test fails and the doctor's lines say which.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CHECKS = join(ROOT, 'packages', 'infra', 'scripts', 'test-env-checks.ts');
const LONG = 180_000;

function findDotEnv(): string | undefined {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

function dotEnv(): Record<string, string> {
  const file = findDotEnv();
  const out: Record<string, string> = {};
  if (!file) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

function setting(name: string): string {
  const v = process.env[name] || dotEnv()[name];
  if (!v) throw new Error(`Test set-up: ${name} is not set in the environment or in .env`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Read-only snapshot of the shared state the doctor must leave alone.

interface PgClient {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function postgresState(): Promise<unknown> {
  const require = createRequire(join(ROOT, 'packages', 'api', 'package.json'));
  const { Client } = require('pg') as { Client: new (o: { connectionString: string }) => PgClient };
  const database = new URL(setting('DATABASE_URL_MIGRATE')).pathname.slice(1) || 'grc';
  const password = encodeURIComponent(setting('POSTGRES_PASSWORD'));
  const client = new Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:5433/${database}` });
  await client.connect();
  try {
    const migrations = await client.query(
      'SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    const roles = await client.query(
      `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls
         FROM pg_roles WHERE rolname LIKE 'grc\\_%' ORDER BY rolname`,
    );
    return { migrations: migrations.rows, roles: roles.rows };
  } finally {
    await client.end();
  }
}

async function neo4jState(): Promise<unknown> {
  const driver = neo4j.driver('bolt://127.0.0.1:7687', neo4j.auth.basic('neo4j', setting('NEO4J_DESKTOP_PASSWORD')));
  const session = driver.session({ database: 'system' });
  try {
    const users = (
      await session.run(
        `SHOW USERS YIELD user, roles, passwordChangeRequired, suspended
         WHERE user STARTS WITH 'grc_' RETURN user, roles, passwordChangeRequired, suspended ORDER BY user`,
      )
    ).records.map((r) => ({ ...r.toObject(), roles: [...(r.get('roles') as string[])].sort() }));
    const roleNames = (
      await session.run("SHOW ROLES YIELD role WHERE role STARTS WITH 'grc_' RETURN role ORDER BY role")
    ).records.map((r) => r.get('role') as string);
    const privileges: Record<string, string[]> = {};
    for (const role of roleNames) {
      const rows = await session.run(`SHOW ROLE \`${role}\` PRIVILEGES AS COMMANDS`);
      privileges[role] = rows.records.map((r) => String(r.get('command'))).sort();
    }
    return { users, privileges };
  } finally {
    await session.close();
    await driver.close();
  }
}

function command(cmd: string, args: string[], cwd = ROOT): string {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return `status=${r.status}\n${r.stdout ?? ''}`;
}

function fileHash(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

interface Snapshot {
  postgres: unknown;
  neo4j: unknown;
  containers: string;
  keychain: string;
  envFile: string;
  hosts: string;
  git: string;
}

async function snapshot(): Promise<Snapshot> {
  return {
    postgres: await postgresState(),
    neo4j: await neo4jState(),
    containers: command('docker', ['ps', '-a', '--filter', 'name=grc-', '--format', '{{.Names}} {{.ID}} {{.State}}']),
    keychain: command('security', ['find-certificate', '-a', '-c', 'Caddy', '-Z']),
    envFile: fileHash(findDotEnv() ?? join(ROOT, '.env')),
    hosts: fileHash('/etc/hosts'),
    git: command('git', ['status', '--porcelain', '--untracked-files=all']),
  };
}

// ---------------------------------------------------------------------------------------------

let before: Snapshot;
let after: Snapshot;
let doctor: { status: number | null; stdout: string; stderr: string };

beforeAll(async () => {
  before = await snapshot();
  const r = spawnSync('pnpm', ['--silent', 'test:env'], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: LONG - 60_000,
  });
  doctor = { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
  after = await snapshot();
}, LONG);

const LINE = /^(OK|missing)\s+([a-z-]+)\b/;

describe('pnpm test:env on the healthy stack (criterion 1)', () => {
  it('exits 0', () => {
    expect(doctor.status, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
  });

  it('prints one OK line per item, in order', async () => {
    expect(existsSync(CHECKS), 'packages/infra/scripts/test-env-checks.ts exists').toBe(true);
    const { ITEMS } = (await import(/* @vite-ignore */ CHECKS)) as { ITEMS: readonly { id: string }[] };
    const lines = doctor.stdout.split('\n').filter((l) => LINE.test(l));
    expect(
      lines.map((l) => LINE.exec(l)![2]),
      doctor.stdout,
    ).toEqual(ITEMS.map((i) => i.id));
    for (const l of lines) expect(l).toMatch(/^OK\s/);
  });

  it('never prints a .env value (D57)', () => {
    const out = doctor.stdout + doctor.stderr;
    const values = Object.values(dotEnv()).filter((v) => v.length >= 8);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(out.includes(v)).toBe(false);
  });
});

describe('pnpm test:env changes nothing (criterion 3, D176)', () => {
  it('the snapshot really sees the live state (so the comparisons below mean something)', () => {
    const graph = before.neo4j as { privileges: Record<string, string[]> };
    expect(Object.keys(graph.privileges).filter((r) => r.startsWith('grc_ro_'))).toHaveLength(28);
    const pg = before.postgres as { migrations: unknown[]; roles: unknown[] };
    expect(pg.migrations.length).toBeGreaterThan(0);
    expect(pg.roles.length).toBeGreaterThan(0);
    expect(before.containers).toMatch(/^status=0\n/);
    expect(before.containers).toContain('grc-postgres');
    expect(before.hosts).not.toBe('absent');
    expect(before.envFile).not.toBe('absent');
  });

  it('leaves the Neo4j grc_* users and role privileges as they were', () => {
    expect(after.neo4j).toEqual(before.neo4j);
  });

  it('leaves the migrations table and the grc_* Postgres roles as they were', () => {
    expect(after.postgres).toEqual(before.postgres);
  });

  it('starts, stops or recreates no grc-* container', () => {
    expect(after.containers).toBe(before.containers);
  });

  it('leaves the keychain, .env and /etc/hosts as they were', () => {
    expect(after.keychain).toBe(before.keychain);
    expect(after.envFile).toBe(before.envFile);
    expect(after.hosts).toBe(before.hosts);
  });

  it('writes no file in the checkout', () => {
    expect(after.git).toBe(before.git);
  });
});
