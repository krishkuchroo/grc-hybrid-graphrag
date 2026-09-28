// The test-env doctor's decision logic (TEST-002, D180): probe results in, one line per item and
// an exit code out. Pure: importing it touches no database, container, file, keychain or network.
// The command `pnpm test:env` (test-env.ts) wires the real, read-only probes.
// - A probe that throws is `missing`, with the error's type or code only (D164), never its
//   message, URL or value. `.env` values are never printed, only key names (D57).
// - Every address asked is on 127.0.0.1 (D61).

export type ItemId = 'stack' | 'migrations' | 'neo4j' | 'env' | 'caddy-root' | 'hosts';

export const ITEMS: readonly { id: ItemId; what: string }[] = [
  { id: 'stack', what: 'Postgres (127.0.0.1:5433) and SeaweedFS (127.0.0.1:8333) answer through the dev relay' },
  { id: 'migrations', what: 'every _journal.json migration is in drizzle.__drizzle_migrations' },
  { id: 'neo4j', what: 'Neo4j answers and each of the 28 grc_ro_* roles has every DENY setup:neo4j gives it' },
  { id: 'env', what: 'the required .env keys are set' },
  { id: 'caddy-root', what: "Caddy's local root is trusted in the keychain" },
  { id: 'hosts', what: '/etc/hosts has 127.0.0.1 grc.localhost' },
];

/** Every key in `.env.example` (D57). */
export const REQUIRED_ENV_KEYS: readonly string[] = [
  'POSTGRES_PASSWORD',
  'DATABASE_URL_APP',
  'DATABASE_URL_MIGRATE',
  'NEO4J_ADMIN_PASSWORD',
  'NEO4J_WRITER_PASSWORD',
  'NEO4J_QUERY_SECRET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'NEO4J_DESKTOP_PASSWORD',
  'BETTER_AUTH_SECRET',
  'DEMO_USER_PASSWORD',
];

export const LOCAL_HOST = '127.0.0.1';
export const PORTS: readonly { name: string; port: number }[] = [
  { name: 'Postgres', port: 5433 },
  { name: 'SeaweedFS', port: 8333 },
];

export interface DoctorProbes {
  portOpen(host: string, port: number): Promise<boolean>;
  /** The entries of packages/api/src/db/migrations/meta/_journal.json. */
  journal(): Promise<{ tag: string; when: number }[]>;
  /** created_at of each drizzle.__drizzle_migrations row. */
  appliedMigrations(): Promise<number[]>;
  /** Each grc_ro_* role found → its `SHOW ROLE … PRIVILEGES AS COMMANDS` lines. */
  queryRolePrivileges(): Promise<Record<string, string[]>>;
  /** Settings (environment, then .env), name → value. */
  env(): Promise<Record<string, string>>;
  caddyRootTrusted(): Promise<boolean>;
  /** The text of /etc/hosts. */
  hostsFile(): Promise<string>;
}

export interface ItemResult {
  id: ItemId;
  ok: boolean;
  reason: string;
}

export interface DoctorResult {
  items: ItemResult[];
  lines: string[];
  exitCode: number;
}

/** An error's type and code only (D164). A thrown non-object prints none of its value. */
export function describeError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'type=unknown';
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  let type = 'unknown';
  if (typeof e.name === 'string' && e.name !== 'Error') type = e.name;
  else if (typeof ctorName === 'string' && ctorName !== '') type = ctorName;
  else if (typeof e.name === 'string') type = e.name;
  const causeCode = typeof e.cause === 'object' && e.cause !== null ? (e.cause as { code?: unknown }).code : undefined;
  const code = typeof e.code === 'string' ? e.code : typeof causeCode === 'string' ? causeCode : undefined;
  return code === undefined ? `type=${type}` : `type=${type} code=${code}`;
}

// Calls a probe, turning a synchronous throw into a rejection.
async function call<T>(probe: () => Promise<T>): Promise<T> {
  return await probe();
}

type Check = Omit<ItemResult, 'id'>;
const ok = (reason: string): Check => ({ ok: true, reason });
const missing = (reason: string): Check => ({ ok: false, reason });

async function checkStack(p: DoctorProbes): Promise<Check> {
  const down: string[] = [];
  for (const { name, port } of PORTS) {
    if (!(await call(() => p.portOpen(LOCAL_HOST, port)))) down.push(`${name} ${LOCAL_HOST}:${port}`);
  }
  if (down.length > 0) return missing(`not answering: ${down.join(', ')}`);
  return ok(PORTS.map(({ name, port }) => `${name} ${LOCAL_HOST}:${port}`).join(', ') + ' answer');
}

async function checkMigrations(p: DoctorProbes): Promise<Check> {
  const journal = await call(() => p.journal());
  const applied = new Set((await call(() => p.appliedMigrations())).map(Number));
  const notApplied = journal.filter((e) => !applied.has(Number(e.when))).map((e) => e.tag);
  if (notApplied.length > 0) return missing(`not applied: ${notApplied.join(', ')}`);
  return ok(`all ${journal.length} applied`);
}

