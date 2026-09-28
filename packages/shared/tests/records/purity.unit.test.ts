// S1-001 criterion 6 (D45.2, D183): the record model is pure shared code. Nothing in
// src/records/ imports from the API or the web app, or touches the network, the filesystem or the
// environment. It may import other shared code (for example ../access/) and zod (D30).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORDS_DIR, SHARED_DIR } from './load.js';

const REQUIRED_FILES = ['types.ts', 'schemas.ts', 'values.ts', 'numbers.ts', 'rating.ts', 'links.ts', 'index.ts'];
const SRC_DIR = join(SHARED_DIR, 'src');

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
    /\bimport\s*['"]([^'"]+)['"]/g,
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

describe('criterion 6: src/records/ is pure shared code', () => {
  it.each(REQUIRED_FILES)('src/records/%s exists', (file) => {
    expect(existsSync(join(RECORDS_DIR, file)), `src/records/${file} does not exist yet`).toBe(true);
  });

  it('imports only shared code and zod', () => {
    const files = sourceFiles(RECORDS_DIR);
    expect(files.length, 'src/records/ has no source files yet').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const where = relative(SHARED_DIR, file);
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (relative(SRC_DIR, target).startsWith('..')) bad.push(`${where}: ${spec} (outside packages/shared/src)`);
        } else if (spec !== 'zod' && !spec.startsWith('zod/')) {
          bad.push(`${where}: ${spec}`);
        }
      }
    }
    expect(bad, `forbidden imports:\n${bad.join('\n')}`).toEqual([]);
  });

  it('never reads the environment or uses the network, storage or computed imports', () => {
    const files = sourceFiles(RECORDS_DIR);
    expect(files.length, 'src/records/ has no source files yet').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      for (const [what, pattern] of FORBIDDEN_CODE) {
        if (pattern.test(code)) bad.push(`${relative(SHARED_DIR, file)}: ${what}`);
      }
    }
    expect(bad, `forbidden uses:\n${bad.join('\n')}`).toEqual([]);
  });
});
