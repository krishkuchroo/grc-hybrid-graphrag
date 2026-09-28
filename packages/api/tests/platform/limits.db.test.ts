// M0-007 criteria 3 and 4 (D64).
// 3. Bodies over 1 MB get 413 in the error format.
// 4. Request number 301 within one minute from one person (session user, else client IP) gets 429
//    with Retry-After and "try again in N s".
// Here nobody is signed in, so the person is the client IP. The routes answer 401 without a session
// (M0-010), which still counts. The per-user key is tested in tests/auth/rate-limit.db.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PREFIX,
  TEST_ROUTES,
  expectErrorFormat,
  platformDb,
  startApi,
  testModule,
  type ApiApp,
  type PlatformDb,
} from './helpers.js';
import { signedInApi } from '../auth/helpers.js';

let db: PlatformDb | undefined;
let app: ApiApp | undefined;
let session: Awaited<ReturnType<typeof signedInApi>> | undefined;

beforeAll(async () => {
  db = await platformDb();
  app = await startApi({ imports: [await testModule()] });
  session = await signedInApi(app, db);
}, 180_000);

afterAll(async () => {
  await session?.close();
  await app?.close();
  await db?.drop();
});

// Since M0-010 every route except /api/v1/auth/* and /api/v1/health needs a signed-in session
// with MFA checked, so these requests carry one (signedInApi from the auth helpers).
function api(): ApiApp {
  if (!session) throw new Error('the API app or its signed-in session did not start (see beforeAll)');
  return session.api;
}

// No session: the per-address counting for people who aren't signed in.
function anon(): ApiApp {
  if (!app) throw new Error('the API app did not start (see beforeAll)');
  return app;
}

function jsonOfSize(bytes: number): string {
  const wrapper = JSON.stringify({ blob: '' });
  return JSON.stringify({ blob: 'a'.repeat(bytes - wrapper.length) });
}

describe('criterion 3: 1 MB body cap', () => {
  it('accepts a JSON body just under 1 MB', async () => {
    const payload = jsonOfSize(1_000_000 - 1_000);
    const res = await api().inject({
      method: 'POST',
      url: `${TEST_ROUTES}/echo`,
      headers: { 'content-type': 'application/json' },
      payload,
      remoteAddress: '10.3.0.1',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ bytes: payload.length });
  });

  it('refuses a JSON body over 1 MB with 413 in the error format', async () => {
    const res = await api().inject({
      method: 'POST',
      url: `${TEST_ROUTES}/echo`,
      headers: { 'content-type': 'application/json' },
      payload: jsonOfSize(1_048_576 + 1_024),
      remoteAddress: '10.3.0.1',
    });
    expectErrorFormat(res, 413);
  });

  it('refuses a 2 MB body with 413 in the error format', async () => {
    const res = await api().inject({
      method: 'POST',
      url: `${TEST_ROUTES}/echo`,
      headers: { 'content-type': 'application/json' },
      payload: jsonOfSize(2 * 1_048_576),
      remoteAddress: '10.3.0.1',
    });
    expectErrorFormat(res, 413);
  });
});

describe('criterion 4: 300 requests per minute per person', () => {
  it('lets 300 requests through, refuses number 301 with 429, Retry-After and "try again in N s"', async () => {
    const ip = '10.4.0.1';
    for (let i = 1; i <= 300; i++) {
      const res = await anon().inject({ method: 'GET', url: `${TEST_ROUTES}/ok`, remoteAddress: ip });
      if (res.statusCode !== 401)
        throw new Error(`request ${i} got ${res.statusCode}, expected 401 (let through to the session check)`);
    }
    const res = await anon().inject({ method: 'GET', url: `${TEST_ROUTES}/ok`, remoteAddress: ip });
    const body = expectErrorFormat(res, 429);

    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter), `Retry-After header: ${String(res.headers['retry-after'])}`).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const m = /try again in (\d+) s/.exec(body.error.message);
    expect(m, `message: ${body.error.message}`).not.toBeNull();
    expect(Number(m![1])).toBe(retryAfter);
  });

  it('keeps refusing the same person for the rest of the minute', async () => {
    const res = await anon().inject({ method: 'GET', url: `${TEST_ROUTES}/ok`, remoteAddress: '10.4.0.1' });
    expectErrorFormat(res, 429);
  });

  it('counts each person separately: another client IP still gets through', async () => {
    const res = await anon().inject({ method: 'GET', url: `${TEST_ROUTES}/ok`, remoteAddress: '10.4.0.2' });
    expect(res.statusCode).toBe(401);
  });

  it('counts every route, not just one: the limited person is refused on /api/v1/health too', async () => {
    const res = await anon().inject({ method: 'GET', url: `${PREFIX}/health`, remoteAddress: '10.4.0.1' });
    expectErrorFormat(res, 429);
  });
});
