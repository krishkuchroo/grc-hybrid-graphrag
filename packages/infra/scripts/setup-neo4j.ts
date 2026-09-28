// `pnpm setup:neo4j` (M0-004; D57, D73, D144): creates the two service accounts in Neo4j Desktop.
// - Logs in once as the Desktop `neo4j` account (NEO4J_DESKTOP_PASSWORD, filled in by the user).
// - grc_admin (NEO4J_ADMIN_PASSWORD) may create databases and nothing else (D57).
// - grc_writer (NEO4J_WRITER_PASSWORD) reads and writes graph data, with write denied on the
//   default `neo4j` database, and holds no DBMS management rights, so it can never change
//   `system` (D144: Neo4j 2026.05 can't grant on a name pattern like `org-*`). D208: it also
//   holds INDEX and CONSTRAINT MANAGEMENT on DATABASE *, so `ensureOrgSchema` can build each org
//   database's schema.
// - The 28 read-only query accounts `grc_ro_<role>_<clearance>` (M0-005, D73), each with its own
//   role holding the privileges built from ROLE_TABLE in packages/api/src/graph/privileges.ts.
//   Their passwords derive from NEO4J_QUERY_SECRET (packages/api/src/graph/query-accounts.ts).
// - Safe to re-run: every step is "if not exists" or an idempotent grant, and an existing
//   account keeps its password.
// - Settings come from the environment; the nearest `.env` (from the working folder up) fills in missing ones
//   but never overrides what is set. Passwords are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
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

interface QueryAccountsModule {
  QUERY_ACCOUNTS: readonly { role: string; clearance: string; name: string }[];
  queryAccountPassword(secret: string, role: string, clearance: string): string;
}
interface PrivilegesModule {
  queryAccountPrivileges(role: string, clearance: string): string[];
}
const API_GRAPH = new URL('../../api/src/graph/', import.meta.url);
const { QUERY_ACCOUNTS, queryAccountPassword } = (await import(
  new URL('query-accounts.ts', API_GRAPH).href
)) as QueryAccountsModule;
const { queryAccountPrivileges } = (await import(new URL('privileges.ts', API_GRAPH).href)) as PrivilegesModule;

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// The nearest `.env`, walking up from the working folder (a worktree finds the main checkout's).
function findDotEnv(): string | undefined {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function loadDotEnv(): Record<string, string> {
  const path = findDotEnv();
  if (!path) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
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

const fromFile = loadDotEnv();
const setting = (name: string): string => process.env[name] || fromFile[name] || '';

const uri = setting('NEO4J_URI') || 'bolt://127.0.0.1:7687';
const desktopPassword = setting('NEO4J_DESKTOP_PASSWORD');
const adminPassword = setting('NEO4J_ADMIN_PASSWORD');
const writerPassword = setting('NEO4J_WRITER_PASSWORD');
const querySecret = setting('NEO4J_QUERY_SECRET');

const missing = [
  ['NEO4J_DESKTOP_PASSWORD', desktopPassword],
  ['NEO4J_ADMIN_PASSWORD', adminPassword],
  ['NEO4J_WRITER_PASSWORD', writerPassword],
  ['NEO4J_QUERY_SECRET', querySecret],
]
  .filter(([, v]) => !v)
  .map(([n]) => n);
if (missing.length > 0) {
  console.error(`setup:neo4j: missing ${missing.join(', ')} (see .env; run \`pnpm setup:secrets\`).`);
  process.exit(1);
}

// Each account gets its own role of the same name; only these statements shape its rights.
const ACCOUNTS: { user: string; password: string; grants: string[] }[] = [
  {
    user: 'grc_admin',
    password: adminPassword,
    grants: ['GRANT CREATE DATABASE ON DBMS TO grc_admin'],
  },
  {
    user: 'grc_writer',
    password: writerPassword,
    grants: [
      'GRANT ACCESS ON DATABASE * TO grc_writer',
      'GRANT ALL GRAPH PRIVILEGES ON GRAPH * TO grc_writer',
      'GRANT NAME MANAGEMENT ON DATABASE * TO grc_writer',
      'GRANT INDEX MANAGEMENT ON DATABASE * TO grc_writer',
      'GRANT CONSTRAINT MANAGEMENT ON DATABASE * TO grc_writer',
      'DENY WRITE ON GRAPH neo4j TO grc_writer',
    ],
  },
  ...QUERY_ACCOUNTS.map(({ role, clearance, name }) => ({
    user: name,
    password: queryAccountPassword(querySecret, role, clearance),
    grants: queryAccountPrivileges(role, clearance),
  })),
];

const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', desktopPassword));

async function run(cypher: string, params: Record<string, unknown> = {}): Promise<void> {
  const session = driver.session({ database: 'system' });
  try {
    await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

try {
  for (const { user, password, grants } of ACCOUNTS) {
    await run(`CREATE USER ${user} IF NOT EXISTS SET PASSWORD $password CHANGE NOT REQUIRED`, { password });
    await run(`CREATE ROLE ${user} IF NOT EXISTS`);
    await run(`GRANT ROLE ${user} TO ${user}`);
    for (const grant of grants) await run(grant);
  }
} catch (err) {
  const e = err as { code?: string; message?: string };
  console.error(`setup:neo4j: failed (${e.code ?? 'error'}): ${e.message ?? String(err)}`);
  await driver.close();
  process.exit(1);
}
await driver.close();

// An account made earlier keeps its password; check it still matches .env.
for (const { user, password } of ACCOUNTS) {
  const check = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    await check.verifyAuthentication();
  } catch {
    console.error(`setup:neo4j: ${user} exists but its password does not match .env.`);
    process.exitCode = 1;
  } finally {
    await check.close();
  }
}

if (!process.exitCode) console.log('setup:neo4j: grc_admin, grc_writer and the 28 grc_ro_* query accounts are ready.');
