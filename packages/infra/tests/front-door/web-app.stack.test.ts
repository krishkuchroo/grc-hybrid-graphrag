// M0-016 criterion 2 (D60): `/` serves the built web app (packages/web, `vite build`), and unknown
// non-API paths fall back to index.html so the app's own router can take them. /api/v1 paths never
// fall back: they belong to the API.
import { describe, expect, it } from 'vitest';
import { errorBody, https } from './helpers.js';

/** The module script Vite's build puts in index.html, for example /assets/index-AbC123.js. */
function builtScript(html: string): string | undefined {
  const m = /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html);
  return m?.[1];
}

describe('criterion 2: the web app at /', () => {
  it('/ answers 200 with HTML', async () => {
    const res = await https('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^text\/html/);
  });

  it("/ is the app's built index.html (the #root mount, the title), not the dev source", async () => {
    const { text } = await https('/');
    expect(text).toContain('<div id="root"></div>');
    expect(text).toContain('<title>GRC Workspace</title>');
    // The Vite dev entry is replaced by the built bundle.
    expect(text).not.toContain('/src/main.tsx');
    expect(builtScript(text)).toBeDefined();
  });

  it("the app's built script is served as JavaScript", async () => {
    const script = builtScript((await https('/')).text);
    expect(script, 'no /assets/*.js module script in index.html').toBeDefined();
    const res = await https(script!);
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^(text|application)\/javascript/);
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it.each(['/sign-in', '/mfa/setup', '/risks/RSK0001014', '/some/deep/link?x=1', '/index-of-nothing'])(
    'the unknown non-API path %s falls back to index.html',
    async (path) => {
      const root = await https('/');
      const res = await https(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type'] ?? '').toMatch(/^text\/html/);
      expect(res.text).toBe(root.text);
    },
  );

  it('an unknown /api/v1 path does not fall back to index.html: the API answers 404 in its error format', async () => {
    const res = await https('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
    expect(errorBody(res)?.code).toBe('not_found');
  });
});
