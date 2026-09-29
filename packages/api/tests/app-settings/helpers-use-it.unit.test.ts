// S1-013 criterion 7 (D210 (4)): the test helpers get the app's settings from the one list.
//
// Reads packages/api/tests as text. Outside tests/platform/helpers.ts (whose `prepareEnv` puts
// `appTestEnv()` into the environment), no file assigns a process.env setting that APP_SETTINGS
// names, and no helper builds GraphService from `fullEnv()`: they use `appTestEnv()` instead.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM_HELPERS = 'platform/helpers.ts';

async function listedNames(): Promise<Set<string>> {
  const mod = (await import('../../src/config/app-settings.js')) as { APP_SETTINGS?: readonly { name: string }[] };
  if (!Array.isArray(mod.APP_SETTINGS)) throw new Error('src/config/app-settings.ts must export APP_SETTINGS');
  return new Set(mod.APP_SETTINGS.map((s) => s.name));
}

/** Every code file under packages/api/tests, as a path relative to it with `/` separators. */
function testFiles(dir = TESTS): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...testFiles(full));
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(relative(TESTS, full).split(sep).join('/'));
    }
  }
  return out;
}

// `process.env.NAME = …`, `||=`, `??=`, and the `process.env['NAME']` forms. `==`/`===` are reads.
const ASSIGN = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])\s*(\|\|=|\?\?=|=(?!=))/g;
const GRAPH_FROM_FULL_ENV = /\bgraphFromEnv\(\s*fullEnv\(\s*\)/g;

describe('test helpers take the app settings from APP_SETTINGS (criterion 7)', () => {
  it('no file but tests/platform/helpers.ts assigns a listed setting in process.env', async () => {
    const listed = await listedNames();
    const offenders: string[] = [];
    for (const rel of testFiles()) {
      if (rel === PLATFORM_HELPERS) continue;
      const lines = readFileSync(join(TESTS, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(ASSIGN)) {
          const name = m[1] ?? m[2]!;
          if (listed.has(name)) offenders.push(`tests/${rel}:${i + 1} sets ${name} (${m[3]})`);
        }
      });
    }
    expect(offenders, 'use prepareEnv / appTestEnv from tests/platform/helpers.ts instead').toEqual([]);
  });

  it('no test helper passes fullEnv() to graphFromEnv', async () => {
    await listedNames();
    const offenders: string[] = [];
    for (const rel of testFiles()) {
      const lines = readFileSync(join(TESTS, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.match(GRAPH_FROM_FULL_ENV)) offenders.push(`tests/${rel}:${i + 1}`);
      });
    }
    expect(offenders, 'build GraphService with graphFromEnv(appTestEnv())').toEqual([]);
  });

  it('tests/platform/helpers.ts exports appTestEnv, which gives the overrides and only listed names', async () => {
    const listed = await listedNames();
    const helpers = (await import('../platform/helpers.js')) as {
      appTestEnv?: (overrides?: Record<string, string>) => Record<string, string>;
    };
    expect(typeof helpers.appTestEnv, 'tests/platform/helpers.ts exports appTestEnv').toBe('function');
    const overrides: Record<string, string> = {
      DATABASE_URL_APP: 'app-url-override-o1',
      NEO4J_ADMIN_PASSWORD: 'o-admin',
      NEO4J_WRITER_PASSWORD: 'o-writer',
      NEO4J_QUERY_SECRET: 'o-query',
      S3_ACCESS_KEY: 'o-ak',
      S3_SECRET_KEY: 'o-sk',
      BETTER_AUTH_SECRET: 'o-auth',
      NEO4J_URI: 'bolt://o:1',
      S3_ENDPOINT: 'http://o:2',
    };
    const result = helpers.appTestEnv!(overrides);
    expect(
      Object.keys(result).filter((k) => !listed.has(k)),
      'names outside APP_SETTINGS',
    ).toEqual([]);
    for (const [k, v] of Object.entries(overrides)) expect(result[k], k).toBe(v);
  });
});
