// Shared set-up for the S1-003 records-service tests (test writer's file, D89/D96).
//
// Decisions: D26, D37, D45.3, D45.4, D45.6, D50, D51, D59, D68, D69, D73, D163, D164, D196, D197,
// D198, D199, D206. The brief is TASKS.md "Task: S1-003", with the S1 shared notes.
//
// Contract these tests hold the code to:
// - `src/records/records.service.ts` exports
//     `RECORD_READ_TIMEOUT_MS = 5000`
//     `class RecordsService`, built like the outbox relay, with one deps object:
//       `new RecordsService({ graph, outbox, db, log? })` where
//         `graph`  is the GraphService (`write`, `read`, `readAs`),
//         `outbox` is the AuditOutbox (`withAuditedWrite`),
//         `db`     is the grc_app Drizzle database (the `member` table, through `withOrgContext`),
//         `log`    is an optional pino Logger (default `createLogger()`).
//     Methods, with `Caller = { orgId, userId, role, clearance, apiKeyId? }`:
//       create(caller, kind, input)          -> RecordOut
//       get(caller, kind, id)                -> RecordOut
//       list(caller, kind, query)            -> Paged<RecordOut>
//       update(caller, kind, id, input)      -> RecordOut   (input carries `version`)
//       retire(caller, kind, id, version)    -> RecordOut
//   `RecordOut` is `recordSchemas[kind]` from @grc/shared (the label as `label`), and a risk's also
//   has `rating: { score, band }` (D197).
// - Errors are `ApiError` (src/common/errors.ts): 404 `not_found`, 403 `forbidden`, 409
//   `stale_version`, 400 `validation_failed`. A ZodError also counts as 400 `validation_failed`,
//   because the one D47 error filter turns it into exactly that answer.
// - The list query (`list(caller, kind, query)`) is a plain object: `page`, `pageSize` (the
//   `pageQuerySchema` rules), `sort`, `status` (`active` by default, `retired`, `all`), `owner`,
//   `label`, `q`, and each type's list fields: `assetType`, `criticality` (asset), `controlStatus`,
//   `framework` (control), `severity`, `incidentStatus` (incident), `band` (risk). `sort` is
//   `number` (default), `name`, `updatedAt`, or `score` (risks only); a leading `-` sorts
//   descending, for example `-name`. Anything else is 400.
//
// Throwaway data (D82, D176): each test file gets its own migrated Postgres database (the M0
// org-wall helpers) and its own `org-<uuid>` Neo4j databases with the S1-002 schema, all dropped in
// afterAll. The Desktop `neo4j` account only reads the graph back and cleans up. Nothing shared is
// changed: no privilege, account or setting.
import { randomUUID } from 'node:crypto';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { expect } from 'vitest';
import { ROLES, LABELS, type Label, type RecordKind, type Role } from '@grc/shared';
import { closeDb } from '../db/helpers.js';
import { dropDatabases, runOn, superDriver } from '../graph/helpers.js';
import { addMember, addUser } from '../org-wall/helpers.js';
import { appTestEnv } from '../platform/helpers.js';
import {
  LogCapture,
  makeLogger,
  newOrg,
  setUpAudit,
  tearDownAudit,
  type AuditEnv,
  type SeededOrg,
} from '../audit/helpers.js';

export { LogCapture, ROLES, LABELS, type Label, type RecordKind, type Role };

export const LONG = 300_000;
export const T = 120_000;

// ---------- the code under test ----------

export interface Caller {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
  apiKeyId?: string;
}

