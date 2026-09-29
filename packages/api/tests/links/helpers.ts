// Shared set-up for the S1-005 links tests (test writer's file, D89/D96).
//
// Decisions: D26, D37, D45.3, D45.4, D45.8, D47, D50, D51, D55, D59, D69, D73, D175, D200, D204.
// The brief is TASKS.md "Task: S1-005", with the S1 shared notes.
//
// Contract these tests hold the code to (the routes, all under /api/v1):
// - `POST /api/v1/links` with `{ type, fromId, toId }`. Any signed-in user may call it; the service
//   decides, because the rule depends on both ends:
//     - an end that doesn't exist in the caller's org, or that the caller can't see (another org, a
//       type their role can't view, a label above their clearance, a control a Control Owner doesn't
//       own): 404 `not_found`, the same answer whichever end it is;
//     - `isAllowedLink(type, fromKind, toKind)` false: 400 `link_not_allowed`;
//     - `canLinkRecords` false (D200: can edit either end and see both): 403;
//     - `fromId === toId`: 400; the same type, from and to twice: 409 `link_exists`.
//   201 answers with the link `{ type, fromId, toId, origin: 'manual', createdAt, createdBy }`.
//   The relationship in Neo4j carries `createdAt`, `createdBy` and `origin: 'manual'`, and one
//   `link.created` audit entry (`targetType: 'link'`, `meta { type, fromNumber, toNumber, label }`,
//   label = the higher of the two ends' labels) is written in the same Neo4j transaction, through
//   the app's `AuditOutbox.withAuditedWrite`.
// - `GET /api/v1/<plural>/:id/links` for the five kinds, `@Requires(kind, 'view')` (the Control
//   Owner's `edit_own` controls pass through S1-004's "own" flag and are checked for ownership).
//   Answer `{ items: [{ type, direction: 'out'|'in', other: { id, kind, number, name, label,
//   status }, origin, createdAt, createdBy }] }`. Reads go through `GraphService.readAs` (except the
//   Control Owner's own-control path, S1 shared notes), so a link with a hidden end never shows.
//   The record itself not visible: 404.
// - `GET /api/v1/assets/:id/map?depth=<1|2|3>` (default 2), `@Requires('asset', 'view')`. Answer
//   `{ nodes: [{ id, number, name, assetType, criticality, label }], edges: [{ type: 'HOSTS'|'RUNS',
//   fromId, toId }], truncated }`. HOSTS and RUNS only, both directions, visible assets only, at most
//   `MAP_MAX_NODES` (200) assets with the centre included, then `truncated: true` (D204). A depth
//   of 0, 4, a fraction or text is 400.
//
// Throwaway data (D82, D176): each test file gets its own migrated Postgres database (the M0
// platform helpers) and its own `org-<uuid>` Neo4j databases with the S1-002 schema, all dropped in
// afterAll. Records are made with the merged S1-003 RecordsService from the app itself. The Desktop
// `neo4j` account only seeds bulk test data, reads the graph back and cleans up. Nothing shared is
// changed: no privilege, account or setting.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import { expect } from 'vitest';
import { LABELS, RECORD_PATHS, ROLES, type Label, type RecordKind, type Role } from '@grc/shared';
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
import { runOn, superDriver } from '../graph/helpers.js';
import { ThrowawayDatabases } from '../graph/throwaway-databases.js';
import {
  LogCapture,
  platformDb,
  startApi,
  type ApiApp,
  type InjectResponse,
  type PlatformDb,
} from '../platform/helpers.js';

export { LABELS, ROLES, RECORD_PATHS, json, show, type Label, type RecordKind, type Role, type InjectResponse };

export const LONG = 600_000;
export const T = 120_000;

export const KINDS: readonly RecordKind[] = ['asset', 'risk', 'control', 'policy', 'incident'];
export const LINKS = '/api/v1/links';

// ---------- the environment ----------

export interface LinksEnv {
  db: PlatformDb;
  app: ApiApp;
  k: Kit;
  sup: Driver;
  databases: ThrowawayDatabases;
  logs: LogCapture;
}

