// M0-008 criterion 5 (D50, D59): the guard refuses a request the table refuses, and lets through
// one it allows. Every guarded route is tried by all 7 roles. A refusal is 403 in the M0-007 error
// format, and the handler never runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LogCapture,
  expectErrorFormat,
  platformDb,
  startApi,
  type ApiApp,
  type PlatformDb,
} from '../platform/helpers.js';
import { signedInApi } from '../auth/helpers.js';
import { GUARDED, ROLES, ROUTES, accessGuardTestModule, calls } from './helpers.js';

let db: PlatformDb | undefined;
let app: ApiApp | undefined;
let session: Awaited<ReturnType<typeof signedInApi>> | undefined;
let setupError: unknown;

beforeAll(async () => {
  db = await platformDb();
  try {
    app = await startApi({ imports: [await accessGuardTestModule()], logStream: new LogCapture() });
    session = await signedInApi(app, db);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  await session?.close();
  await app?.close();
  await db?.drop();
});

function api(): ApiApp {
  if (!session) throw new Error(`the API app or its signed-in session did not start: ${String(setupError)}`);
  return session.api;
}

const CASES = GUARDED.flatMap((route) =>
  ROLES.map((role) => ({ ...route, role, allowed: route.allowed.includes(role) })),
);

describe('criterion 5: the guard follows the D50 table', () => {
  it.each(CASES)('$method $path ($subject/$action) as $role -> allowed: $allowed', async (c) => {
    const label = `${c.method} ${c.path}`;
    const before = calls.get(label) ?? 0;
    const res = await api().inject({
      method: c.method,
      url: `${ROUTES}/${c.path}`,
      headers: { 'x-test-role': c.role, 'content-type': 'application/json' },
      ...(c.method === 'POST' ? { payload: '{}' } : {}),
    });
    if (c.allowed) {
      expect(res.statusCode, res.body.slice(0, 300)).toBeLessThan(300);
      expect(res.json()).toEqual({ ok: true, route: label });
      expect(calls.get(label)).toBe(before + 1);
    } else {
      const body = expectErrorFormat(res, 403);
      expect(body.error.code).toBe('forbidden');
      expect(calls.get(label) ?? 0, 'the handler must not run').toBe(before);
    }
  });
});

describe('criterion 5: the guard fails safe', () => {
  it('refuses a request with no principal', async () => {
    const res = await api().inject({
      method: 'POST',
      url: `${ROUTES}/chat`,
      headers: { 'x-test-principal': 'none' },
      payload: {},
    });
    const body = expectErrorFormat(res, 403);
    expect(body.error.code).toBe('forbidden');
  });

  it.each(['superuser', '', 'Admin', '__proto__'])('refuses an unknown role %j', async (role) => {
    const res = await api().inject({
      method: 'POST',
      url: `${ROUTES}/chat`,
      headers: { 'x-test-role': role },
      payload: {},
    });
    const body = expectErrorFormat(res, 403);
    expect(body.error.code).toBe('forbidden');
  });

  it('refuses a control owner editing controls at route level (ownership is unknown there)', async () => {
    const res = await api().inject({
      method: 'POST',
      url: `${ROUTES}/controls`,
      headers: { 'x-test-role': 'control_owner' },
      payload: {},
    });
    expectErrorFormat(res, 403);
  });
});

describe('with the SessionGuard in front (M0-010)', () => {
  it('a request with no session never reaches the handler: 401', async () => {
    if (!app) throw new Error(`the API app did not start: ${String(setupError)}`);
    const before = calls.get('POST chat') ?? 0;
    const res = await app.inject({
      method: 'POST',
      url: `${ROUTES}/chat`,
      headers: { 'x-test-role': 'admin', 'content-type': 'application/json' },
      payload: '{}',
    });
    expectErrorFormat(res, 401);
    expect(calls.get('POST chat') ?? 0).toBe(before);
  });

  it("the signed-in admin's own principal passes an admin-only route", async () => {
    const res = await api().inject({ method: 'POST', url: `${ROUTES}/users`, payload: {} });
    expect(res.statusCode, res.body.slice(0, 300)).toBeLessThan(300);
  });
});