export interface RecordOut {
  id: string;
  number: string;
  name: string;
  label: Label;
  status: 'active' | 'retired';
  owner: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  origin: string;
  sourceIds: string[];
  rating?: { score: number; band: string };
  [field: string]: unknown;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export type Input = Record<string, unknown>;

export interface RecordsServiceLike {
  create(caller: Caller, kind: RecordKind, input: Input): Promise<RecordOut>;
  get(caller: Caller, kind: RecordKind, id: string): Promise<RecordOut>;
  list(caller: Caller, kind: RecordKind, query: Input): Promise<Paged<RecordOut>>;
  update(caller: Caller, kind: RecordKind, id: string, input: Input): Promise<RecordOut>;
  retire(caller: Caller, kind: RecordKind, id: string, version: number): Promise<RecordOut>;
}

export interface GraphLike {
  write<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
  read<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
  readAs<T>(
    orgId: string,
    role: string,
    clearance: string,
    fn: (tx: ManagedTransaction) => Promise<T>,
    options: { timeoutMs: number },
  ): Promise<T>;
  createOrgDatabase(orgId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AuditActor {
  actorType: 'user' | 'api_key' | 'system';
  actorId: string;
}

export interface OutboxLike {
  withAuditedWrite<T>(
    orgId: string,
    actor: AuditActor,
    fn: (tx: ManagedTransaction) => Promise<{ result: T; audit: Record<string, unknown> }>,
  ): Promise<T>;
}

export interface ServiceDeps {
  graph: unknown;
  outbox: unknown;
  db: unknown;
  log?: Logger;
}

export interface RecordsModuleExports {
  RecordsService: new (deps: ServiceDeps) => RecordsServiceLike;
  RECORD_READ_TIMEOUT_MS: number;
}

async function importFile(rel: string, shown: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ rel)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${shown} could not be loaded: ${(err as Error).message}`, { cause: err });
  }
}

/** Loaded inside the tests, so a missing file fails each test with a message naming it. */
export async function loadRecords(): Promise<RecordsModuleExports> {
  const shown = 'src/records/records.service.ts';
  const mod = await importFile('../../src/records/records.service.js', shown);
  if (typeof mod['RecordsService'] !== 'function') throw new Error(`${shown} must export \`RecordsService\``);
  if (mod['RECORD_READ_TIMEOUT_MS'] === undefined) throw new Error(`${shown} must export \`RECORD_READ_TIMEOUT_MS\``);
  return mod as unknown as RecordsModuleExports;
}

// ---------- set-up ----------

export interface OrgUsers {
  /** One member per role, each at clearance `restricted` in the member table. */
  byRole: Record<Role, string>;
  /** A second Control Owner (for hand-overs). */
  controlOwner2: string;
}

export interface TestOrg extends SeededOrg {
  users: OrgUsers;
}

export interface RecEnv {
  audit: AuditEnv;
  graph: GraphLike;
  outbox: OutboxLike;
  sup: Driver;
  databases: Set<string>;
  log: LogCapture;
  logger: Logger;
}

/** Postgres (throwaway, migrated), the GraphService (with the query accounts) and the outbox. */
export async function setUpRecords(): Promise<RecEnv> {
  const audit = await setUpAudit();
  try {
    const { graphFromEnv } = await import('../../src/graph/graph.module.js');
    const { AuditOutbox } = await import('../../src/audit/outbox.js');
    const graph = graphFromEnv(appTestEnv()) as unknown as GraphLike;
    const log = new LogCapture();
    return {
      audit,
      graph,
      outbox: new AuditOutbox(graph as never) as unknown as OutboxLike,
      sup: superDriver(),
      databases: new Set(),
      log,
      logger: await makeLogger(log),
    };
  } catch (err) {
    await tearDownAudit(audit);
    throw err;
  }
}

export async function tearDownRecords(env: RecEnv | undefined): Promise<void> {
  if (!env) return;
  try {
    await dropDatabases(env.sup, env.databases).catch(() => undefined);
  } finally {
    await env.graph.close().catch(() => undefined);
    await env.sup.close().catch(() => undefined);
    await tearDownAudit(env.audit);
  }
}

/**
 * An org with its Postgres row, audit partition and members (one per role, plus a second Control
 * Owner), and, unless `graph: false`, its Neo4j database with the S1-002 schema.
 */
export async function newTestOrg(env: RecEnv, name: string, opts: { graph?: boolean } = {}): Promise<TestOrg> {
  const org = await newOrg(env.audit, name);
  const byRole = {} as Record<Role, string>;
  for (const role of ROLES) {
    if (role === 'admin') {
      byRole.admin = org.adminId;
      continue;
    }
    const id = await addUser(env.audit.wall, `${name} ${role}`);
    await addMember(env.audit.wall, org.id, id, role, 'restricted');
    byRole[role] = id;
  }
  const controlOwner2 = await addUser(env.audit.wall, `${name} control owner two`);
  await addMember(env.audit.wall, org.id, controlOwner2, 'control_owner', 'restricted');
  if (opts.graph !== false) {
    env.databases.add(`org-${org.id}`);
    await env.graph.createOrgDatabase(org.id);
    const { ensureOrgSchema } = await import('../../src/graph/org-schema.js');
    await ensureOrgSchema(env.graph as never, org.id);
  }
  return { ...org, users: { byRole, controlOwner2 } };
}

/** A user that is a member of no org. */
export async function strayUser(env: RecEnv, name: string): Promise<string> {
  return addUser(env.audit.wall, name);
}

/** The service under test, with the real graph, outbox and grc_app database unless overridden. */
export async function service(env: RecEnv, overrides: Partial<ServiceDeps> = {}): Promise<RecordsServiceLike> {
  const { RecordsService } = await loadRecords();
  return new RecordsService({
    graph: env.graph,
    outbox: env.outbox,
    db: env.audit.appDb,
    log: env.logger,
    ...overrides,
  });
}

// ---------- callers ----------

export function caller(org: TestOrg, role: Role, clearance: Label = 'restricted', userId?: string): Caller {
  return { orgId: org.id, userId: userId ?? org.users.byRole[role], role, clearance };
}

/** An API-key caller (D54): one org, one role, clearance `internal`, user ID `api_key:<id>`. */
export function keyCaller(org: TestOrg, role: Role, clearance: Label = 'internal'): Caller {
  const apiKeyId = randomUUID();
  return { orgId: org.id, userId: `api_key:${apiKeyId}`, role, clearance, apiKeyId };
}

// ---------- valid inputs ----------

let seq = 0;
export function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix} ${seq} ${randomUUID().slice(0, 8)}`;
}

/** A valid create body for `kind`, with every type field, plus any overrides. */
export function validInput(kind: RecordKind, extra: Input = {}): Input {
  const own: Record<RecordKind, Input> = {
    asset: { assetType: 'server', criticality: 'high', dataClassification: 'internal' },
    risk: { impact: 3, likelihood: 4, financialExposure: 250000 },
    control: { code: 'AC-2', framework: 'NIST 800-53', controlStatus: 'implemented', lastTestedDate: '2026-06-01' },
    policy: { policyVersion: '1.0', effectiveDate: '2026-01-01' },
    incident: { severity: 'high', incidentStatus: 'new', occurredAt: '2026-09-01T10:00:00Z' },
  };
  return { name: uniqueName(`${kind} record`), ...own[kind], ...extra };
}

/** The fields an update may change, one simple change per kind. */
export function fieldChange(kind: RecordKind): Input {
  const change: Record<RecordKind, Input> = {
    asset: { criticality: 'critical' },
    risk: { impact: 5 },
    control: { controlStatus: 'planned' },
    policy: { policyVersion: '2.0' },
    incident: { incidentStatus: 'investigating' },
  };
  return change[kind];
}

// ---------- errors ----------

export interface Refusal {
  status: number;
  code: string;
  message: string;
}

/** What the one D47 error filter would answer for `err` (ApiError, or ZodError as 400). */
export async function describeError(err: unknown): Promise<Refusal> {
  const { ApiError } = await import('../../src/common/errors.js');
  const { ZodError } = await import('zod');
  if (err instanceof ApiError) return { status: err.getStatus(), code: err.code, message: err.message };
  if (err instanceof ZodError) return { status: 400, code: 'validation_failed', message: err.message };
  return { status: -1, code: `not an ApiError: ${String((err as Error)?.name)}`, message: String(err) };
}

/** Expects `p` to be refused with this status (and code, when given). */
export async function refusedWith(p: Promise<unknown>, status: number, code?: string): Promise<Refusal> {
  let caught: unknown;
  let settled = false;
  try {
    await p;
    settled = true;
  } catch (err) {
    caught = err;
  }
  expect(settled, `expected a ${status} refusal, but the call succeeded`).toBe(false);
  const r = await describeError(caught);
  expect(r.status, `refused with ${r.status} ${r.code}: ${r.message}`).toBe(status);
  if (code !== undefined) expect(r.code).toBe(code);
  return r;
}

/** The outcome of a call: 'ok', or the refusal's status. */
export async function outcome(p: Promise<unknown>): Promise<'ok' | number> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const r = await describeError(err);
    if (r.status === -1) throw err;
    return r.status;
  }
}

// ---------- reading the graph back (the Desktop `neo4j` account) ----------

const NODE_LABEL: Record<RecordKind, string> = {
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
};

/** A record node's stored properties, or undefined. */
export async function storedNode(
  env: RecEnv,
  orgId: string,
  kind: RecordKind,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (n:${NODE_LABEL[kind]} {id: $id}) RETURN properties(n) AS p`,
    {
      id,
    },
  );
  return found[0]?.['p'] as Record<string, unknown> | undefined;
}

