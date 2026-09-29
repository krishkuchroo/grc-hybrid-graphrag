// Shared set-up for the M0-004 graph tests (test writer's file, D89/D96).
//
// Where the settings come from:
// - process.env first, then the nearest `.env` found by walking up from this folder
//   (a builder's worktree sits inside the main checkout, so it finds the main `.env`).
//   Values already in process.env are never overridden.
// - NEO4J_URI defaults to bolt://127.0.0.1:7687 (Neo4j Desktop, D14).
// - NEO4J_DESKTOP_PASSWORD is the user's own `neo4j` account (Q7). The tests use it only
//   to check and clean up, the same way `pnpm setup:neo4j` uses it only to set up.
// - NEO4J_ADMIN_PASSWORD and NEO4J_WRITER_PASSWORD come from `pnpm setup:secrets`.
//
// Throwaway data (D82): every org database a test makes is `org-<random uuid>`, tracked by
// the one ThrowawayDatabases tracker (./throwaway-databases.ts, S1-014) before it is made, and
// dropped in afterAll with `dropAll()`, which fails loudly. Nothing else is touched.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..', '..');

function findDotEnv(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface GraphTestEnv {
  uri: string;
  desktopPassword: string;
  adminPassword: string;
  writerPassword: string;
}

let cached: GraphTestEnv | undefined;

export function graphTestEnv(): GraphTestEnv {
  if (cached) return cached;
  const file = findDotEnv(HERE);
  const fromFile = file ? parseDotEnv(readFileSync(file, 'utf8')) : {};
  const get = (name: string): string => process.env[name] || fromFile[name] || '';
  const env: GraphTestEnv = {
    uri: get('NEO4J_URI') || 'bolt://127.0.0.1:7687',
    desktopPassword: get('NEO4J_DESKTOP_PASSWORD'),
    adminPassword: get('NEO4J_ADMIN_PASSWORD'),
    writerPassword: get('NEO4J_WRITER_PASSWORD'),
  };
  const missing = [
    ['NEO4J_DESKTOP_PASSWORD', env.desktopPassword, 'the user fills it in (Q7)'],
    ['NEO4J_ADMIN_PASSWORD', env.adminPassword, 'run `pnpm setup:secrets`'],
    ['NEO4J_WRITER_PASSWORD', env.writerPassword, 'run `pnpm setup:secrets`'],
  ].filter(([, v]) => !v);
  if (missing.length) {
    throw new Error(`Graph tests need these in .env: ${missing.map(([n, , how]) => `${n} (${how})`).join(', ')}`);
  }
  cached = env;
  return env;
}

/** Env for child processes such as `pnpm setup:neo4j`. */
export function childEnv(): NodeJS.ProcessEnv {
  const e = graphTestEnv();
  return {
    ...process.env,
    NEO4J_URI: e.uri,
    NEO4J_DESKTOP_PASSWORD: e.desktopPassword,
    NEO4J_ADMIN_PASSWORD: e.adminPassword,
    NEO4J_WRITER_PASSWORD: e.writerPassword,
  };
}

export function driverAs(user: string, password: string): Driver {
  return neo4j.driver(graphTestEnv().uri, neo4j.auth.basic(user, password), {
    disableLosslessIntegers: true,
  });
}

/** The Neo4j Desktop `neo4j` account: used by the tests only to check and clean up. */
export function superDriver(): Driver {
  return driverAs('neo4j', graphTestEnv().desktopPassword);
}

export async function runOn(
  driver: Driver,
  database: string,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const session = driver.session({ database });
  try {
    const res = await session.run(cypher, params);
    return res.records.map((r) => r.toObject() as Record<string, unknown>);
  } finally {
    await session.close();
  }
}

export function newOrgId(): string {
  return randomUUID();
}

export async function databaseStatuses(driver: Driver, name: string): Promise<string[]> {
  const rows = await runOn(driver, 'system', 'SHOW DATABASES YIELD name, currentStatus WHERE name = $name', { name });
  return rows.map((r) => String(r['currentStatus']));
}

export async function databaseExists(driver: Driver, name: string): Promise<boolean> {
  return (await databaseStatuses(driver, name)).length > 0;
}

/** Runs the root `pnpm setup:neo4j` from the repo root. */
export async function runSetupNeo4j(): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('pnpm', ['setup:neo4j'], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Expects Neo4j to refuse `p`: it must reject with a Neo4j client error. A failed login
 * or a lost connection doesn't count, so a wrong password can't pass as a refusal.
 */
export async function refused(p: Promise<unknown>): Promise<Error & { code?: string }> {
  let error: (Error & { code?: string }) | undefined;
  try {
    await p;
  } catch (err) {
    error = err as Error & { code?: string };
  }
  if (!error) throw new Error('expected Neo4j to refuse the command, but it succeeded');
  const code = String(error.code ?? '');
  if (!code.startsWith('Neo.ClientError.') || /Unauthorized|AuthenticationRateLimit|CredentialsExpired/.test(code)) {
    throw new Error(`expected a Neo4j refusal, got ${code || error.name}: ${error.message}`);
  }
  return error;
}