// Neo4j prints commands in its own form: a backticked role, and `NODE` / `RELATIONSHIP` where
// the statements setup:neo4j runs say `NODES` / `RELATIONSHIPS`.
export function normaliseCommand(command: string): string {
  return command
    .replace(/`/g, '')
    .replace(/\bNODES\b/g, 'NODE')
    .replace(/\bRELATIONSHIPS\b/g, 'RELATIONSHIP')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExpectedRole {
  name: string;
  denies: string[];
}

// The DENYs setup:neo4j gives each of the 28 query roles, from the api's own code (D73). Loaded
// on use; the modules are pure.
async function expectedRoles(): Promise<ExpectedRole[]> {
  const graph = new URL('../../api/src/graph/', import.meta.url);
  const { QUERY_ACCOUNTS } = (await import(new URL('query-accounts.ts', graph).href)) as {
    QUERY_ACCOUNTS: readonly { role: string; clearance: string; name: string }[];
  };
  const { queryAccountPrivileges } = (await import(new URL('privileges.ts', graph).href)) as {
    queryAccountPrivileges(role: string, clearance: string): string[];
  };
  return QUERY_ACCOUNTS.map((a) => ({
    name: a.name,
    denies: queryAccountPrivileges(a.role, a.clearance)
      .filter((s) => s.startsWith('DENY '))
      .map(normaliseCommand),
  }));
}

async function checkNeo4j(p: DoctorProbes): Promise<Check> {
  const found = await call(() => p.queryRolePrivileges());
  const expected = await expectedRoles();
  const problems: string[] = [];
  const absent = expected.filter((r) => !(r.name in found)).map((r) => r.name);
  if (absent.length === expected.length) problems.push(`none of the ${expected.length} grc_ro_* roles exist`);
  else if (absent.length > 0) problems.push(`roles absent: ${absent.join(', ')}`);
  for (const role of expected) {
    const commands = found[role.name];
    if (commands === undefined) continue;
    const have = new Set(commands.map(normaliseCommand));
    const lacking = role.denies.filter((d) => !have.has(d));
    if (lacking.length > 0) {
      const suffix = ` TO ${role.name}`;
      const what = lacking.map((d) => (d.endsWith(suffix) ? d.slice(0, -suffix.length) : d));
      problems.push(`${role.name} lacks ${what.join('; ')}`);
    }
  }
  if (problems.length > 0) return missing(problems.join(' | '));
  return ok(`${expected.length} grc_ro_* roles have every DENY`);
}

async function checkEnv(p: DoctorProbes): Promise<Check> {
  const env = await call(() => p.env());
  const absent = REQUIRED_ENV_KEYS.filter((k) => {
    const v = env[k];
    return typeof v !== 'string' || v.trim() === '';
  });
  if (absent.length > 0) return missing(`not set: ${absent.join(', ')}`);
  return ok(`${REQUIRED_ENV_KEYS.length} keys set`);
}

async function checkCaddyRoot(p: DoctorProbes): Promise<Check> {
  if (await call(() => p.caddyRootTrusted())) return ok('trusted in the keychain');
  return missing('no trusted Caddy Local Authority root in the keychain');
}

/** True if a line of the hosts file maps 127.0.0.1 to grc.localhost. */
export function hasHostsLine(text: string): boolean {
  return text.split('\n').some((raw) => {
    const [address, ...names] = raw.replace(/#.*$/, '').trim().split(/\s+/);
    return address === LOCAL_HOST && names.includes('grc.localhost');
  });
}

async function checkHosts(p: DoctorProbes): Promise<Check> {
  if (hasHostsLine(await call(() => p.hostsFile()))) return ok('127.0.0.1 grc.localhost');
  return missing('no `127.0.0.1 grc.localhost` line');
}

const CHECKS: Record<ItemId, (p: DoctorProbes) => Promise<Check>> = {
  stack: checkStack,
  migrations: checkMigrations,
  neo4j: checkNeo4j,
  env: checkEnv,
  'caddy-root': checkCaddyRoot,
  hosts: checkHosts,
};

/** Runs every item's check; one failing or throwing never stops the others. */
export async function runChecks(probes: DoctorProbes): Promise<DoctorResult> {
  const items = await Promise.all(
    ITEMS.map(async ({ id }): Promise<ItemResult> => {
      try {
        return { id, ...(await CHECKS[id](probes)) };
      } catch (err) {
        return { id, ok: false, reason: `could not check (${describeError(err)})` };
      }
    }),
  );
  const lines = items.map((i) => `${i.ok ? 'OK' : 'missing'} ${i.id}: ${i.reason}`);
  return { items, lines, exitCode: items.every((i) => i.ok) ? 0 : 1 };
}
