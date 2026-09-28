// Shared set-up for the M0-012 audit-trail tests (D37, D45.4, D56, D72, D73).
//
// Contract these tests hold the code to (TASKS.md, brief M0-012):
// - `src/audit/chain.ts` exports `hashEntry(prevHash: string, entry: object): string`:
//   SHA-256 (lowercase hex) over the previous hash followed by the canonical JSON of the entry
//   (keys sorted at every level, arrays kept in order, no whitespace).
// - `src/audit/audit.schema.ts` exports `auditEvents`, the Drizzle table for the audit events,
//   partitioned by org (one partition per org). The JS keys the tests use: `orgId` (column
//   `org_id uuid not null`), `seq`, `prevHash`, `hash`, `actorType`, `actorId`, `action`,
//   `targetType`, `targetId`, `before`, `after`, `meta`, `sourceId`.
// - `src/audit/audit.service.ts` exports
//   - `class AuditService`, built with `new AuditService(db)` where `db` is the Drizzle database
//     of the restricted grc_app account (`createDb` from src/db/client.ts). It sets the org
//     context for each call itself. Methods:
//       `append(e: AuditEventInput): Promise<{ seq: number; hash: string }>`
//       `verifyChain(orgId): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }>`
//   - `createAuditPartition(db, orgId): Promise<void>`, safe to call again. The tests pass the
//     migration account's database (org provisioning, M0-014, runs as the platform operator).
// - `src/audit/verify-chain.job.ts` exports
//   - `VERIFY_CHAINS_QUEUE = 'audit.verify-chains'`
//   - `runVerifyChains({ audit, log, orgIds }): Promise<void>`: checks each org's chain; for a
//     broken one it appends an `audit.chain_broken` event (actorType `system`) to that org's
//     chain, with `brokenAtSeq` in its `meta` or `after`, and writes an error log line (pino)
//     naming the org and the seq.
//   The worker program schedules the queue once a day, and its handler checks every org.
//
// Seed orgs are written by the `postgres` superuser (the M0-009 helpers). Tampering is done as
// the migration account (grc_migrator, the owner), with the trigger off (brief, criterion 4).
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import { appUrl, closeDb, migrateUrl, rows, type Db } from '../db/helpers.js';
import { seedOrg, setUpWall, tearDownWall, type SeededOrg, type Wall } from '../org-wall/helpers.js';

export { rows, type Db } from '../db/helpers.js';
export {
  adminCtx,
  asApp,
  errorText,
  Rollback,
  rolledBack,
  seedOrg,
  type Ctx,
  type SeededOrg,
  type Wall,
} from '../org-wall/helpers.js';

export interface AuditEventInput {
  orgId: string;
  actorType: 'user' | 'api_key' | 'system';
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  sourceId?: string;
}

export type VerifyResult = { ok: true } | { ok: false; brokenAtSeq: number };

export interface AuditServiceLike {
  append(e: AuditEventInput): Promise<{ seq: number; hash: string }>;
  verifyChain(orgId: string): Promise<VerifyResult>;
}

export interface AuditModules {
  auditEvents: PgTable;
  AuditService: new (db: Db) => AuditServiceLike;
  createAuditPartition: (db: Db, orgId: string) => Promise<void>;
  hashEntry: (prevHash: string, entry: object) => string;
  VERIFY_CHAINS_QUEUE: string;
  runVerifyChains: (deps: { audit: AuditServiceLike; log: Logger; orgIds: readonly string[] }) => Promise<void>;
}

function need<T>(mod: Record<string, unknown>, file: string, name: string): T {
  if (mod[name] === undefined) throw new Error(`${file} must export \`${name}\``);
  return mod[name] as T;
}

// Loads the code under test inside the set-up, so a missing module shows up as a failing test
// that names the missing file.
export async function loadAudit(): Promise<AuditModules> {
  const schema = (await import('../../src/audit/audit.schema.js')) as unknown as Record<string, unknown>;
  const service = (await import('../../src/audit/audit.service.js')) as unknown as Record<string, unknown>;
  const chain = (await import('../../src/audit/chain.js')) as unknown as Record<string, unknown>;
  const job = (await import('../../src/audit/verify-chain.job.js')) as unknown as Record<string, unknown>;
  return {
    auditEvents: need(schema, 'src/audit/audit.schema.ts', 'auditEvents'),
    AuditService: need(service, 'src/audit/audit.service.ts', 'AuditService'),
    createAuditPartition: need(service, 'src/audit/audit.service.ts', 'createAuditPartition'),
    hashEntry: need(chain, 'src/audit/chain.ts', 'hashEntry'),
    VERIFY_CHAINS_QUEUE: need(job, 'src/audit/verify-chain.job.ts', 'VERIFY_CHAINS_QUEUE'),
    runVerifyChains: need(job, 'src/audit/verify-chain.job.ts', 'runVerifyChains'),
  };
}

export interface AuditEnv {
  wall: Wall;
  mods: AuditModules;
  migrator: Db; // grc_migrator on the throwaway database: partitions and tampering
  appDb: Db; // grc_app with room for concurrent appends: the service's database
  audit: AuditServiceLike;
  table: { schema: string; name: string; qualified: string };
}

