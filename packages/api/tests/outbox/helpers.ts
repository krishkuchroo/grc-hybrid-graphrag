// Shared set-up for the M0-013 audit-outbox tests (D26, D37, D45.4, D45.5, D48, D73).
//
// Contract these tests hold the code to (TASKS.md, brief M0-013):
// - `src/audit/outbox.ts` exports `class AuditOutbox`, built with `new AuditOutbox(graph)` where
//   `graph` is the M0-004 GraphService (only its `write` is needed). Method:
//     `withAuditedWrite<T>(orgId, actor, fn): Promise<T>`
//       - `actor` is `{ actorType: 'user' | 'api_key' | 'system'; actorId: string }`.
//       - `fn(tx)` gets the write transaction and resolves to
//         `{ result: T; audit: Omit<AuditEventInput, 'orgId' | 'actorType' | 'actorId'> }`.
//       - In the SAME transaction (one `graph.write` call), it creates one
//         `(:AuditOutbox {id, orgId, payload, createdAt})` node in `org-<orgId>` that holds the
//         audit entry. It resolves to `result`. If `fn` throws, or the transaction fails, it
//         rejects and neither the change nor the outbox node is kept.
// - `src/audit/outbox-relay.job.ts` exports
//     `OUTBOX_RELAY_INTERVAL_MS = 2000`
//     `class OutboxRelay`, built with
//       `new OutboxRelay({ graph, audit, orgIds, log?, intervalMs? })` where
//         `graph`  has GraphService's `read` and `write` (the writer account),
//         `audit`  has AuditService's `append` (M0-012),
//         `orgIds` is `() => Promise<readonly string[]>`, the orgs to relay,
//         `intervalMs` defaults to OUTBOX_RELAY_INTERVAL_MS.
//     Methods:
//       `runOnce(): Promise<void>` one pass over every org: reads that org's outbox nodes oldest
//          first (the order they were written), appends each to Postgres with
//          `sourceId = <outbox node id>` and the entry's actor, action, target, before, after
//          and meta, for the org whose database it is in, and only then deletes the node.
//          If an append fails, that org's later entries wait for a later pass (never copied
//          ahead of an earlier one), and nothing is deleted that was not copied. With a
//          failure it may reject or resolve; the tests accept either.
//       `start(): void` runs a pass every `intervalMs` until stopped; a failed pass never stops
//          the loop.
//       `stop(): Promise<void>` resolves once no pass is running and no new one will start.
// - The worker program (M0-007 `createWorkerApp`) runs the relay for every org, so a change
//   saved through `withAuditedWrite` reaches Postgres within 5 s while the worker runs. The test
//   org has its Postgres organization row, its audit partition and its Neo4j database, so any
//   of those may be the worker's list of orgs.
//
// Throwaway data (D82): each test file gets its own migrated Postgres database (the M0-012
// helpers) and its own `org-<uuid>` Neo4j databases, dropped in afterAll. Seed orgs are made by
// the superuser, with their audit partition. Outbox nodes are read by the Neo4j Desktop `neo4j`
// account, which is used only to check and clean up.
import { randomUUID } from 'node:crypto';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { closeDb, rows } from '../db/helpers.js';
import { graphTestEnv, runOn, runSetupNeo4j, superDriver } from '../graph/helpers.js';
import { ThrowawayDatabases } from '../graph/throwaway-databases.js';
import {
  column,
  newOrg,
  setUpAudit,
  tearDownAudit,
  type AuditEnv,
  type AuditEventInput,
  type AuditServiceLike,
  type SeededOrg,
} from '../audit/helpers.js';

export { waitFor } from '../platform/helpers.js';
export type { AuditEnv, AuditEventInput, AuditServiceLike, SeededOrg };

export const LONG = 180_000;
export const OUTBOX_LABEL = 'AuditOutbox';

// ---------- the code under test ----------

export type Actor = { actorType: 'user' | 'api_key' | 'system'; actorId: string };
export type OutboxAudit = Omit<AuditEventInput, 'orgId' | 'actorType' | 'actorId'>;

