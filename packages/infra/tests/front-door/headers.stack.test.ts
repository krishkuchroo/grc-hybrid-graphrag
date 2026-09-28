// M0-016 criterion 4 (D64): the security headers are on every response through the front door,
// the web app's included: no framing, HTTPS only, strict content rules.
//
// Each header must be sent exactly once. The API already sets its own (M0-007), so a door that adds
// a second copy on /api/v1 answers would send two policies; browsers then apply both, and a
// duplicated X-Frame-Options is ignored outright.
import { describe, expect, it } from 'vitest';
import { MB, UPLOAD_CAP_BYTES, headerCount, https, type Reply } from './helpers.js';

const ONE_YEAR_S = 31_536_000;

/** CSP directives as name -> source list. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

function expectD64Headers(res: Reply, what: string): void {
  for (const name of [
    'strict-transport-security',
    'x-frame-options',
    'x-content-type-options',
    'content-security-policy',
  ]) {
    expect(headerCount(res, name), `${what}: ${name} sent ${headerCount(res, name)} times`).toBe(1);
  }

  // HTTPS only: HSTS for at least a year.
  const hsts = String(res.headers['strict-transport-security']);
  const maxAge = /max-age=(\d+)/i.exec(hsts);
  expect(maxAge, `${what}: HSTS without max-age: ${hsts}`).not.toBeNull();
  expect(Number(maxAge![1]), `${what}: HSTS max-age`).toBeGreaterThanOrEqual(ONE_YEAR_S);

  // No framing, both the old and the CSP way.
  expect(String(res.headers['x-frame-options']).toUpperCase(), what).toBe('DENY');
  const csp = directives(String(res.headers['content-security-policy']));
  expect(csp.get('frame-ancestors'), `${what}: frame-ancestors`).toEqual(["'none'"]);

  // Strict content rules: no sniffing; a default source; scripts only from known places, with no
  // inline or eval'd code and no wildcard.
  expect(String(res.headers['x-content-type-options']).toLowerCase(), what).toBe('nosniff');
  expect(csp.has('default-src'), `${what}: CSP has no default-src`).toBe(true);
  const scriptSources = csp.get('script-src') ?? csp.get('default-src') ?? [];
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'http:', 'https:', 'data:']) {
    expect(scriptSources, `${what}: script sources allow ${bad}`).not.toContain(bad);
  }
  for (const [name, sources] of csp) {
    expect(sources, `${what}: ${name} allows any origin`).not.toContain('*');
  }
  const objects = csp.get('object-src') ?? csp.get('default-src') ?? [];
  expect(objects, `${what}: plugins (object-src) must be off`).toEqual(["'none'"]);
}

describe('criterion 4: the D64 security headers on every response', () => {
  it('the web app at /', async () => {
    expectD64Headers(await https('/'), 'GET /');
  });

  it("the web app's built script", async () => {
    const html = (await https('/')).text;
    const src = /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(src, 'no /assets/*.js script in index.html').toBeDefined();
    expectD64Headers(await https(src!), `GET ${src}`);
  });

  it('an app route served by the index.html fallback', async () => {
    expectD64Headers(await https('/risks/RSK0001014'), 'GET /risks/RSK0001014');
  });

  it('GET /api/v1/health', async () => {
    expectD64Headers(await https('/api/v1/health'), 'GET /api/v1/health');
  });

  it("the API's 404 for an unknown /api/v1 route", async () => {
    expectD64Headers(await https('/api/v1/no-such-route'), 'GET /api/v1/no-such-route');
  });

  it("the API's 401 without a session", async () => {
    expectD64Headers(await https('/api/v1/me'), 'GET /api/v1/me');
  });

  it("the API's 413 for a 2 MB body", async () => {
    const res = await https('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyBytes: 2 * MB,
    });
    expect(res.status).toBe(413);
    expectD64Headers(res, 'POST 2 MB to /api/v1/auth/sign-in/email');
  });

  it("the door's own 413 for an upload over 25 MB", async () => {
    // The door refuses by the declared size and closes. With the body already streaming, our write
    // error (EPIPE) could beat the 413 and lose the answer (the race TEST-006 fixed in
    // body-size.stack.test.ts, D171). So declare the size and wait to be asked for the body
    // (Expect: 100-continue): the door answers before any of it is sent. A door that let the
    // upload through would ask for the body, get all of it, and not answer with its own 413.
    const res = await https('/api/v1/intake/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      bodyBytes: UPLOAD_CAP_BYTES + 1,
      timeoutMs: 60_000,
      expectContinue: true,
    });
    expect(res.status).toBe(413);
    expectD64Headers(res, 'POST 25 MB + 1 byte');
  });
});
