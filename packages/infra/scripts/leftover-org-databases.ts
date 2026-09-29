// `pnpm graph:leftovers` (S1-014): lists the throwaway `org-<uuid>` Neo4j databases that belong to
// no live org (D82, D171). Check-only by default: it reads the database names from Neo4j as the
// Desktop `neo4j` account and the live org IDs from Postgres (migration account through the dev
// relay, READ ONLY), and prints the count and the names. Setting values are never printed (D57,
// D164). `--drop` drops exactly the listed leftovers, one at a time, and is for the user only
// (D176). It never returns or drops `neo4j`, `system`, `restore-test` (D214 (8)) or a live org's
// database. Run on the Mac with plain `node`.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';

const ORG_DATABASE = /^org-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The `org-<lowercase uuid>` names whose UUID is not a live org, sorted. Pure. */
export function leftoverOrgDatabases(databaseNames: string[], liveOrgIds: string[]): string[] {
  const live = new Set(liveOrgIds);
  const out = new Set<string>();
  for (const name of databaseNames) {
    const m = ORG_DATABASE.exec(name);
    if (m && !live.has(m[1]!)) out.add(name);
  }
  return [...out].sort();
}

const LOCAL_HOST = '127.0.0.1';
const NEO4J_URI = `bolt://${LOCAL_HOST}:7687`;
const TIMEOUT_MS = 5_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// Settings: the environment first; the nearest `.env` (from the working folder up) fills in.
async function settings(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const path = join(dir, '.env');
    if (existsSync(path)) {
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        const m = LINE.exec(line);
        if (!m) continue;
        let value = m[2]!.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        out[m[1]!] = value;
      }
      break;
    }
    if (dirname(dir) === dir) break;
  }
  for (const [k, v] of Object.entries(process.env)) if (v) out[k] = v;
  return out;
}

function required(all: Record<string, string>, name: string): string {
  const value = all[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface PgClient {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

// The api package's own `pg`, as the migration account through the dev relay, read-only.
async function liveOrgIds(all: Record<string, string>): Promise<string[]> {
  const { toHostAddress } = (await import(
    new URL('./host-address.ts', import.meta.url).href
  )) as typeof import('./host-address.js');
  const require = createRequire(join(ROOT, 'packages', 'api', 'package.json'));
  const { Client } = require('pg') as {
    Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => PgClient;
  };
  const client = new Client({
    connectionString: toHostAddress(required(all, 'DATABASE_URL_MIGRATE')),
    connectionTimeoutMillis: TIMEOUT_MS,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    // Under row-level security the account may see only some orgs, or none: that is not a list of
    // the live orgs, so it counts as "couldn't read" and nothing is treated as a leftover.
    const rls = await client.query("SELECT row_security_active('organization') AS on");
    if (rls.rows[0]?.['on'] !== false) throw Object.assign(new Error('rls'), { code: 'RowLevelSecurity' });
    const r = await client.query('SELECT id::text AS id FROM organization');
    await client.query('COMMIT');
    return r.rows.map((row) => String(row['id']));
  } finally {
    await client.end();
  }
}

function neo4jDriver(all: Record<string, string>): Driver {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic('neo4j', required(all, 'NEO4J_DESKTOP_PASSWORD')), {
    connectionTimeout: TIMEOUT_MS,
    telemetryDisabled: true,
  });
}

async function databaseNames(driver: Driver): Promise<string[]> {
  const session = driver.session({ database: 'system', defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run('SHOW DATABASES YIELD name RETURN DISTINCT name');
    return res.records.map((r) => String(r.get('name')));
  } finally {
    await session.close();
  }
}

// The error's type or code only, never its text (D164).
function kind(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  return String(e?.code ?? e?.name ?? 'error');
}

async function main(argv: string[]): Promise<number> {
  const drop = argv.includes('--drop');
  const all = await settings();

  let live: string[];
  try {
    live = await liveOrgIds(all);
  } catch (err) {
    console.error(`Could not read the live orgs from Postgres (${kind(err)})`);
    return 1;
  }

  const driver = neo4jDriver(all);
  try {
    let names: string[];
    try {
      names = await databaseNames(driver);
    } catch (err) {
      console.error(`Could not read the databases from Neo4j (${kind(err)})`);
      return 1;
    }
    const leftovers = leftoverOrgDatabases(names, live);
    console.log(`${leftovers.length} leftover org database(s)`);
    for (const name of leftovers) console.log(name);
    if (!drop) return 0;

    let failed = 0;
    for (const name of leftovers) {
      const session = driver.session({ database: 'system' });
      try {
        await session.run(`DROP DATABASE \`${name}\` IF EXISTS WAIT`);
        console.log(`dropped ${name}`);
      } catch (err) {
        failed += 1;
        console.error(`could not drop ${name} (${kind(err)})`);
      } finally {
        await session.close();
      }
    }
    return failed === 0 ? 0 : 1;
  } finally {
    await driver.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