export async function setUpAudit(): Promise<AuditEnv> {
  const wall = await setUpWall();
  let mods: AuditModules;
  try {
    mods = await loadAudit();
  } catch (err) {
    await tearDownWall(wall);
    throw err;
  }
  const migrator = wall.loaded.createDb(migrateUrl(wall.dbName), { max: 2 });
  const appDb = wall.loaded.createDb(appUrl(wall.dbName), { max: 10 });
  const audit = new mods.AuditService(appDb);
  const cfg = getTableConfig(mods.auditEvents);
  const schema = cfg.schema ?? 'public';
  return {
    wall,
    mods,
    migrator,
    appDb,
    audit,
    table: { schema, name: cfg.name, qualified: `"${schema}"."${cfg.name}"` },
  };
}

export async function tearDownAudit(env: AuditEnv | undefined): Promise<void> {
  if (!env) return;
  await closeDb(env.appDb);
  await closeDb(env.migrator);
  await tearDownWall(env.wall);
}

// Seeds an org (organization row and members) and creates its audit partition.
export async function newOrg(env: AuditEnv, name: string): Promise<SeededOrg> {
  const org = await seedOrg(env.wall, name);
  await env.mods.createAuditPartition(env.migrator, org.id);
  return org;
}

export function event(orgId: string, n: number, extra: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    orgId,
    actorType: 'user',
    actorId: `user-${n}`,
    action: 'risk.updated',
    targetType: 'Risk',
    targetId: `RSK${String(1000 + n).padStart(7, '0')}`,
    before: { status: 'active', score: n },
    after: { status: 'active', score: n + 1 },
    meta: { n },
    ...extra,
  };
}

export async function appendMany(env: AuditEnv, orgId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) await env.audit.append(event(orgId, i));
}

export interface StoredEvent {
  orgId: string;
  seq: number;
  prevHash: string | null;
  hash: string;
  actorType: string;
  actorId: string;
  action: string;
  sourceId: string | null;
  meta: unknown;
  after: unknown;
}

// Every stored event of an org, read by the superuser (RLS never applies to it), by seq.
export async function stored(env: AuditEnv, orgId: string): Promise<StoredEvent[]> {
  const { sql } = env.wall.loaded;
  const found = await rows<Record<string, unknown>>(
    env.wall.sup,
    sql`SELECT * FROM ${sql.raw(env.table.qualified)} WHERE org_id = ${orgId}::uuid ORDER BY seq`,
  );
  const col = (key: string): string => column(env, key);
  return found.map((r) => ({
    orgId: String(r[col('orgId')]),
    seq: Number(r[col('seq')]),
    prevHash: (r[col('prevHash')] as string | null) ?? null,
    hash: String(r[col('hash')]),
    actorType: String(r[col('actorType')]),
    actorId: String(r[col('actorId')]),
    action: String(r[col('action')]),
    sourceId: (r[col('sourceId')] as string | null) ?? null,
    meta: r[col('meta')],
    after: r[col('after')],
  }));
}

// The column name behind a JS key of `auditEvents`.
export function column(env: AuditEnv, key: string): string {
  const c = (env.mods.auditEvents as unknown as Record<string, { name?: string }>)[key];
  if (!c || typeof c.name !== 'string') throw new Error(`auditEvents has no \`${key}\` column`);
  return c.name;
}

// The partition of the audit table that holds `orgId`, found in the catalog.
export async function partitionOf(env: AuditEnv, orgId: string): Promise<string> {
  const { sql } = env.wall.loaded;
  const found = await rows<{ schema: string; name: string }>(
    env.wall.sup,
    sql`SELECT n.nspname AS schema, c.relname AS name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent = ${env.table.qualified}::regclass
          AND pg_get_expr(c.relpartbound, c.oid) LIKE ${`%${orgId}%`}`,
  );
  if (found.length !== 1) throw new Error(`expected one audit partition for org ${orgId}, found ${found.length}`);
  return `"${found[0]!.schema}"."${found[0]!.name}"`;
}

// Changes a stored row the way an attacker with the owner account would: as grc_migrator in
// one transaction, with RLS forcing and the user triggers switched off, then back on.
export async function tamper(env: AuditEnv, orgId: string, seq: number, set: string): Promise<void> {
  const { sql } = env.wall.loaded;
  const t = env.table.qualified;
  await env.migrator.transaction(async (tx) => {
    await tx.execute(sql.raw(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`));
    await tx.execute(sql.raw(`ALTER TABLE ${t} DISABLE TRIGGER USER`));
    const res = await rows<{ n: number }>(
      tx,
      sql`WITH u AS (UPDATE ${sql.raw(t)} SET ${sql.raw(set)}
                     WHERE org_id = ${orgId}::uuid AND seq = ${seq} RETURNING 1)
          SELECT count(*)::int AS n FROM u`,
    );
    if (res[0]?.n !== 1) throw new Error(`tamper: expected to change 1 row, changed ${res[0]?.n}`);
    await tx.execute(sql.raw(`ALTER TABLE ${t} ENABLE TRIGGER USER`));
    await tx.execute(sql.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`));
  });
}

export class LogCapture {
  lines: string[] = [];
  write(line: string): void {
    this.lines.push(String(line));
  }
}

export async function makeLogger(capture: LogCapture): Promise<Logger> {
  const mod = (await import('../../src/common/logger.js')) as { createLogger: (s: LogCapture) => Logger };
  return mod.createLogger(capture);
}
