// Shared set-up for the M0-010 sign-in tests (D10, D49, D54, D56, D59, D64).
// The platform and access-guard tests use it too, because every route now needs a session.
//
// Contract these tests hold the builder to (TASKS.md, brief M0-010):
// - Better Auth runs inside the API program (`createApiApp` from src/main.api.ts), mounted at
//   `/api/v1/auth/*`, with email/password, the organization plugin and the 2FA plugin (TOTP plus
//   backup codes). The tests use Better Auth's own endpoints under that prefix:
//     POST /api/v1/auth/sign-in/email          { email, password }
//     POST /api/v1/auth/sign-out
//     POST /api/v1/auth/two-factor/enable      { password }  -> { totpURI, backupCodes }
//     POST /api/v1/auth/two-factor/verify-totp { code, trustDevice? }
//     POST /api/v1/auth/two-factor/verify-backup-code { code }
//     POST /api/v1/auth/two-factor/disable     { password }
//     POST /api/v1/auth/change-password        { currentPassword, newPassword }
//     POST /api/v1/auth/organization/set-active { organizationId }
//   A user with MFA on gets `twoFactorRedirect: true` from sign-in and no session until a TOTP or
//   backup code is checked. Sessions travel in cookies; the tests keep a small cookie jar.
// - The secret comes from `BETTER_AUTH_SECRET` and the address from `BETTER_AUTH_URL`; the trusted
//   origin is `https://grc.localhost` (D60). The platform helpers put both in the environment.
// - `src/identity/auth.ts` exports `hashPassword(plain: string): Promise<string>`: the same hash
//   Better Auth is set up with, so a user seeded with it can sign in. The tests seed users straight
//   into the throwaway database (as the superuser): a `user` row (email in lower case), a
//   `credential` `account` row holding the hash, and a `member` row with role and clearance.
// - Orgs are seeded the same way, with their audit partition made by `createAuditPartition`
//   (M0-012), so sign-in events have somewhere to go.
// - Every time check (session idle and max age, the lock) reads the JavaScript clock, so the tests
//   move time with Vitest's fake Date (`vi.setSystemTime`). Nothing reads Postgres `now()` for them.
// - `request.principal = { orgId, userId, role, clearance }` is set for a signed-in request with MFA
//   checked (the M0-008 contract). The probe controller below echoes it back.
import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Module, Post, Req } from '@nestjs/common';
import { expect, vi } from 'vitest';
import { API_DIR, closeDb, migrateUrl, rows, superUrl, type Db } from '../db/helpers.js';
import {
  LogCapture,
  platformDb,
  startApi,
  type ApiApp,
  type InjectOptions,
  type InjectResponse,
  type PlatformDb,
} from '../platform/helpers.js';

export const PREFIX = '/api/v1';
export const AUTH = `${PREFIX}/auth`;
export const ORIGIN = 'https://grc.localhost';
export const ME = `${PREFIX}/me`;
export const PROBE = `${PREFIX}/session-probe`;
// Traps for a sloppy path check: these look like the open paths but aren't.
export const AUTH_LOOKALIKE = `${PREFIX}/auth-probe`;
export const HEALTH_LOOKALIKE = `${PREFIX}/health-probe`;

export const ROLES = [
  'admin',
  'risk_manager',
  'compliance_manager',
  'control_owner',
  'auditor',
  'analyst',
  'viewer',
] as const;
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Role = (typeof ROLES)[number];
export type Label = (typeof LABELS)[number];

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

// ---------- the probe controllers: echo request.principal back ----------

type Principal = { orgId?: string; userId?: string; role?: string; clearance?: string } | undefined;

function principalOf(req: { principal?: Principal }): { principal: Principal | null } {
  const p = req.principal;
  return {
    principal: p ? { orgId: p.orgId, userId: p.userId, role: p.role, clearance: p.clearance } : null,
  };
}

function probeController(path: string): new () => object {
  class Probe {
    whoami(req: { principal?: Principal }): unknown {
      return principalOf(req);
    }
    whoamiPost(req: { principal?: Principal }): unknown {
      return principalOf(req);
    }
  }
  const proto = Probe.prototype;
  const desc = (name: 'whoami' | 'whoamiPost') => Object.getOwnPropertyDescriptor(proto, name)!;
  Controller(path)(Probe);
  Get('whoami')(proto, 'whoami', desc('whoami'));
  Req()(proto, 'whoami', 0);
  Post('whoami')(proto, 'whoamiPost', desc('whoamiPost'));
  Req()(proto, 'whoamiPost', 0);
  return Probe;
}

