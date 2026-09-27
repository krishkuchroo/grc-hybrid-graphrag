// M0-007 criterion 5 (D64): every response carries X-Frame-Options: DENY, Strict-Transport-Security,
// X-Content-Type-Options: nosniff, Referrer-Policy and a strict Content-Security-Policy.
// "Every response" is checked on successes and on each kind of error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PREFIX,
  TEST_ROUTES,
  platformDb,
  startApi,
  testModule,
  type ApiApp,
  type InjectOptions,
  type InjectResponse,
  type PlatformDb,
} from './helpers.js';

let db: PlatformDb | undefined;
let app: ApiApp | undefined;

beforeAll(async () => {
  db = await platformDb();
  app = await startApi({ imports: [await testModule()] });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

function api(): ApiApp {
  if (!app) throw new Error('the API app did not start (see beforeAll)');
  return app;
}

function header(res: InjectResponse, name: string): string {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v);
}

const SAFE_REFERRER = ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'];

function expectSecurityHeaders(res: InjectResponse): void {
  expect(header(res, 'X-Frame-Options').toUpperCase()).toBe('DENY');

  const hsts = header(res, 'Strict-Transport-Security');
  const maxAge = /max-age=(\d+)/i.exec(hsts);
  expect(maxAge, `Strict-Transport-Security: "${hsts}"`).not.toBeNull();
  expect(Number(maxAge![1])).toBeGreaterThanOrEqual(31_536_000);

  expect(header(res, 'X-Content-Type-Options').toLowerCase()).toBe('nosniff');

  const referrer = header(res, 'Referrer-Policy').toLowerCase();
  const policies = referrer.split(',').map((p) => p.trim());
  expect(policies.length).toBeGreaterThan(0);
  for (const p of policies) expect(SAFE_REFERRER, `Referrer-Policy: "${referrer}"`).toContain(p);

  const csp = header(res, 'Content-Security-Policy');
  expect(csp, 'Content-Security-Policy').not.toBe('');
  const directives = new Map(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name!.toLowerCase(), values] as const;
      }),
  );
  const defaultSrc = directives.get('default-src');
  expect(defaultSrc, `CSP needs default-src: "${csp}"`).toBeDefined();
  expect(
    defaultSrc!.every((v) => v === "'none'" || v === "'self'"),
    `default-src: ${defaultSrc!.join(' ')}`,
  ).toBe(true);
  expect(directives.get('frame-ancestors'), `CSP needs frame-ancestors 'none': "${csp}"`).toEqual(["'none'"]);
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  for (const [name, values] of directives) {
    expect(values, `CSP ${name} must not allow everything`).not.toContain('*');
  }
}

const cases: Array<[string, InjectOptions]> = [
  ['a 200 from the health route', { method: 'GET', url: `${PREFIX}/health` }],
  ['a 200 from a module route', { method: 'GET', url: `${TEST_ROUTES}/ok` }],
  ['the OpenAPI document', { method: 'GET', url: `${PREFIX}/openapi.json` }],
  ['a 404 inside /api/v1', { method: 'GET', url: `${PREFIX}/no-such-route` }],
  ['a 404 outside /api/v1', { method: 'GET', url: '/somewhere-else' }],
  ['a 500', { method: 'GET', url: `${TEST_ROUTES}/boom` }],
  ['a 400', { method: 'GET', url: `${TEST_ROUTES}/page?page=0` }],
  [
    'a 413',
    {
      method: 'POST',
      url: `${TEST_ROUTES}/echo`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'a'.repeat(1_100_000) }),
    },
  ],
];

describe('criterion 5: security headers on every response', () => {
  it.each(cases)('on %s', async (_name, opts) => {
    expectSecurityHeaders(await api().inject(opts));
  });

  it('on a 429', async () => {
    const ip = '10.5.0.1';
    let last: InjectResponse | undefined;
    for (let i = 0; i < 301; i++) {
      last = await api().inject({ method: 'GET', url: `${TEST_ROUTES}/ok`, remoteAddress: ip });
    }
    expect(last!.statusCode).toBe(429);
    expectSecurityHeaders(last!);
  });
});
