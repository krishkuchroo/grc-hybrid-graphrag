// `pnpm test:env` (TEST-002, D180): says what the live tests are missing, one `OK` or `missing`
// line per item (see ITEMS in test-env-checks.ts), and exits 0 only if every item is OK.
// Check-only: it reads and connects, nothing else. It never grants, revokes, starts, stops,
// migrates or writes anything (D176). Postgres is read in a READ ONLY transaction, Neo4j in a
// read session with SHOW commands only. `.env` values are never printed, only key names (D57),
// and errors show their type or code only (D164). Every address is on 127.0.0.1 (D61).
// Run on the Mac with plain `node`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

// The api sources import each other as `./x.js`; under plain `node` those files are `./x.ts`.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});

// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
const { runChecks, LOCAL_HOST } = (await import(
  new URL('./test-env-checks.ts', import.meta.url).href
)) as typeof import('./test-env-checks.js');
const { toHostAddress } = (await import(
  new URL('./host-address.ts', import.meta.url).href
)) as typeof import('./host-address.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const JOURNAL = join(ROOT, 'packages', 'api', 'src', 'db', 'migrations', 'meta', '_journal.json');
const NEO4J_URI = `bolt://${LOCAL_HOST}:7687`;
const TIMEOUT_MS = 5_000;

// Settings: the environment first; the nearest `.env` (from the working folder up) fills in.
const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

async function readDotEnv(): Promise<Record<string, string>> {
  let path: string | undefined;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.env'))) {
      path = join(dir, '.env');
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!path) return {};
  const out: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

let settings: Promise<Record<string, string>> | undefined;
function env(): Promise<Record<string, string>> {
  settings ??= readDotEnv().then((file) => {
    const merged: Record<string, string> = { ...file };
    for (const [k, v] of Object.entries(process.env)) if (v) merged[k] = v;
    return merged;
  });
  return settings;
}

async function setting(name: string): Promise<string> {
  const value = (await env())[name];
  if (!value) throw Object.assign(new Error('setting not set'), { name: 'MissingSetting', code: name });
  return value;
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function journal(): Promise<{ tag: string; when: number }[]> {
  const parsed = JSON.parse(await readFile(JOURNAL, 'utf8')) as { entries: { tag: string; when: number }[] };
  return parsed.entries.map((e) => ({ tag: e.tag, when: e.when }));
}

interface PgClient {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

// The api package's own `pg`, as the migration account through the dev relay, read-only.
async function appliedMigrations(): Promise<number[]> {
  const require = createRequire(join(ROOT, 'packages', 'api', 'package.json'));
  const { Client } = require('pg') as {
    Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => PgClient;
  };
  const client = new Client({
    connectionString: toHostAddress(await setting('DATABASE_URL_MIGRATE')),
    connectionTimeoutMillis: TIMEOUT_MS,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const r = await client.query('SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations');
    await client.query('COMMIT');
    return r.rows.map((row) => Number(row['created_at']));
  } finally {
    await client.end();
  }
}

const QUERY_ROLE = /^grc_ro_[a-z_]+$/;

// SHOW commands only, in a read session on `system`, as the Desktop `neo4j` account (the only
// one allowed to list privileges).
async function queryRolePrivileges(): Promise<Record<string, string[]>> {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic('neo4j', await setting('NEO4J_DESKTOP_PASSWORD')), {
    connectionTimeout: TIMEOUT_MS,
    telemetryDisabled: true,
  });
  const session = driver.session({ database: 'system', defaultAccessMode: neo4j.session.READ });
  try {
    const roles = (await session.run("SHOW ROLES YIELD role WHERE role STARTS WITH 'grc_ro_' RETURN role")).records.map(
      (r) => String(r.get('role')),
    );
    const out: Record<string, string[]> = {};
    for (const role of roles.filter((r) => QUERY_ROLE.test(r))) {
      const rows = await session.run(`SHOW ROLE \`${role}\` PRIVILEGES AS COMMANDS`);
      out[role] = rows.records.map((r) => String(r.get('command')));
    }
    return out;
  } finally {
    await session.close();
    await driver.close();
  }
}

// Reads the admin and user trust settings (`security dump-trust-settings`); nothing is changed.
async function caddyRootTrusted(): Promise<boolean> {
  let readable = false;
  for (const args of [['dump-trust-settings', '-d'], ['dump-trust-settings']]) {
    const r = spawnSync('security', args, { encoding: 'utf8', timeout: TIMEOUT_MS });
    if (r.error) throw r.error;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== 0) {
      if (/No Trust Settings were found/i.test(out)) readable = true;
      continue;
    }
    readable = true;
    const blocks = out.split(/^(?=Cert \d+:)/m);
    if (blocks.some((b) => /^Cert \d+: Caddy Local Authority\b/.test(b) && !/Deny/i.test(b))) return true;
  }
  if (!readable) throw Object.assign(new Error('keychain unreadable'), { name: 'KeychainError', code: 'security' });
  return false;
}

const result = await runChecks({
  portOpen,
  journal,
  appliedMigrations,
  queryRolePrivileges,
  env,
  caddyRootTrusted,
  hostsFile: () => readFile('/etc/hosts', 'utf8'),
});
for (const line of result.lines) console.log(line);
process.exitCode = result.exitCode;