export interface GraphLike {
  write<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
  read<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
  createOrgDatabase(orgId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AuditOutboxLike {
  withAuditedWrite<T>(
    orgId: string,
    actor: Actor,
    fn: (tx: ManagedTransaction) => Promise<{ result: T; audit: OutboxAudit }>,
  ): Promise<T>;
}

export interface RelayDeps {
  graph: Pick<GraphLike, 'read' | 'write'>;
  audit: Pick<AuditServiceLike, 'append'>;
  orgIds: () => Promise<readonly string[]>;
  log?: Logger;
  intervalMs?: number;
}

export interface RelayLike {
  runOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface OutboxModules {
  AuditOutbox: new (graph: Pick<GraphLike, 'write'>) => AuditOutboxLike;
  OutboxRelay: new (deps: RelayDeps) => RelayLike;
  OUTBOX_RELAY_INTERVAL_MS: number;
}

function need<T>(mod: Record<string, unknown>, file: string, name: string): T {
  if (mod[name] === undefined) throw new Error(`${file} must export \`${name}\``);
  return mod[name] as T;
}

// The files under test, loaded at run time (not at transform time), so a missing file shows up
// as failing tests that name it, after the set-up has run.
const OUTBOX_FILE = '../../src/audit/outbox.js';
const RELAY_FILE = '../../src/audit/outbox-relay.job.js';

async function importFile(file: string, shown: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${shown} could not be loaded: ${(err as Error).message}`, { cause: err });
  }
}

// Loads the code under test inside the set-up, so a missing module shows up as a failing test
// that names the missing file.
export async function loadOutbox(): Promise<OutboxModules> {
  const outbox = await importFile(OUTBOX_FILE, 'src/audit/outbox.ts');
  const relay = await importFile(RELAY_FILE, 'src/audit/outbox-relay.job.ts');
  return {
    AuditOutbox: need(outbox, 'src/audit/outbox.ts', 'AuditOutbox'),
    OutboxRelay: need(relay, 'src/audit/outbox-relay.job.ts', 'OutboxRelay'),
    OUTBOX_RELAY_INTERVAL_MS: need(relay, 'src/audit/outbox-relay.job.ts', 'OUTBOX_RELAY_INTERVAL_MS'),
  };
}

// ---------- set-up ----------

export interface OutboxEnv {
  audit: AuditEnv;
  graph: GraphLike;
  sup: Driver;
  databases: ThrowawayDatabases;
  relays: RelayLike[];
  extraDbs: unknown[];
}

let setUpNeo4jDone = false;

async function newGraphService(): Promise<GraphLike> {
  const { GraphService } = await import('../../src/graph/graph.service.js');
  const e = graphTestEnv();
  return new GraphService({
    uri: e.uri,
    adminPassword: e.adminPassword,
    writerPassword: e.writerPassword,
  }) as unknown as GraphLike;
}

/** Postgres (throwaway, migrated), the AuditService as grc_app, and a GraphService. */
export async function setUpOutbox(): Promise<OutboxEnv> {
  if (!setUpNeo4jDone) {
    const res = await runSetupNeo4j();
    if (res.status !== 0) throw new Error(`pnpm setup:neo4j failed:\n${res.stdout}\n${res.stderr}`);
    setUpNeo4jDone = true;
  }
  const audit = await setUpAudit();
  const sup = superDriver();
  return {
    audit,
    graph: await newGraphService(),
    sup,
    databases: new ThrowawayDatabases(sup),
    relays: [],
    extraDbs: [],
  };
}

export async function tearDownOutbox(env: OutboxEnv | undefined): Promise<void> {
  if (!env) return;
  try {
    for (const r of env.relays) await r.stop().catch(() => undefined);
    for (const db of env.extraDbs) await closeDb(db);
    await env.databases.dropAll();
  } finally {
    await env.graph.close().catch(() => undefined);
    await env.sup.close();
    await tearDownAudit(env.audit);
  }
}

/** An org with its Postgres row, its audit partition and its Neo4j database `org-<id>`. */
export async function newOutboxOrg(env: OutboxEnv, name: string): Promise<SeededOrg> {
  const org = await newOrg(env.audit, name);
  env.databases.track(`org-${org.id}`);
  await env.graph.createOrgDatabase(org.id);
  return org;
}

export function relay(env: OutboxEnv, mods: OutboxModules, deps: Partial<RelayDeps> & { orgs: string[] }): RelayLike {
  const { orgs, ...rest } = deps;
  const r = new mods.OutboxRelay({
    graph: env.graph,
    audit: env.audit.audit,
    orgIds: async () => orgs,
    ...rest,
  });
  env.relays.push(r);
  return r;
}

// ---------- writes ----------

export const ACTOR: Actor = { actorType: 'user', actorId: 'user-outbox-test' };

export function auditFor(n: number, extra: Partial<OutboxAudit> = {}): OutboxAudit {
  return {
    action: 'risk.updated',
    targetType: 'Risk',
    targetId: riskId(n),
    before: { status: 'active', score: n },
    after: { status: 'active', score: n + 1 },
    meta: { n },
    ...extra,
  };
}

export function riskId(n: number): string {
  return `RSK${String(1000 + n).padStart(7, '0')}`;
}

/** Saves one Risk change through withAuditedWrite; resolves to what fn returned. */
export async function writeRisk(outbox: AuditOutboxLike, orgId: string, n: number): Promise<string> {
  return outbox.withAuditedWrite(orgId, ACTOR, async (tx) => {
    await tx.run('MERGE (r:Risk {number: $number}) SET r.score = $score', { number: riskId(n), score: n + 1 });
    return { result: `saved-${n}`, audit: auditFor(n) };
  });
}

// ---------- reading the two databases ----------

export interface OutboxNode {
  id: unknown;
  orgId: unknown;
  payload: unknown;
  createdAt: unknown;
}

export async function outboxNodes(env: OutboxEnv, orgId: string): Promise<OutboxNode[]> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (o:${OUTBOX_LABEL}) RETURN o.id AS id, o.orgId AS orgId, o.payload AS payload, o.createdAt AS createdAt`,
  );
  return found as unknown as OutboxNode[];
}

export async function riskCount(env: OutboxEnv, orgId: string, number?: string): Promise<number> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    number === undefined
      ? 'MATCH (r:Risk) RETURN count(r) AS n'
      : 'MATCH (r:Risk {number: $number}) RETURN count(r) AS n',
    { number },
  );
  return Number(found[0]?.['n'] ?? 0);
}

