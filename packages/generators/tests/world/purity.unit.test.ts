// S3-016 criterion 6: nothing in packages/generators/src/world/ touches the network, the filesystem
// or the environment. It imports only its own folder, @grc/shared (the record model) and
// @faker-js/faker (D33). The same check as S1-001's packages/shared/tests/records/purity.unit.test.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GENERATORS_DIR, WORLD_DIR, loadWorld } from './load.js';

const REQUIRED_FILES = ['sizes.ts', 'build-world.ts', 'names.ts', 'answer-key.ts', 'index.ts'];
const ALLOWED_PACKAGES = ['@grc/shared', '@faker-js/faker'];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module specifier: static imports and re-exports, side-effect imports, import() and require(). */
function specifiers(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    // A side-effect import only at the start of a statement, so a string value such as 'import' is not read as one.
    /(?:^|[;{}])\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const FORBIDDEN_CODE: [string, RegExp][] = [
  ['process (the environment)', /\bprocess\s*[.[]/],
  ['import.meta.env', /import\.meta\.env/],
  ['a dynamic import with a computed name', /\bimport\s*\(\s*[^'"`\s)]/],
  ['require with a computed name', /\brequire\s*\(\s*[^'"`\s)]/],
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['localStorage or sessionStorage', /\b(localStorage|sessionStorage)\b/],
  ['Deno or Bun', /\b(Deno|Bun)\s*\./],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('criterion 6: src/world/ touches no network, filesystem or environment', () => {
  it.each(REQUIRED_FILES)('src/world/%s exists', (file) => {
    expect(existsSync(join(WORLD_DIR, file)), `src/world/${file} does not exist yet`).toBe(true);
  });

  it('imports only its own folder, @grc/shared and @faker-js/faker', () => {
    const files = sourceFiles(WORLD_DIR);
    expect(files.length, 'src/world/ has no source files yet').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const file of files) {
      const where = relative(GENERATORS_DIR, file);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (relative(WORLD_DIR, target).startsWith('..')) bad.push(`${where}: ${spec} (outside src/world)`);
        } else if (!ALLOWED_PACKAGES.some((name) => spec === name || spec.startsWith(`${name}/`))) {
          bad.push(`${where}: ${spec}`);
        }
      }
    }
    expect(bad, `forbidden imports:\n${bad.join('\n')}`).toEqual([]);
  });

  it('never reads the environment or uses the network, storage or computed imports', () => {
    const files = sourceFiles(WORLD_DIR);
    expect(files.length, 'src/world/ has no source files yet').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      for (const [what, pattern] of FORBIDDEN_CODE) {
        if (pattern.test(code)) bad.push(`${relative(GENERATORS_DIR, file)}: ${what}`);
      }
    }
    expect(bad, `forbidden uses:\n${bad.join('\n')}`).toEqual([]);
  });

  it('building a world makes no network call', async () => {
    const { buildWorld, SIZES } = await loadWorld();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    buildWorld({ seed: 3, size: SIZES.tiny });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
