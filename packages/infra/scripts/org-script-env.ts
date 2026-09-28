// Shared set-up for the platform operator's org scripts, `pnpm org:create` and `pnpm seed:demo`
// (M0-014, D133). Run on the Mac with plain `node`.
// - Lets the api sources load: they import each other as `./x.js`, which are `./x.ts` files.
// - Reads settings from the environment first; the nearest `.env` (from the working folder up)
//   fills in missing ones but never overrides what is set. Secrets are never printed.
// - Opens the connections provisionOrg needs: grc_app, grc_migrator, Neo4j and SeaweedFS.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';

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

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

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

/** A setting from the environment, else `.env`, else ''. */
export function setting(name: string): string {
  return process.env[name] || fromFile[name] || '';
}

const DEFAULTS: Record<string, string> = {
  NEO4J_URI: 'bolt://127.0.0.1:7687',
  S3_ENDPOINT: 'http://127.0.0.1:8333', // the dev switch's SeaweedFS port on the Mac (D132, D137)
};

const NEEDED = [
  'DATABASE_URL_APP',
  'DATABASE_URL_MIGRATE',
  'NEO4J_URI',
  'NEO4J_ADMIN_PASSWORD',
  'NEO4J_WRITER_PASSWORD',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

/** The names of the settings provisioning needs that are missing. */
export function missingSettings(): string[] {
  return NEEDED.filter((n) => !(setting(n) || DEFAULTS[n]));
}

const get = (name: (typeof NEEDED)[number]): string => setting(name) || DEFAULTS[name] || '';

export interface ProvisionInput {
  name: string;
  slug: string;
  admin: { email: string; name: string };
}

/** The slice of drizzle's database the scripts use: a transaction, and closing the pool. */
export interface ScriptDb {
  transaction<T>(fn: (tx: ScriptTx) => Promise<T>): Promise<T>;
  $client: { end(): Promise<void> };
}
export interface ScriptTx {
  execute(query: unknown): Promise<{ rows: Record<string, unknown>[] }>;
}

interface ProvisionModule {
  provisionOrg(input: ProvisionInput, deps: unknown): Promise<{ orgId: string }>;
  checkProvisionInput(input: ProvisionInput): string[];
  SLUG: RegExp;
  EMAIL: RegExp;
}
interface DrizzleModule {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}

const API_SRC = new URL('../../api/src/', import.meta.url);
const load = async <T>(path: string): Promise<T> => (await import(new URL(path, API_SRC).href)) as T;

export const provisioning = await load<ProvisionModule>('identity/provision-org.ts');

/** The drizzle `sql` tag, from the api package's own copy of drizzle-orm. */
export async function sqlTag(): Promise<DrizzleModule['sql']> {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('identity/provision-org.ts', API_SRC));
  const mod = (await import(require.resolve('drizzle-orm'))) as DrizzleModule;
  return mod.sql;
}

export interface Connections {
  deps: { db: ScriptDb; migrator: ScriptDb; graph: unknown; files: unknown };
  close(): Promise<void>;
}

/** Opens grc_app, grc_migrator, Neo4j (admin and writer) and SeaweedFS. */
export async function connect(): Promise<Connections> {
  const { createDb } = await load<{ createDb(url: string, opts?: { max?: number }): ScriptDb }>('db/client.ts');
  const { GraphService } = await load<{
    GraphService: new (o: { uri: string; adminPassword: string; writerPassword: string }) => {
      close(): Promise<void>;
    };
  }>('graph/graph.service.ts');
  const { SeaweedFileStore } = await load<{
    SeaweedFileStore: new (c: { endpoint: string; accessKey: string; secretKey: string }) => object;
  }>('storage/seaweed-file-store.ts');
  const db = createDb(get('DATABASE_URL_APP'), { max: 2 });
  const migrator = createDb(get('DATABASE_URL_MIGRATE'), { max: 1 });
  const graph = new GraphService({
    uri: get('NEO4J_URI'),
    adminPassword: get('NEO4J_ADMIN_PASSWORD'),
    writerPassword: get('NEO4J_WRITER_PASSWORD'),
  });
  const files = new SeaweedFileStore({
    endpoint: get('S3_ENDPOINT'),
    accessKey: get('S3_ACCESS_KEY'),
    secretKey: get('S3_SECRET_KEY'),
  });
  return {
    deps: { db, migrator, graph, files },
    async close() {
      await Promise.allSettled([db.$client.end(), migrator.$client.end(), graph.close()]);
    },
  };
}

/**
 * One line for an error: its type and code only (D163, D164). Never its message, stack, cause or
 * other properties, which can hold the org's values (a DrizzleQueryError's params, a pg error's
 * detail). A thrown non-object prints none of its value.
 */
export function describeError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'type=unknown (a non-error value was thrown)';
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  // The class name: `name`, or the constructor's when `name` is left as 'Error' (DrizzleQueryError).
  const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  let type = 'unknown';
  if (typeof e.name === 'string' && e.name !== 'Error') type = e.name;
  else if (typeof ctorName === 'string' && ctorName !== '') type = ctorName;
  else if (typeof e.name === 'string') type = e.name;
  const causeCode = typeof e.cause === 'object' && e.cause !== null ? (e.cause as { code?: unknown }).code : undefined;
  const code = typeof e.code === 'string' ? e.code : typeof causeCode === 'string' ? causeCode : undefined;
  return code === undefined ? `type=${type}` : `type=${type} code=${code}`;
}