export function probeModule(): unknown {
  class SessionProbeModule {}
  Module({
    controllers: [probeController('session-probe'), probeController('auth-probe'), probeController('health-probe')],
  })(SessionProbeModule);
  return SessionProbeModule;
}

// ---------- seeding ----------

export interface Kit {
  db: PlatformDb;
  sup: Db; // superuser on the throwaway database: seeding and checking only
  migrator: Db; // grc_migrator: audit partitions (org provisioning runs as the operator)
  hashPassword: (plain: string) => Promise<string>;
}

async function loadHashPassword(): Promise<(plain: string) => Promise<string>> {
  const file = join(API_DIR, 'src', 'identity', 'auth.ts');
  if (!existsSync(file)) throw new Error('src/identity/auth.ts does not exist yet (it must export hashPassword)');
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  if (typeof mod.hashPassword !== 'function') throw new Error('src/identity/auth.ts must export hashPassword');
  return mod.hashPassword as (plain: string) => Promise<string>;
}

async function loadCreateAuditPartition(): Promise<(db: Db, orgId: string) => Promise<void>> {
  const mod = (await import('../../src/audit/audit.service.js')) as unknown as Record<string, unknown>;
  if (typeof mod.createAuditPartition !== 'function') {
    throw new Error('src/audit/audit.service.ts must export createAuditPartition');
  }
  return mod.createAuditPartition as (db: Db, orgId: string) => Promise<void>;
}

export function kit(db: PlatformDb): Kit {
  const sup = db.loaded.createDb(superUrl(db.name), { max: 2 });
  const migrator = db.loaded.createDb(migrateUrl(db.name), { max: 1 });
  return {
    db,
    sup,
    migrator,
    hashPassword: async (plain) => (await loadHashPassword())(plain),
  };
}

export async function closeKit(k: Kit | undefined): Promise<void> {
  if (!k) return;
  await closeDb(k.sup);
  await closeDb(k.migrator);
}

export async function q<T = Record<string, unknown>>(k: Kit, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await k.sup.$client.query(text, params);
  return res.rows as T[];
}

export interface Org {
  id: string;
  name: string;
}

let seq = 0;
function next(): number {
  seq += 1;
  return seq;
}

export async function seedOrg(k: Kit, name: string): Promise<Org> {
  const id = randomUUID();
  await q(k, `INSERT INTO "organization" (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
    id,
    name,
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 8)}`,
  ]);
  await (
    await loadCreateAuditPartition()
  )(k.migrator, id);
  return { id, name };
}

export interface User {
  id: string;
  email: string; // as stored: lower case
  name: string;
  password: string;
  org: Org;
  role: Role;
  clearance: Label;
}

export function strongPassword(tag = ''): string {
  return `Pw-${tag}-${randomUUID().slice(0, 12)}!`;
}

export async function seedUser(
  k: Kit,
  org: Org,
  opts: { role?: Role; clearance?: Label; password?: string; email?: string; name?: string } = {},
): Promise<User> {
  const n = next();
  const id = randomUUID();
  const email = (opts.email ?? `user${n}.${id.slice(0, 6)}@x.test`).toLowerCase();
  const name = opts.name ?? `Test User ${n}`;
  const password = opts.password ?? strongPassword(String(n));
  const role = opts.role ?? 'viewer';
  const clearance = opts.clearance ?? 'internal';
  const hash = await k.hashPassword(password);
  await q(
    k,
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, true, now(), now())`,
    [id, name, email],
  );
  await q(
    k,
    `INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
     VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
    [randomUUID(), id, hash],
  );
  await q(
    k,
    `INSERT INTO "member" (id, org_id, user_id, role, clearance, created_at) VALUES ($1, $2, $3, $4, $5, now())`,
    [randomUUID(), org.id, id, role, clearance],
  );
  return { id, email, name, password, org, role, clearance };
}

// ---------- one API app per test file ----------

export interface AuthEnv {
  db: PlatformDb;
  app: ApiApp;
  k: Kit;
  logs: LogCapture;
}

// A throwaway database, the API app with the probe controllers, and the seeding kit.
export async function setUpAuth(): Promise<AuthEnv> {
  const db = await platformDb();
  const logs = new LogCapture();
  let app: ApiApp;
  try {
    app = await startApi({ imports: [probeModule()], logStream: logs });
  } catch (err) {
    await db.drop();
    throw err;
  }
  return { db, app, k: kit(db), logs };
}

export async function tearDownAuth(env: AuthEnv | undefined): Promise<void> {
  if (!env) return;
  await env.app.close();
  await closeKit(env.k);
  await env.db.drop();
}

