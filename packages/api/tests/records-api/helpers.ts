// Shared set-up for the S1-004 record-route tests (test writer's file, D89/D96).
//
// Decisions: D30, D47, D50, D51, D54, D55, D59, D69, D163, D164, D175, D176, D198, D199, D206.
// The brief is TASKS.md "Task: S1-004", with the S1 shared notes.
//
// Contract these tests hold the code to:
// - For each kind, with `P = RECORD_PATHS[kind]` from @grc/shared:
//     GET   /api/v1/P              view   the S1-003 list query        -> 200 Paged<Record>
//     GET   /api/v1/P/:id          view                                -> 200 the record, 404 when not visible
//     POST  /api/v1/P              edit   the create schema            -> 201 the record
//     PATCH /api/v1/P/:id          edit   the update schema + version  -> 200 the record, 409 stale_version
//     POST  /api/v1/P/:id/retire   edit   { version }                  -> 200 the record
//   Routes are guarded by `@Requires(kind, 'view'|'edit')` + `AccessGuard`. A cell `none` is 403 on
//   all five routes; a `view` cell is 403 on the three edit routes (the guard refuses before the
//   service runs, as in the M0-008 access-guard tests). The control routes carry the opt-in `own`
//   flag: a Control Owner (`edit_own`) passes the guard, and the service applies ownership (404 on a
//   control they don't own; POST /api/v1/controls 403, D199).
// - GET /api/v1/people: any signed-in caller; paged; the caller's org members as `{ id, name, role }`.
// - The caller is `request.principal`: a session gives `{ orgId, userId, role, clearance }`, an API
//   key gives `{ orgId, userId: 'api_key:<id>', role, clearance: 'internal', apiKeyId }` (D54). The
//   routes pass `apiKeyId` on, so a key's audit entries have `actorType: 'api_key'`.
// - Errors leave in the one D47 format.
//
// Throwaway data (D82, D176): each test file gets its own migrated Postgres database (the M0
// platform helpers), and its own `org-<uuid>` Neo4j databases with the S1-002 schema, all dropped in
// afterAll. Test records are seeded through the merged S1-003 `RecordsService` taken from the
// running app, so only the routes are under test. Nothing shared is changed.
import 'reflect-metadata';
import type { Driver } from 'neo4j-driver';
import { expect } from 'vitest';
import {
  LABELS,
  NODE_LABELS,
  RECORD_KINDS,
  RECORD_PATHS,
  ROLES,
  ROLE_TABLE,
  type Label,
  type RecordKind,
  type Role,
} from '@grc/shared';
import {
  call,
  closeKit,
  json,
  kit,
  mfaUser,
  seedOrg,
  show,
  type Kit,
  type Org,
  type SignedIn,
} from '../auth/helpers.js';
import { dropDatabases, runOn, superDriver } from '../graph-accounts/helpers.js';
import {
  LogCapture,
  expectErrorFormat,
  platformDb,
  startApi,
  startWorker,
  type ApiApp,
  type ErrorBody,
  type InjectResponse,
  type PlatformDb,
  type WorkerApp,
} from '../platform/helpers.js';
import { useKey, type NewKey } from '../api-keys/helpers.js';
import { fieldChange, uniqueName, validInput } from '../records-service/helpers.js';

export { LABELS, RECORD_KINDS, RECORD_PATHS, ROLES, ROLE_TABLE, fieldChange, json, show, uniqueName, validInput };
export type { Label, RecordKind, Role, SignedIn, NewKey, Org, InjectResponse };

export const PREFIX = '/api/v1';
export const LONG = 300_000;
export const T = 120_000;
export const STALE_MESSAGE = 'This record changed since you opened it. Reload it and try again.';
export const UNKNOWN_ID = '5f0c2d1e-9a8b-4c7d-8e6f-1a2b3c4d5e6f';

export type Route = 'list' | 'get' | 'create' | 'update' | 'retire';
export const ROUTES: readonly Route[] = ['list', 'get', 'create', 'update', 'retire'];

