// Shared set-up for the M0-011 machine API key tests (D11, D54, D56, D59).
//
// Contract these tests hold the builder to (TASKS.md, brief M0-011):
// - `POST /api/v1/api-keys` with `{ name, role, expiresAt }` (expiresAt an ISO date-time) creates a
//   key in the caller's org and answers 201 `{ id, key }`. `key` is the plain key, `grc_` followed
//   by at least 32 URL-safe characters, and it appears in this response only.
// - `GET /api/v1/api-keys` lists the org's keys, paged like every list (`{ items, page, pageSize,
//   total }`, `?page=&pageSize=`, src/common/paging.ts). Each item carries at least
//   `{ id, name, role, expiresAt }`, and never the key or its hash.
// - `DELETE /api/v1/api-keys/:id` revokes a key of the caller's org (200 or 204). A key ID that
//   isn't in the caller's org, or doesn't exist, gets 404: another org's keys are never revealed.
// - Only a signed-in Admin of the org (session with MFA checked) may use these three routes. Other
//   roles get 403 in the one error format (D47).
// - A request with `Authorization: Bearer grc_<…>` runs as the key's org and role with clearance
//   `internal`: `request.principal = { orgId, role, clearance: 'internal', … }`, so the M0-008
//   `@Requires` + `AccessGuard` limit it by the D50 table. The org comes from the key only, never
//   from a header, the body or the query.
// - An unknown, malformed, expired or revoked key gets 401 in the one error format, on the very next
//   request (no cache). Expiry reads the JavaScript clock, so the tests move time with Vitest's
//   fake Date (`vi.setSystemTime`), as in M0-010.
// - The stored value is a hash: no table holds the plain key, or its hex or base64 form. The key
//   row lives in an org table (M0-009 rule: `org_id uuid not null`, RLS enabled and forced).
// - Audit events (through `AuditService.append`, M0-012), in the key's org:
//     `api_key.created`  actor_type `user`, actor_id the Admin, target_type `api_key`, target_id the key ID
//     `api_key.revoked`  actor_type `user`, actor_id the Admin, target_type `api_key`, target_id the key ID
//     `api_key.refused`  actor_type `api_key`, actor_id the key ID: one per refused use of an
//                        expired or revoked key.
//   A key that matches nothing belongs to no org: it goes to the API's own log, never to an org chain.
//   No audit event and no log line ever holds the plain key.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Body, Controller, Get, Module, Post, Req, UseGuards } from '@nestjs/common';
import pg from 'pg';
import { expect } from 'vitest';
import { API_DIR, appUrl } from '../db/helpers.js';
import { GUARDED } from '../access-guard/helpers.js';
import {
  call,
  closeKit,
  json,
  kit,
  mfaUser,
  probeModule,
  q,
  show,
  type Kit,
  type Org,
  type Role,
  type SignedIn,
} from '../auth/helpers.js';
import {
  LogCapture,
  platformDb,
  startApi,
  type ApiApp,
  type InjectResponse,
  type PlatformDb,
} from '../platform/helpers.js';

export const KEYS = '/api/v1/api-keys';
export const KEY_PROBE = '/api/v1/key-probe';
export const KEY_PATTERN = /^grc_[A-Za-z0-9_-]{32,}$/;
export const DAY = 24 * 60 * 60 * 1000;

export { GUARDED };

// ---------- a probe controller: echoes the principal, plus the D50-guarded routes ----------

type Principal = Record<string, unknown> | undefined;

// Handler runs per guarded route, keyed by "METHOD path".
export const guardedCalls = new Map<string, number>();