// ---------- requests with a cookie jar ----------

export class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(res: InjectResponse): void {
    const raw = res.headers['set-cookie'];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('=');
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v] = a.split('=').map((s) => s.trim());
        if (k?.toLowerCase() === 'max-age') return Number(v) <= 0;
        if (k?.toLowerCase() === 'expires') return new Date(v ?? '').getTime() <= Date.now();
        return false;
      });
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clone(): Jar {
    const j = new Jar();
    for (const [k, v] of this.cookies) j.cookies.set(k, v);
    return j;
  }

  get size(): number {
    return this.cookies.size;
  }
}

export interface CallOptions {
  method?: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
}

// One request through the API, with the browser's origin and the jar's cookies. New cookies go
// back into the jar.
export async function call(app: ApiApp, jar: Jar | undefined, opts: CallOptions): Promise<InjectResponse> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(opts.headers ?? {}) };
  const cookie = jar?.header();
  if (cookie) headers.cookie = cookie;
  const req: InjectOptions = { method: opts.method ?? 'GET', url: opts.url, headers };
  if (opts.payload !== undefined) {
    headers['content-type'] ??= 'application/json';
    req.payload = typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload);
  }
  if (opts.remoteAddress) req.remoteAddress = opts.remoteAddress;
  const res = await app.inject(req);
  jar?.absorb(res);
  return res;
}

// An ApiApp whose every request carries the jar's cookies (used by the platform tests).
export function withSession(app: ApiApp, jar: Jar): ApiApp {
  return {
    inject: async (opts: InjectOptions) => {
      const headers: Record<string, string> = { origin: ORIGIN, ...(opts.headers ?? {}), cookie: jar.header() };
      const res = await app.inject({ ...opts, headers });
      jar.absorb(res);
      return res;
    },
    get: <T>(token: unknown) => app.get<T>(token),
    close: () => app.close(),
  };
}

