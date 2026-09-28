// M0-015 criterion 5 (the code side): every API call goes through the typed client generated
// from /api/v1/openapi.json (D30), made by the root script `gen:api-client`, with no host written
// into the web app.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = join(WEB, '../..');
const SRC = join(WEB, 'src');
const API_DIR = join(SRC, 'api');
const CLIENT = join(API_DIR, 'client.ts');

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// The screens this task adds; the scans below must cover them.
const SCREENS = [
  'src/features/auth/SignInPage.tsx',
  'src/features/auth/MfaSetupPage.tsx',
  'src/features/auth/MfaCheckPage.tsx',
  'src/app/AppShell.tsx',
  'src/app/HomePage.tsx',
  'src/router.tsx',
];

function scanned(): string[] {
  const files = filesUnder(SRC).map((path) => relative(WEB, path));
  expect(files).toEqual(expect.arrayContaining(SCREENS));
  return files.map((path) => join(WEB, path));
}

// The routes this task's screens call, as the API documents them (M0-010).
const ROUTES = [
  '/api/v1/me',
  '/api/v1/auth/sign-in/email',
  '/api/v1/auth/sign-out',
  '/api/v1/auth/two-factor/enable',
  '/api/v1/auth/two-factor/verify-totp',
  '/api/v1/auth/two-factor/verify-backup-code',
];

describe('the generated typed client (criterion 5)', () => {
  it('has a root gen:api-client script', () => {
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['gen:api-client']).toBeTruthy();
  });

  it('lives in src/api/client.ts and says it is generated', () => {
    expect(existsSync(CLIENT)).toBe(true);
    const head = read(CLIENT).split('\n').slice(0, 10).join('\n');
    expect(head).toMatch(/generated/i);
  });

  it.each(ROUTES)('knows the route %s from the OpenAPI spec', (route) => {
    const generated = filesUnder(API_DIR).map(read).join('\n');
    expect(generated).toContain(route);
  });

  it('is the only code that talks to the network', () => {
    const offenders = scanned()
      .filter((path) => !path.startsWith(API_DIR))
      .filter((path) => {
        const text = read(path);
        return (
          /\bfetch\s*\(/.test(text) ||
          /XMLHttpRequest|EventSource|WebSocket/.test(text) ||
          /from\s+['"](axios|ky|better-auth[^'"]*|@better-fetch\/[^'"]*)['"]/.test(text)
        );
      })
      .map((path) => relative(WEB, path));
    expect(offenders).toEqual([]);
  });

  it('writes no host into the web app: only relative /api/v1 addresses', () => {
    const withHost = scanned()
      .filter((path) => {
        const text = read(path).replace(/https?:\/\/www\.w3\.org\/[^\s'"`]*/g, '');
        return /https?:\/\/|\blocalhost\b|grc\.localhost|127\.0\.0\.1/.test(text);
      })
      .map((path) => relative(WEB, path));
    expect(withHost).toEqual([]);
  });
});