export interface Row {
  orgId: string;
  seq: number;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  meta: unknown;
  sourceId: string | null;
}

/** Every audit row of an org, read by the superuser (RLS never applies to it), by seq. */
export async function auditRows(env: OutboxEnv, orgId: string): Promise<Row[]> {
  const a = env.audit;
  const { sql } = a.wall.loaded;
  const found = await rows<Record<string, unknown>>(
    a.wall.sup,
    sql`SELECT * FROM ${sql.raw(a.table.qualified)} WHERE org_id = ${orgId}::uuid ORDER BY seq`,
  );
  const get = (r: Record<string, unknown>, key: string): unknown => r[column(a, key)];
  return found.map((r) => ({
    orgId: String(get(r, 'orgId')),
    seq: Number(get(r, 'seq')),
    actorType: String(get(r, 'actorType')),
    actorId: String(get(r, 'actorId')),
    action: String(get(r, 'action')),
    targetType: (get(r, 'targetType') as string | null) ?? null,
    targetId: (get(r, 'targetId') as string | null) ?? null,
    before: get(r, 'before'),
    after: get(r, 'after'),
    meta: get(r, 'meta'),
    sourceId: (get(r, 'sourceId') as string | null) ?? null,
  }));
}

/** The `meta.n` of each row, in seq order: the order the entries reached Postgres. */
export function ns(found: Row[]): number[] {
  return found.map((r) => Number((r.meta as { n?: unknown } | null)?.n));
}

// ---------- fault injection ----------

export class InjectedCrash extends Error {
  constructor() {
    super('injected crash: the relay died here');
    this.name = 'InjectedCrash';
  }
}

/**
 * An audit service for a relay that is killed right after its first Postgres append commits
 * and before it can delete the outbox node. After the "kill" every call fails, as nothing
 * runs in a dead process.
 */
export function crashAfterFirstAppend(real: Pick<AuditServiceLike, 'append'>): Pick<AuditServiceLike, 'append'> & {
  appended: number;
} {
  const state = { appended: 0, dead: false };
  return {
    get appended() {
      return state.appended;
    },
    async append(e) {
      if (state.dead) throw new InjectedCrash();
      await real.append(e);
      state.appended++;
      state.dead = true;
      throw new InjectedCrash();
    },
  };
}

/** A real AuditService whose Postgres can't be reached (nothing listens on the port). */
export function downAudit(env: OutboxEnv): AuditServiceLike {
  const db = env.audit.wall.loaded.createDb(`postgres://grc_app@127.0.0.1:1/${env.audit.wall.dbName}`, {
    max: 1,
  });
  env.extraDbs.push(db);
  return new env.audit.mods.AuditService(db);
}

/** Switches between a Postgres that is down and the real one. */
export function switchableAudit(
  up: Pick<AuditServiceLike, 'append'>,
  down: Pick<AuditServiceLike, 'append'>,
): Pick<AuditServiceLike, 'append'> & { up: boolean; failures: number } {
  const s = { up: false, failures: 0 };
  return {
    get up() {
      return s.up;
    },
    set up(v: boolean) {
      s.up = v;
    },
    get failures() {
      return s.failures;
    },
    async append(e) {
      if (s.up) return up.append(e);
      try {
        return await down.append(e);
      } catch (err) {
        s.failures++;
        throw err;
      }
    },
  };
}

export function newId(): string {
  return randomUUID();
}

export async function settle(p: Promise<unknown>): Promise<void> {
  await p.catch(() => undefined);
}