export async function setUpLinks(): Promise<LinksEnv> {
  const db = await platformDb();
  const logs = new LogCapture();
  let app: ApiApp;
  try {
    app = await startApi({ logStream: logs });
  } catch (err) {
    await db.drop();
    throw err;
  }
  const sup = superDriver();
  return { db, app, k: kit(db), sup, databases: new ThrowawayDatabases(sup), logs };
}

export async function tearDownLinks(env: LinksEnv | undefined): Promise<void> {
  if (!env) return;
  try {
    await env.databases.dropAll();
  } finally {
    await env.app.close().catch(() => undefined);
    await env.sup.close().catch(() => undefined);
    await closeKit(env.k).catch(() => undefined);
    await env.db.drop();
  }
}

interface GraphLike {
  createOrgDatabase(orgId: string): Promise<void>;
  write: unknown;
  readAs: (...args: unknown[]) => Promise<unknown>;
}

export async function appGraph(env: LinksEnv): Promise<GraphLike> {
  const { GRAPH } = await import('../../src/graph/graph.module.js');
  return env.app.get<GraphLike>(GRAPH);
}

/** An org: its Postgres row and audit partition, its Neo4j database and the S1-002 schema. */
export async function newLinksOrg(env: LinksEnv, name: string): Promise<Org> {
  const org = await seedOrg(env.k, name);
  const graph = await appGraph(env);
  env.databases.track(`org-${org.id}`);
  await graph.createOrgDatabase(org.id);
  const { ensureOrgSchema } = await import('../../src/graph/org-schema.js');
  await ensureOrgSchema(graph as never, org.id);
  return org;
}

export interface Person {
  id: string;
  role: Role;
  clearance: Label;
  org: Org;
  signedIn: SignedIn;
}

/** A member of `org` with this role and clearance, signed in with MFA checked. */
export async function person(env: LinksEnv, org: Org, role: Role, clearance: Label = 'restricted'): Promise<Person> {
  const signedIn = await mfaUser(env.k, env.app, org, { role, clearance });
  return { id: signedIn.user.id, role, clearance, org, signedIn };
}

// ---------- records (made by the merged S1-003 RecordsService, as the org's Admin) ----------

export interface Rec {
  id: string;
  number: string;
  name: string;
  kind: RecordKind;
  label: Label;
  owner: string;
  status: string;
  [field: string]: unknown;
}

interface RecordsServiceLike {
  create(caller: unknown, kind: RecordKind, input: unknown): Promise<Rec>;
}

