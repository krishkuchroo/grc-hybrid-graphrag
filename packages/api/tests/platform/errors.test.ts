// M0-007 criteria 1 and 2, plus the error format for validation errors (D47, brief "Interfaces").
// 1. Every route is under /api/v1. Anything else returns 404 in the error format.
// 2. Unexpected errors return 500 in the error format, with no stack trace in the body.
// The referenceId of an error also appears in the pino log line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LogCapture,
  PREFIX,
  SECRET_DETAIL,
  TEST_ROUTES,
  expectErrorFormat,
  platformDb,
  startApi,
  testModule,
  type ApiApp,
  type PlatformDb,
} from './helpers.js';

let db: PlatformDb | undefined;
let app: ApiApp | undefined;
const logs = new LogCapture();

beforeAll(async () => {
  db = await platformDb();
  app = await startApi({ imports: [await testModule()], logStream: logs });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

function api(): ApiApp {
  if (!app) throw new Error('the API app did not start (see beforeAll)');
  return app;
}

describe('criterion 1: every route is under /api/v1', () => {
  it('serves the health route at /api/v1/health', async () => {
    const res = await api().inject({ method: 'GET', url: `${PREFIX}/health` });
    expect(res.statusCode).toBe(200);
  });

  it('serves a module controller under the prefix', async () => {
    const res = await api().inject({ method: 'GET', url: `${TEST_ROUTES}/ok` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it.each(['/health', '/platform-test/ok', '/', '/api/health', '/api/v2/health', '/v1/health'])(
    'returns 404 in the error format for %s',
    async (url) => {
      expectErrorFormat(await api().inject({ method: 'GET', url }), 404);
    },
  );

  it('returns 404 in the error format for an unknown /api/v1 route', async () => {
    expectErrorFormat(await api().inject({ method: 'GET', url: `${PREFIX}/no-such-route` }), 404);
  });

  it('gives each error its own reference ID', async () => {
    const a = expectErrorFormat(await api().inject({ method: 'GET', url: `${PREFIX}/nope-a` }), 404);
    const b = expectErrorFormat(await api().inject({ method: 'GET', url: `${PREFIX}/nope-b` }), 404);
    expect(a.error.referenceId).not.toBe(b.error.referenceId);
  });
});

describe('criterion 2: unexpected errors', () => {
  it('returns 500 in the error format', async () => {
    expectErrorFormat(await api().inject({ method: 'GET', url: `${TEST_ROUTES}/boom` }), 500);
  });

  it('puts no stack trace in the body', async () => {
    const res = await api().inject({ method: 'GET', url: `${TEST_ROUTES}/boom` });
    expectErrorFormat(res, 500);
    expect(res.body).not.toMatch(/\n\s+at\s/);
    expect(res.body).not.toMatch(/\\n\s+at\s/);
    expect(res.body).not.toMatch(/\.(ts|js|mjs):\d+/);
    expect(res.body).not.toContain('"stack"');
  });

  it('writes the reference ID into the pino log line for the error', async () => {
    const res = await api().inject({ method: 'GET', url: `${TEST_ROUTES}/boom` });
    const { error } = expectErrorFormat(res, 500);
    const matching = logs.lines.filter((line) => line.includes(error.referenceId));
    expect(matching.length, 'log lines carrying the reference ID').toBeGreaterThan(0);
    // pino writes JSON lines.
    for (const line of matching) expect(() => JSON.parse(line)).not.toThrow();
    // The log (not the response) is where the detail goes.
    expect(matching.some((line) => line.includes(SECRET_DETAIL))).toBe(true);
  });
});

describe('validation errors use the same format', () => {
  it('returns 400 in the error format when a Zod schema refuses the input', async () => {
    expectErrorFormat(await api().inject({ method: 'GET', url: `${TEST_ROUTES}/page?page=0` }), 400);
  });

  it('returns 400 in the error format for a malformed JSON body', async () => {
    const res = await api().inject({
      method: 'POST',
      url: `${TEST_ROUTES}/echo`,
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expectErrorFormat(res, 400);
  });

  it('parses a valid page query through the same route', async () => {
    const res = await api().inject({ method: 'GET', url: `${TEST_ROUTES}/page?page=2&pageSize=10` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 2, pageSize: 10 });
  });
});