export function base(kind: RecordKind): string {
  return `${PREFIX}/${RECORD_PATHS[kind]}`;
}

// ---------- the seeding service (S1-003, merged) ----------

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
  [field: string]: unknown;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface RecordsServiceLike {
  create(caller: Caller, kind: RecordKind, input: Record<string, unknown>): Promise<RecordOut>;
  get(caller: Caller, kind: RecordKind, id: string): Promise<RecordOut>;
  list(caller: Caller, kind: RecordKind, query: Record<string, unknown>): Promise<Paged<RecordOut>>;
}

// ---------- one API app per test file ----------

export interface ApiEnv {
  db: PlatformDb;
  app: ApiApp;
  k: Kit;
  logs: LogCapture;
  graph: { createOrgDatabase(orgId: string): Promise<void> } & Record<string, unknown>;
  records: RecordsServiceLike;
  sup: Driver;
  databases: Set<string>;
  worker?: WorkerApp;
}

/** A throwaway Postgres database, the API app (and the worker, when asked) and the seeding kit. */
export async function setUpRecordsApi(opts: { worker?: boolean } = {}): Promise<ApiEnv> {
  const db = await platformDb();
  const logs = new LogCapture();
  let app: ApiApp | undefined;
  let worker: WorkerApp | undefined;
  try {
    app = await startApi({ logStream: logs });
    const { GRAPH } = await import('../../src/graph/graph.module.js');
    const { RecordsService } = await import('../../src/records/records.service.js');
    const graph = app.get<ApiEnv['graph']>(GRAPH);
    const records = app.get<RecordsServiceLike>(RecordsService);
    if (opts.worker) worker = await startWorker();
    return { db, app, k: kit(db), logs, graph, records, sup: superDriver(), databases: new Set(), worker };
  } catch (err) {
    await worker?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await db.drop();
    throw err;
  }
}

export async function tearDownRecordsApi(env: ApiEnv | undefined): Promise<void> {
  if (!env) return;
  try {
    await env.worker?.close().catch(() => undefined);
    await env.app.close().catch(() => undefined);
    await dropDatabases(env.sup, env.databases).catch(() => undefined);
  } finally {
    await env.sup.close().catch(() => undefined);
    await closeKit(env.k);
    await env.db.drop();
  }
}

/** An org in Postgres (row and audit partition) and its `org-<id>` Neo4j database with the S1-002 schema. */
export async function newApiOrg(env: ApiEnv, name: string): Promise<Org> {
  const org = await seedOrg(env.k, name);
  env.databases.add(`org-${org.id}`);
  await env.graph.createOrgDatabase(org.id);
  const { ensureOrgSchema } = await import('../../src/graph/org-schema.js');
  await ensureOrgSchema(env.graph as never, org.id);
  return org;
}

/** A member of `org` with this role and clearance, signed in with MFA checked. */
export async function person(env: ApiEnv, org: Org, role: Role, clearance: Label = 'restricted'): Promise<SignedIn> {
  return mfaUser(env.k, env.app, org, { role, clearance });
}

export function callerOf(s: SignedIn): Caller {
  return { orgId: s.user.org.id, userId: s.user.id, role: s.user.role, clearance: s.user.clearance };
}

/** A record made through the S1-003 service (not the routes), by `by`. */
export async function seed(
  env: ApiEnv,
  by: SignedIn,
  kind: RecordKind,
  extra: Record<string, unknown> = {},
): Promise<RecordOut> {
  return env.records.create(callerOf(by), kind, validInput(kind, extra));
}

// ---------- requests ----------

export type Who = SignedIn | NewKey;

function isKey(who: Who): who is NewKey {
  return typeof (who as NewKey).key === 'string';
}

export async function send(
  env: ApiEnv,
  who: Who,
  opts: { method?: string; url: string; payload?: unknown },
): Promise<InjectResponse> {
  if (isKey(who)) return useKey(env.app, who, opts);
  return call(env.app, who.jar, opts);
}

export function listR(env: ApiEnv, who: Who, kind: RecordKind, query = ''): Promise<InjectResponse> {
  return send(env, who, { url: `${base(kind)}${query}` });
}