let seq = 0;
export function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix} ${seq} ${randomUUID().slice(0, 8)}`;
}

function ownFields(kind: RecordKind): Record<string, unknown> {
  const own: Record<RecordKind, Record<string, unknown>> = {
    asset: { assetType: 'server', criticality: 'high', dataClassification: 'internal' },
    risk: { impact: 3, likelihood: 4, financialExposure: 250000 },
    control: { code: 'AC-2', framework: 'NIST 800-53', controlStatus: 'implemented', lastTestedDate: '2026-06-01' },
    policy: { policyVersion: '1.0', effectiveDate: '2026-01-01' },
    incident: { severity: 'high', incidentStatus: 'new', occurredAt: '2026-09-01T10:00:00Z' },
  };
  return own[kind];
}

/** A record in `org`, made by `admin` (an Admin person of that org). */
export async function makeRecord(
  env: LinksEnv,
  admin: Person,
  kind: RecordKind,
  opts: { label?: Label; owner?: string; extra?: Record<string, unknown> } = {},
): Promise<Rec> {
  const { RecordsService } = await import('../../src/records/records.service.js');
  const svc = env.app.get<RecordsServiceLike>(RecordsService);
  const caller = { orgId: admin.org.id, userId: admin.id, role: 'admin', clearance: 'restricted' };
  const input: Record<string, unknown> = {
    name: uniqueName(`${kind} record`),
    ...ownFields(kind),
    label: opts.label ?? 'internal',
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    ...(opts.extra ?? {}),
  };
  const out = await svc.create(caller, kind, input);
  return { ...out, kind };
}

// ---------- the routes ----------

export async function postLink(env: LinksEnv, who: Person, body: unknown): Promise<InjectResponse> {
  return call(env.app, who.signedIn.jar, { method: 'POST', url: LINKS, payload: body });
}

export function linksUrl(kind: RecordKind, id: string): string {
  return `/api/v1/${RECORD_PATHS[kind]}/${encodeURIComponent(id)}/links`;
}

export async function getLinks(env: LinksEnv, who: Person, kind: RecordKind, id: string): Promise<InjectResponse> {
  return call(env.app, who.signedIn.jar, { url: linksUrl(kind, id) });
}

export function mapUrl(id: string, depth?: string | number): string {
  const q = depth === undefined ? '' : `?depth=${encodeURIComponent(String(depth))}`;
  return `/api/v1/assets/${encodeURIComponent(id)}/map${q}`;
}

export async function getMap(env: LinksEnv, who: Person, id: string, depth?: string | number): Promise<InjectResponse> {
  return call(env.app, who.signedIn.jar, { url: mapUrl(id, depth) });
}

export interface LinkItem {
  type: string;
  direction: 'out' | 'in';
  other: { id: string; kind: string; number: string; name: string; label: string; status: string };
  origin: string;
  createdAt: string;
  createdBy: string;
}

export function linkItems(res: InjectResponse): LinkItem[] {
  expect(res.statusCode, show(res)).toBe(200);
  const body = json(res) as { items?: unknown };
  expect(Array.isArray(body.items), `{ items: [...] }: ${show(res)}`).toBe(true);
  return body.items as LinkItem[];
}

export interface MapNode {
  id: string;
  number: string;
  name: string;
  assetType: string;
  criticality: string;
  label: string;
}
export interface MapEdge {
  type: string;
  fromId: string;
  toId: string;
}
export interface MapBody {
  nodes: MapNode[];
  edges: MapEdge[];
  truncated: boolean;
}

export function mapBody(res: InjectResponse): MapBody {
  expect(res.statusCode, show(res)).toBe(200);
  const body = json(res) as Partial<MapBody>;
  expect(Array.isArray(body.nodes), `nodes: ${show(res)}`).toBe(true);
  expect(Array.isArray(body.edges), `edges: ${show(res)}`).toBe(true);
  expect(typeof body.truncated, `truncated: ${show(res)}`).toBe('boolean');
  return body as MapBody;
}

export function ids(list: { id: string }[]): string[] {
  return list.map((n) => n.id).sort();
}

export function edgeKeys(list: MapEdge[]): string[] {
  return list.map((e) => `${e.fromId} ${e.type} ${e.toId}`).sort();
}

export function edgeKey(from: { id: string }, type: string, to: { id: string }): string {
  return `${from.id} ${type} ${to.id}`;
}

/**
 * The status, after checking the answer came from a route that exists: Nest's own "Cannot GET …"
 * 404 for a missing route must never pass as the service's 404.
 */
export function answered(res: InjectResponse): number {
  const body = json(res) as { error?: { message?: unknown } };
  const message = typeof body.error?.message === 'string' ? body.error.message : '';
  expect(message, `the route exists: ${show(res)}`).not.toMatch(/^Cannot (GET|POST|PUT|PATCH|DELETE) /);
  return res.statusCode;
}

/** The D47 error body's code, after checking the status. */
export function refusal(res: InjectResponse, status: number): { code: string; message: string } {
  expect(answered(res), show(res)).toBe(status);
  const body = json(res) as { error?: { code?: unknown; message?: unknown; referenceId?: unknown } };
  expect(body.error, `the D47 error format: ${show(res)}`).toBeDefined();
  expect(typeof body.error?.referenceId).toBe('string');
  return { code: String(body.error?.code), message: String(body.error?.message) };
}

// ---------- the graph, read back and seeded by the Desktop account ----------

export interface StoredLink {
  type: string;
  props: Record<string, unknown>;
}

/** Every relationship from `fromId` to `toId` (either direction when `anyDirection`). */
export async function storedLinks(
  env: LinksEnv,
  orgId: string,
  fromId: string,
  toId: string,
  anyDirection = false,
): Promise<StoredLink[]> {
  const arrow = anyDirection ? '-' : '->';
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (a {id: $fromId})-[r]${arrow}(b {id: $toId}) RETURN type(r) AS type, properties(r) AS props`,
    { fromId, toId },
  );
  return found.map((r) => ({ type: String(r['type']), props: r['props'] as Record<string, unknown> }));
}

