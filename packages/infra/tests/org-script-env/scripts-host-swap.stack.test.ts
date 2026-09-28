// TEST-002 criteria 4 and 5: `pnpm org:create` and `pnpm seed:demo` swap the container host in
// every DATABASE_URL_* for the dev relay at 127.0.0.1:5433 themselves (D170, fixes build-errors
// 25), and their errors still show only a type or code (D164).
//
// How, without changing anything (D176): each script is run with DATABASE_URL_APP and
// DATABASE_URL_MIGRATE set in its environment (the environment wins over `.env`) to the
// container address `grc-postgres:5432`, with the real account names but a random wrong
// password. Every other setting comes from `.env` as usual.
// - With the swap, the script reaches Postgres on 127.0.0.1:5433 and the login is refused
//   (SQLSTATE 28P01) before anything is written: its first step is a Postgres query.
// - Without the swap, `grc-postgres` doesn't resolve on the Mac (ENOTFOUND / EAI_AGAIN).
// A refused login writes nothing. The test then checks, read-only as the Postgres superuser,
// that no org with the test's slug exists.
//
// Needs the running stack: grc-postgres with the dev relay on 127.0.0.1:5433 (D61).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LONG = 120_000;

function dotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
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
    if (dirname(dir) === dir) return out;
  }
}

function setting(name: string): string {
  const v = process.env[name] || dotEnv()[name];
  if (!v) throw new Error(`Test set-up: ${name} is not set in the environment or in .env`);
  return v;
}

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
// The api package's own `pg`, read-only, as the superuser on the dev relay.
async function orgsWithSlug(slug: string): Promise<number> {
  const require = createRequire(join(ROOT, 'packages', 'api', 'package.json'));
  const { Client } = require('pg') as { Client: new (o: { connectionString: string }) => PgClient };
  const database = new URL(setting('DATABASE_URL_APP')).pathname.slice(1) || 'grc';
  const password = encodeURIComponent(setting('POSTGRES_PASSWORD'));
  const client = new Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:5433/${database}` });
  await client.connect();
  try {
    const r = await client.query('SELECT count(*)::int AS n FROM organization WHERE slug = $1', [slug]);
    return Number(r.rows[0]!['n']);
  } finally {
    await client.end();
  }
}

interface Run {
  status: number | null;
  out: string;
}

function runScript(script: string, args: string[], urls: { app: string; migrate: string }): Run {
  const r = spawnSync('pnpm', ['--silent', script, ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_APP: urls.app, DATABASE_URL_MIGRATE: urls.migrate },
    encoding: 'utf8',
    timeout: LONG - 10_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function wrongPasswordUrls(host: string): { app: string; migrate: string; password: string } {
  const password = `wrong-${randomBytes(18).toString('base64url')}`;
  const database = new URL(setting('DATABASE_URL_APP')).pathname.slice(1) || 'grc';
  return {
    password,
    app: `postgres://grc_app:${password}@${host}/${database}`,
    migrate: `postgres://grc_migrator:${password}@${host}/${database}`,
  };
}

function orgArgs(slug: string): string[] {
  return [
    '--name',
    'Host swap check',
    '--slug',
    slug,
    '--admin-email',
    `admin@${slug}.example`,
    '--admin-name',
    'Check',
  ];
}

function expectReachedTheRelay(run: Run, password: string): void {
  expect(run.status, run.out).not.toBe(0);
  // Reached Postgres on 127.0.0.1:5433, which refused the wrong password.
  expect(run.out, run.out).toContain('28P01');
  // Never tried the container name from the Mac.
  expect(run.out).not.toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo/);
  // D164: the type or code only, never the URL or password.
  expect(run.out).not.toContain(password);
  expect(run.out).not.toContain('postgres://');
  expect(run.out).not.toContain('grc-postgres');
}

describe('org:create swaps the container host itself (criterion 4)', () => {
  it(
    'a grc-postgres:5432 address reaches 127.0.0.1:5433, and nothing is created',
    async () => {
      const slug = `test-hostswap-${randomBytes(4).toString('hex')}`;
      const urls = wrongPasswordUrls('grc-postgres:5432');
      const run = runScript('org:create', orgArgs(slug), urls);
      expectReachedTheRelay(run, urls.password);
      expect(await orgsWithSlug(slug)).toBe(0);
    },
    LONG,
  );

  it(
    'an address already on 127.0.0.1:5433 is used as it is',
    async () => {
      const slug = `test-hostswap-${randomBytes(4).toString('hex')}`;
      const urls = wrongPasswordUrls('127.0.0.1:5433');
      const run = runScript('org:create', orgArgs(slug), urls);
      expectReachedTheRelay(run, urls.password);
      expect(await orgsWithSlug(slug)).toBe(0);
    },
    LONG,
  );
});

describe('seed:demo swaps the container host itself (criterion 4)', () => {
  it(
    'a grc-postgres:5432 address reaches 127.0.0.1:5433 and the error shows only a code',
    () => {
      const urls = wrongPasswordUrls('grc-postgres:5432');
      const run = runScript('seed:demo', [], urls);
      expectReachedTheRelay(run, urls.password);
      expect(run.out).not.toContain(setting('DEMO_USER_PASSWORD'));
    },
    LONG,
  );
});