export function getR(env: ApiEnv, who: Who, kind: RecordKind, id: string): Promise<InjectResponse> {
  return send(env, who, { url: `${base(kind)}/${id}` });
}

export function createR(env: ApiEnv, who: Who, kind: RecordKind, body: unknown): Promise<InjectResponse> {
  return send(env, who, { method: 'POST', url: base(kind), payload: body });
}

export function patchR(env: ApiEnv, who: Who, kind: RecordKind, id: string, body: unknown): Promise<InjectResponse> {
  return send(env, who, { method: 'PATCH', url: `${base(kind)}/${id}`, payload: body });
}

export function retireR(
  env: ApiEnv,
  who: Who,
  kind: RecordKind,
  id: string,
  version: unknown,
): Promise<InjectResponse> {
  return send(env, who, { method: 'POST', url: `${base(kind)}/${id}/retire`, payload: { version } });
}

/** Every page of a list as `who`, with `status=all` unless the query says otherwise. */
export async function listIds(env: ApiEnv, who: Who, kind: RecordKind, query = 'status=all'): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const res = await listR(env, who, kind, `?${query}&pageSize=100&page=${page}`);
    expect(res.statusCode, show(res)).toBe(200);
    const body = json(res) as unknown as Paged<{ id: string }>;
    ids.push(...body.items.map((i) => i.id));
    if (body.items.length < 100) break;
  }
  return ids;
}

// ---------- reading back ----------

/** The stored node's properties (the Desktop `neo4j` account), or undefined. */
export async function storedNode(
  env: ApiEnv,
  orgId: string,
  kind: RecordKind,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (n:${NODE_LABELS[kind]} {id: $id}) RETURN properties(n) AS p`,
    {
      id,
    },
  );
  return found[0]?.['p'] as Record<string, unknown> | undefined;
}

/** How many nodes of `kind` in the org have this name. */
export async function countNamed(env: ApiEnv, orgId: string, kind: RecordKind, name: string): Promise<number> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (n:${NODE_LABELS[kind]} {name: $name}) RETURN count(n) AS n`,
    {
      name,
    },
  );
  return Number(found[0]?.['n'] ?? 0);
}

/** Expects the stored node to still have this version and owner, and this label. */
export async function expectUnchanged(env: ApiEnv, orgId: string, kind: RecordKind, rec: RecordOut): Promise<void> {
  const node = await storedNode(env, orgId, kind, rec.id);
  expect(node, `${kind} ${rec.id} is still stored`).toBeDefined();
  expect(Number(node?.['version']), 'version unchanged').toBe(rec.version);
  expect(node?.['owner'], 'owner unchanged').toBe(rec.owner);
  expect(node?.['sensitivity'], 'label unchanged').toBe(rec.label);
  expect(node?.['status'], 'status unchanged').toBe(rec.status);
}

// ---------- answers ----------

/** A refusal in the one D47 format, with this status and (when given) code. */
export function expectRefused(res: InjectResponse, status: number, code?: string): ErrorBody {
  const body = expectErrorFormat(res, status);
  if (code !== undefined) expect(body.error.code, show(res)).toBe(code);
  if (status === 404) {
    // A record the caller can't see, from a route that exists: not the router's own 404 for a
    // path it doesn't serve ("Cannot GET /api/v1/…").
    expect(body.error.message, `a record 404 from a served route: ${show(res)}`).not.toMatch(/^Cannot [A-Z]+ \//);
  }
  return body;
}

/** What the D50 cell says a route answers: 'ok', 403, or 'own' (allowed only on an owned control). */
export function expectedFor(role: Role, kind: RecordKind, route: Route): 'ok' | 403 | 'own' {
  const cell = ROLE_TABLE[kind][role];
  if (cell === 'edit') return 'ok';
  if (cell === 'view') return route === 'list' || route === 'get' ? 'ok' : 403;
  if (cell === 'edit_own') return route === 'create' ? 403 : 'own';
  return 403;
}