export function json(res: InjectResponse): Record<string, unknown> {
  try {
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// The error code of a response: ours (D47, `error.code`) or Better Auth's (`code`).
export function errorCode(res: InjectResponse): string | undefined {
  const body = json(res);
  const inner = body.error as { code?: unknown } | undefined;
  if (inner && typeof inner === 'object' && typeof inner.code === 'string') return inner.code;
  return typeof body.code === 'string' ? body.code : undefined;
}

export function show(res: InjectResponse): string {
  return `${res.statusCode} ${res.body.slice(0, 300)}`;
}

// ---------- TOTP (RFC 6238), computed here from the enrolment secret ----------

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface Totp {
  secret: Buffer;
  digits: number;
  period: number;
}

export function totpFromUri(uri: string): Totp {
  const url = new URL(uri);
  expect(url.protocol, `TOTP URI: ${uri}`).toBe('otpauth:');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error(`TOTP URI has no secret: ${uri}`);
  return {
    secret: base32Decode(secret),
    digits: Number(url.searchParams.get('digits') ?? 6),
    period: Number(url.searchParams.get('period') ?? 30),
  };
}

export function hotp(t: Totp, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', t.secret).update(buf).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** t.digits).padStart(t.digits, '0');
}

export function totpNow(t: Totp): string {
  return hotp(t, Math.floor(Date.now() / (t.period * 1000)));
}

// A code that is wrong for the current time (outside the ±1 step window).
export function wrongCode(t: Totp): string {
  const c = Math.floor(Date.now() / (t.period * 1000));
  const near = new Set([hotp(t, c - 1), hotp(t, c), hotp(t, c + 1)]);
  for (let i = 0; ; i++) {
    const candidate = String((123456 + i * 111111) % 10 ** t.digits).padStart(t.digits, '0');
    if (!near.has(candidate)) return candidate;
  }
}

// ---------- sign-in flows ----------

export interface Mfa {
  totp: Totp;
  backupCodes: string[];
}

export async function signInPassword(
  app: ApiApp,
  jar: Jar,
  email: string,
  password: string,
  remoteAddress?: string,
): Promise<InjectResponse> {
  return call(app, jar, {
    method: 'POST',
    url: `${AUTH}/sign-in/email`,
    payload: { email, password },
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

export function wantsSecondFactor(res: InjectResponse): boolean {
  return res.statusCode === 200 && json(res).twoFactorRedirect === true;
}

// Signs in a user without MFA yet, then enrols TOTP. Returns the jar (now holding an MFA-checked
// session) and the enrolment secret.
export async function enrol(app: ApiApp, user: User): Promise<{ jar: Jar; mfa: Mfa }> {
  const jar = new Jar();
  const signIn = await signInPassword(app, jar, user.email, user.password);
  if (signIn.statusCode !== 200) throw new Error(`sign-in for enrolment failed: ${show(signIn)}`);
  const enable = await call(app, jar, {
    method: 'POST',
    url: `${AUTH}/two-factor/enable`,
    payload: { password: user.password },
  });
  if (enable.statusCode !== 200) throw new Error(`two-factor/enable failed: ${show(enable)}`);
  const body = json(enable) as { totpURI?: string; backupCodes?: string[] };
  if (!body.totpURI) throw new Error(`two-factor/enable returned no totpURI: ${show(enable)}`);
  const totp = totpFromUri(body.totpURI);
  const verify = await call(app, jar, {
    method: 'POST',
    url: `${AUTH}/two-factor/verify-totp`,
    payload: { code: totpNow(totp) },
  });
  if (verify.statusCode !== 200) throw new Error(`two-factor/verify-totp (enrolment) failed: ${show(verify)}`);
  return { jar, mfa: { totp, backupCodes: body.backupCodes ?? [] } };
}

// A full sign-in of an enrolled user: password, then a TOTP code. Returns a fresh jar.
export async function signInFull(app: ApiApp, user: User, mfa: Mfa, remoteAddress?: string): Promise<Jar> {
  const jar = new Jar();
  const first = await signInPassword(app, jar, user.email, user.password, remoteAddress);
  if (!wantsSecondFactor(first)) throw new Error(`expected twoFactorRedirect from sign-in, got ${show(first)}`);
  const second = await call(app, jar, {
    method: 'POST',
    url: `${AUTH}/two-factor/verify-totp`,
    payload: { code: totpNow(mfa.totp) },
    ...(remoteAddress ? { remoteAddress } : {}),
  });
  if (second.statusCode !== 200) throw new Error(`verify-totp at sign-in failed: ${show(second)}`);
  return jar;
}

export interface SignedIn {
  user: User;
  jar: Jar;
  mfa: Mfa;
}

// Seeds a user in `org` and returns them signed in with MFA checked.
export async function mfaUser(
  k: Kit,
  app: ApiApp,
  org: Org,
  opts: Parameters<typeof seedUser>[2] = {},
): Promise<SignedIn> {
  const user = await seedUser(k, org, opts);
  const { jar, mfa } = await enrol(app, user);
  return { user, jar, mfa };
}

// ---------- audit events, read by the superuser ----------

export interface AuditRow {
  seq: number;
  action: string;
  actor_type: string;
  actor_id: string;
  text: string; // the whole row as JSON text
}

export async function auditOf(k: Kit, orgId: string): Promise<AuditRow[]> {
  return q<AuditRow>(
    k,
    `SELECT seq::int AS seq, action, actor_type, actor_id, row_to_json(a)::text AS text
     FROM audit_events a WHERE org_id = $1 ORDER BY seq`,
    [orgId],
  );
}

export async function allAuditText(k: Kit): Promise<string> {
  const found = await q<{ t: string | null }>(
    k,
    `SELECT string_agg(row_to_json(a)::text, '\n') AS t FROM audit_events a`,
  );
  return found[0]?.t ?? '';
}

export function actions(list: AuditRow[]): string[] {
  return list.map((e) => e.action);
}

// The audit events added to `orgId` while `fn` runs.
export async function auditDuring(k: Kit, orgId: string, fn: () => Promise<unknown>): Promise<AuditRow[]> {
  const before = await auditOf(k, orgId);
  const last = before.length ? before[before.length - 1]!.seq : 0;
  await fn();
  return (await auditOf(k, orgId)).filter((e) => e.seq > last);
}

// ---------- the fake clock ----------

export function freezeClock(at = Date.now()): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

export function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

export function realClock(): void {
  vi.useRealTimers();
}

export { rows };

// For tests of other tasks whose routes now sit behind the SessionGuard: an org, an admin
// with MFA checked, and the app wrapped so every request carries that session.
export async function signedInApi(
  app: ApiApp,
  db: PlatformDb,
): Promise<{ api: ApiApp; user: User; close: () => Promise<void> }> {
  const k = kit(db);
  try {
    const org = await seedOrg(k, 'Platform Org');
    const { user, jar } = await mfaUser(k, app, org, { role: 'admin', clearance: 'restricted' });
    return { api: withSession(app, jar), user, close: () => closeKit(k) };
  } catch (err) {
    await closeKit(k);
    throw err;
  }
}