export async function relationshipCount(env: LinksEnv, orgId: string): Promise<number> {
  const found = await runOn(env.sup, `org-${orgId}`, 'MATCH ()-[r]->() RETURN count(r) AS n');
  return Number(found[0]?.['n'] ?? 0);
}

/** A link written straight into the org database (test data), shaped like a manual link. */
export async function linkDirect(
  env: LinksEnv,
  orgId: string,
  type: string,
  fromId: string,
  toId: string,
  createdBy = 'test-seed',
): Promise<void> {
  await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (a {id: $fromId}), (b {id: $toId})
     CREATE (a)-[:\`${type}\` {createdAt: $now, createdBy: $createdBy, origin: 'manual'}]->(b)`,
    { fromId, toId, now: new Date().toISOString(), createdBy },
  );
}

/**
 * `count` assets written straight into the org database (bulk test data for the D204 cap), each
 * with every D73 record property, numbered from `AST8<prefix>…` so they never clash with the
 * service's counter. Returns their IDs.
 */
export async function bulkAssets(
  env: LinksEnv,
  orgId: string,
  count: number,
  opts: { label?: Label; owner: string; numberPrefix: number },
): Promise<string[]> {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    number: `AST8${String(opts.numberPrefix).padStart(2, '0')}${String(i).padStart(4, '0')}`,
    name: `bulk asset ${opts.numberPrefix}-${i}`,
  }));
  await runOn(
    env.sup,
    `org-${orgId}`,
    `UNWIND $rows AS row
     CREATE (:Asset {id: row.id, number: row.number, sourceIds: [], name: row.name, sensitivity: $label,
       status: 'active', owner: $owner, version: 1, createdAt: $now, createdBy: $owner, updatedAt: $now,
       updatedBy: $owner, origin: 'manual', assetType: 'server', criticality: 'medium',
       dataClassification: $label})`,
    { rows, label: opts.label ?? 'internal', owner: opts.owner, now },
  );
  return rows.map((r) => r.id);
}

/** `centreId -[type]-> each of toIds`, written straight into the org database. */
export async function bulkLinks(
  env: LinksEnv,
  orgId: string,
  type: string,
  fromId: string,
  toIds: string[],
): Promise<void> {
  await runOn(
    env.sup,
    `org-${orgId}`,
    `MATCH (a {id: $fromId}) UNWIND $toIds AS toId MATCH (b {id: toId})
     CREATE (a)-[:\`${type}\` {createdAt: $now, createdBy: 'test-seed', origin: 'manual'}]->(b)`,
    { fromId, toIds, now: new Date().toISOString() },
  );
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

/** The audit entries waiting in the org's outbox (the in-process API runs no relay). */
export async function outboxEntries(env: LinksEnv, orgId: string, action?: string): Promise<OutboxEntry[]> {
  const found = await runOn(
    env.sup,
    `org-${orgId}`,
    'MATCH (o:AuditOutbox) RETURN o.payload AS payload ORDER BY o.seq',
  );
  const all = found.map((r) => JSON.parse(String(r['payload'])) as OutboxEntry);
  return action === undefined ? all : all.filter((e) => e.action === action);
}

// ---------- the D50 table, read straight from its cells (not through `can`) ----------

export type Cell = string;

export function cellOf(table: Record<string, Record<string, Cell>>, role: Role, kind: RecordKind): Cell {
  return table[kind]![role]!;
}

export function mayView(cell: Cell, owned: boolean): boolean {
  return cell === 'view' || cell === 'edit' || (cell === 'edit_own' && owned);
}

export function mayEdit(cell: Cell, owned: boolean): boolean {
  return cell === 'edit' || (cell === 'edit_own' && owned);
}

export function labelRank(label: Label): number {
  return LABELS.indexOf(label);
}

export function higherLabel(a: Label, b: Label): Label {
  return labelRank(a) >= labelRank(b) ? a : b;
}