async function loadExport(rel: string, name: string): Promise<unknown> {
  const file = join(API_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  if (typeof mod[name] !== 'function') throw new Error(`${rel} must export ${name}`);
  return mod[name];
}

type MethodDecoratorFn = (target: object, key: string | symbol, desc: PropertyDescriptor) => void;

export async function keyProbeModule(): Promise<unknown> {
  const Requires = (await loadExport('src/access/requires.decorator.ts', 'Requires')) as (
    subject: string,
    action: string,
  ) => MethodDecoratorFn;
  const AccessGuard = (await loadExport('src/access/access.guard.ts', 'AccessGuard')) as new (
    ...args: never[]
  ) => object;

  class KeyProbe {
    whoami(req: { principal?: Principal }): unknown {
      return { principal: req.principal ?? null };
    }
    whoamiPost(req: { principal?: Principal }, body: unknown): unknown {
      void body;
      return { principal: req.principal ?? null };
    }
  }
  const p = KeyProbe.prototype;
  const d = (name: 'whoami' | 'whoamiPost') => Object.getOwnPropertyDescriptor(p, name)!;
  Get('whoami')(p, 'whoami', d('whoami'));
  Req()(p, 'whoami', 0);
  Post('whoami')(p, 'whoamiPost', d('whoamiPost'));
  Req()(p, 'whoamiPost', 0);
  Body()(p, 'whoamiPost', 1);
  Controller('key-probe')(KeyProbe);

  class KeyGuarded {}
  const gp = KeyGuarded.prototype as unknown as Record<string, () => unknown>;
  for (const route of GUARDED) {
    const key = `${route.method}_${route.path}`.replace(/[^A-Za-z0-9_]/g, '_');
    const label = `${route.method} ${route.path}`;
    gp[key] = () => {
      guardedCalls.set(label, (guardedCalls.get(label) ?? 0) + 1);
      return { ok: true, route: label };
    };
    const desc = Object.getOwnPropertyDescriptor(gp, key)!;
    (route.method === 'GET' ? Get : Post)(route.path)(gp, key, desc);
    Requires(route.subject, route.action)(gp, key, desc);
  }
  UseGuards(AccessGuard)(KeyGuarded);
  Controller('key-probe/guarded')(KeyGuarded);

  class KeyProbeModule {}
  Module({ controllers: [KeyProbe, KeyGuarded] })(KeyProbeModule);
  return KeyProbeModule;
}

// ---------- one API app per test file ----------

export interface KeyEnv {
  db: PlatformDb;
  app: ApiApp;
  k: Kit;
  logs: LogCapture;
}

export async function setUpKeys(): Promise<KeyEnv> {
  const db = await platformDb();
  const logs = new LogCapture();
  let app: ApiApp;
  try {
    app = await startApi({ imports: [probeModule(), await keyProbeModule()], logStream: logs });
  } catch (err) {
    await db.drop();
    throw err;
  }
  return { db, app, k: kit(db), logs };
}

export async function tearDownKeys(env: KeyEnv | undefined): Promise<void> {
  if (!env) return;
  await env.app.close();
  await closeKit(env.k);
  await env.db.drop();
}

// ---------- key management through the API ----------

export function inDays(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString();
}

export interface CreateBody {
  name?: unknown;
  role?: unknown;
  expiresAt?: unknown;
}

export async function createKeyRaw(app: ApiApp, admin: SignedIn, body: CreateBody): Promise<InjectResponse> {
  return call(app, admin.jar, { method: 'POST', url: KEYS, payload: body });
}

export interface NewKey {
  id: string;
  key: string;
  role: Role;
  orgId: string;
  name: string;
  expiresAt: string;
  remoteAddress: string;
}

let addr = 0;
// Each key gets its own client address, so the per-person limit (D64) never mixes the keys' requests.
function nextAddress(): string {
  addr += 1;
  return `10.11.${Math.floor(addr / 250) % 250}.${(addr % 250) + 1}`;
}

export async function createKey(
  app: ApiApp,
  admin: SignedIn,
  opts: { role?: Role; name?: string; expiresAt?: string } = {},
): Promise<NewKey> {
  const name = opts.name ?? `machine-${randomUUID().slice(0, 8)}`;
  const role = opts.role ?? 'viewer';
  const expiresAt = opts.expiresAt ?? inDays(30);
  const res = await createKeyRaw(app, admin, { name, role, expiresAt });
  if (res.statusCode !== 201) throw new Error(`POST ${KEYS} failed: ${show(res)}`);
  const body = json(res) as { id?: unknown; key?: unknown };
  if (typeof body.id !== 'string' || typeof body.key !== 'string') {
    throw new Error(`POST ${KEYS} must return { id, key }: ${show(res)}`);
  }
  return { id: body.id, key: body.key, role, orgId: admin.user.org.id, name, expiresAt, remoteAddress: nextAddress() };
}

export async function listKeys(app: ApiApp, admin: SignedIn, query = ''): Promise<InjectResponse> {
  return call(app, admin.jar, { url: `${KEYS}${query}` });
}

export async function revokeKey(app: ApiApp, admin: SignedIn, id: string): Promise<InjectResponse> {
  return call(app, admin.jar, { method: 'DELETE', url: `${KEYS}/${encodeURIComponent(id)}` });
}

export async function mustRevoke(app: ApiApp, admin: SignedIn, id: string): Promise<void> {
  const res = await revokeKey(app, admin, id);
  expect([200, 204], show(res)).toContain(res.statusCode);
}

export async function admin(k: Kit, app: ApiApp, org: Org): Promise<SignedIn> {
  return mfaUser(k, app, org, { role: 'admin', clearance: 'restricted' });
}

// ---------- using a key ----------

export function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

export async function useKey(
  app: ApiApp,
  key: NewKey | string,
  opts: { method?: string; url?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<InjectResponse> {
  const plain = typeof key === 'string' ? key : key.key;
  const remote = typeof key === 'string' ? nextAddress() : key.remoteAddress;
  return call(app, undefined, {
    method: opts.method ?? 'GET',
    url: opts.url ?? `${KEY_PROBE}/whoami`,
    headers: { ...(opts.headers ?? {}), ...bearer(plain) },
    remoteAddress: remote,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

export function principalOf(res: InjectResponse): Record<string, unknown> | null {
  return (json(res).principal ?? null) as Record<string, unknown> | null;
}

// ---------- reading the database as the superuser ----------

// Every row of every table in every schema we own (public, pgboss, …), as JSON text, with the
// table's name (schema-qualified outside public).
export async function everyRow(k: Kit): Promise<{ table: string; text: string }[]> {
  const tables = await q<{ schema: string; name: string }>(
    k,
    `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
  );
  const out: { table: string; text: string }[] = [];
  for (const { schema, name } of tables) {
    const found = await q<{ t: string }>(k, `SELECT row_to_json(x)::text AS t FROM "${schema}"."${name}" x`);
    const table = schema === 'public' ? name : `${schema}.${name}`;
    for (const r of found) out.push({ table, text: r.t });
  }
  return out;
}

// The tables whose rows mention `id` (the key's own row, plus audit events about it).
export async function tablesHolding(k: Kit, id: string): Promise<string[]> {
  const found = (await everyRow(k)).filter((r) => r.text.includes(id)).map((r) => r.table);
  return [...new Set(found)];
}

// The key's own row: the non-audit table row that carries its ID.
export async function keyRow(k: Kit, id: string): Promise<{ table: string; row: Record<string, unknown> }> {
  const found = (await everyRow(k)).filter((r) => r.table !== 'audit_events' && r.text.includes(id));
  expect(found.length, `exactly one stored row for key ${id}: ${found.map((f) => f.table).join(', ')}`).toBe(1);
  return { table: found[0]!.table, row: JSON.parse(found[0]!.text) as Record<string, unknown> };
}

// The rows of `table` that grc_app sees in `orgId`'s context (RLS applies).
export async function appSeesIn(db: PlatformDb, table: string, orgId: string): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: appUrl(db.name) });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const res = await client.query(`SELECT * FROM public."${table}"`);
    await client.query('COMMIT');
    return res.rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

// ---------- audit ----------

export const KEY_ACTIONS = ['api_key.created', 'api_key.revoked', 'api_key.refused'];

export interface KeyAuditRow {
  seq: number;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string | null;
  target_id: string | null;
  text: string;
}

export async function keyAuditOf(k: Kit, orgId: string): Promise<KeyAuditRow[]> {
  return q<KeyAuditRow>(
    k,
    `SELECT seq::int AS seq, action, actor_type, actor_id, target_type, target_id, row_to_json(a)::text AS text
     FROM audit_events a WHERE org_id = $1 ORDER BY seq`,
    [orgId],
  );
}

export async function keyAuditDuring(k: Kit, orgId: string, fn: () => Promise<unknown>): Promise<KeyAuditRow[]> {
  const before = await keyAuditOf(k, orgId);
  const last = before.length ? before[before.length - 1]!.seq : 0;
  await fn();
  return (await keyAuditOf(k, orgId)).filter((e) => e.seq > last);
}

export function onlyKeyEvents(list: KeyAuditRow[]): KeyAuditRow[] {
  return list.filter((e) => KEY_ACTIONS.includes(e.action));
}

// The key's secret part and the encodings of the whole key that must never be stored.
export function forbiddenForms(key: string): string[] {
  const secret = key.replace(/^grc_/, '');
  const bytes = Buffer.from(key, 'utf8');
  return [
    key,
    secret,
    bytes.toString('hex'),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    Buffer.from(secret, 'utf8').toString('hex'),
    Buffer.from(secret, 'utf8').toString('base64'),
  ];
}

// Any 12-character slice of the secret part.
export function secretSlices(key: string, width = 12): string[] {
  const secret = key.replace(/^grc_/, '');
  const out: string[] = [];
  for (let i = 0; i + width <= secret.length; i += 4) out.push(secret.slice(i, i + width));
  return out;
}