export async function nodeCount(env: RecEnv, orgId: string, kind: RecordKind, where: Input = {}): Promise<number> {
  const keys = Object.keys(where);
  const filter = keys.length ? `{${keys.map((k) => `${k}: $${k}`).join(', ')}}` : '';
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (n:${NODE_LABEL[kind]} ${filter}) RETURN count(n) AS n`,
    where,
  );
  return Number(found[0]?.['n'] ?? 0);
}

export interface OutboxEntry {
  actorType: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  meta: Record<string, unknown> | null | undefined;
}

/** The audit entries waiting in the org's outbox (no relay runs unless a test starts one). */
export async function outboxEntries(env: RecEnv, orgId: string, targetId?: string): Promise<OutboxEntry[]> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    'MATCH (o:AuditOutbox) RETURN o.payload AS payload ORDER BY o.seq',
  );
  const all = found.map((r) => JSON.parse(String(r['payload'])) as OutboxEntry);
  return targetId === undefined ? all : all.filter((e) => e.targetId === targetId);
}

// ---------- wrappers around the dependencies ----------

export interface GraphCalls {
  read: number;
  write: number;
  readAs: { role: string; clearance: string; timeoutMs: unknown }[];
}

/** The real GraphService, counting the calls the service makes. */
export function spyGraph(graph: GraphLike): { graph: GraphLike; calls: GraphCalls; reset(): void } {
  const calls: GraphCalls = { read: 0, write: 0, readAs: [] };
  const proxy = new Proxy(graph, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'read' || prop === 'write') {
        return (...args: unknown[]) => {
          calls[prop] += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === 'readAs') {
        return (...args: unknown[]) => {
          const options = args[4] as { timeoutMs?: unknown } | undefined;
          calls.readAs.push({ role: String(args[1]), clearance: String(args[2]), timeoutMs: options?.timeoutMs });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return {
    graph: proxy,
    calls,
    reset() {
      calls.read = 0;
      calls.write = 0;
      calls.readAs.length = 0;
    },
  };
}

export class InjectedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InjectedFailure';
  }
}

/**
 * The real outbox, but the transaction fails after the service's own work has run, as a Neo4j
 * error would. The message quotes `quoted`, the way a Neo4j constraint error quotes values.
 */
export function failingOutbox(real: OutboxLike, quoted: string): OutboxLike & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async withAuditedWrite(orgId, actor, fn) {
      state.calls += 1;
      return real.withAuditedWrite(orgId, actor, async (tx) => {
        await fn(tx);
        throw new InjectedFailure(`Node already exists with property \`name\` = '${quoted}'`);
      });
    },
  };
}

/** The real outbox, counting calls and keeping each call's actor. */
export function spyOutbox(real: OutboxLike): OutboxLike & { actors: AuditActor[] } {
  const actors: AuditActor[] = [];
  return {
    actors,
    async withAuditedWrite(orgId, actor, fn) {
      actors.push(actor);
      return real.withAuditedWrite(orgId, actor, fn);
    },
  };
}

export async function closeQuietly(db: unknown): Promise<void> {
  await closeDb(db).catch(() => undefined);
}

/** How many `(:RecordCounter {kind})` nodes the org database holds for `kind`. */
export async function counterNodes(env: RecEnv, orgId: string, kind: RecordKind): Promise<number> {
  const found = await runOn(env.sup, `org-${orgId}`, 'MATCH (c:RecordCounter {kind: $kind}) RETURN count(c) AS n', {
    kind,
  });
  return Number(found[0]?.['n'] ?? 0);
}
