// S2-001 criteria 1 and 8 (D20, D67, D45.2, D183): the four frameworks, their groups, the mapping
// link types, the package entry point, and that src/frameworks/ is pure shared code.
//
// Reading the tests rely on: criterion 1 counts "17 SOC 2 series" but lists CC1-CC9, A1, C1, PI1 and
// P1-P8, which is 20. The tests hold the listed series (the shared notes' table and the 61 criteria
// CC1.1 to P8.1 need all 20); the count in the brief is an arithmetic slip.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUPS, KEYS, NAMED_GROUPS, PUBLISHED_GROUP_NAMES, TABLE } from './expected.js';
import { EXPORTS, FRAMEWORKS_DIR, SHARED_DIR, loadFrameworks, loadShared } from './load.js';

describe('criterion 1: FRAMEWORK_KEYS and isFrameworkKey', () => {
  it('FRAMEWORK_KEYS is exactly the four keys, in the plan order', async () => {
    const { FRAMEWORK_KEYS } = await loadFrameworks();
    expect([...FRAMEWORK_KEYS]).toEqual([...KEYS]);
  });

  it.each(KEYS)('isFrameworkKey(%s) is true', async (key) => {
    const { isFrameworkKey } = await loadFrameworks();
    expect(isFrameworkKey(key)).toBe(true);
  });

  it.each([
    'scf',
    'NIST_800_53',
    'nist-800-53',
    'nist 800-53',
    'iso_27002',
    'soc_1',
    '',
    ' soc_2',
    null,
    undefined,
    1,
    {},
    'toString',
    '__proto__',
  ])('isFrameworkKey(%j) is false', async (value) => {
    const { isFrameworkKey } = await loadFrameworks();
    expect(isFrameworkKey(value)).toBe(false);
  });
});

describe('criterion 1: FRAMEWORKS', () => {
  it('holds exactly the four frameworks', async () => {
    const { FRAMEWORKS } = await loadFrameworks();
    expect(Object.keys(FRAMEWORKS).sort()).toEqual([...KEYS].sort());
  });

  it.each(KEYS)('%s has the name, version and publisher in the shared notes table', async (key) => {
    const { FRAMEWORKS } = await loadFrameworks();
    const { name, frameworkVersion, publisher } = FRAMEWORKS[key]!;
    expect({ name, frameworkVersion, publisher }).toEqual(TABLE[key]);
  });

  it.each(KEYS)('%s has a description', async (key) => {
    const { FRAMEWORKS } = await loadFrameworks();
    const { description } = FRAMEWORKS[key]!;
    expect(typeof description).toBe('string');
    expect(description.trim().length).toBeGreaterThan(0);
  });

  it.each(KEYS)('%s groupNames covers exactly its groups, each with a name', async (key) => {
    const { FRAMEWORKS } = await loadFrameworks();
    const { groupNames } = FRAMEWORKS[key]!;
    expect(Object.keys(groupNames).sort()).toEqual([...GROUPS[key]].sort());
    for (const [code, name] of Object.entries(groupNames)) {
      expect(typeof name, `${key} ${code}`).toBe('string');
      expect(name.trim().length, `${key} ${code} has an empty name`).toBeGreaterThan(0);
    }
  });

  it('has 20 families, 22 CSF categories, 4 ISO themes and the 20 listed SOC 2 series', async () => {
    const { FRAMEWORKS } = await loadFrameworks();
    const counts = Object.fromEntries(KEYS.map((key) => [key, Object.keys(FRAMEWORKS[key]!.groupNames).length]));
    expect(counts).toEqual({ nist_800_53: 20, nist_csf_2: 22, iso_27001: 4, soc_2: 20 });
  });

  it.each(NAMED_GROUPS)('%s group %s is named %s', async (key, code, name) => {
    const { FRAMEWORKS } = await loadFrameworks();
    expect(FRAMEWORKS[key]!.groupNames[code]).toBe(name);
  });

  it.each(
    Object.entries(PUBLISHED_GROUP_NAMES).flatMap(([key, names]) =>
      Object.entries(names).map(([code, name]) => [key, code, name] as const),
    ),
  )('%s group %s carries its published name, %s', async (key, code, name) => {
    const { FRAMEWORKS } = await loadFrameworks();
    expect(FRAMEWORKS[key]!.groupNames[code]).toBe(name);
  });
});

describe('MAPPING_LINK_TYPES (D67)', () => {
  it('is SATISFIES from a control to a requirement and MAPS_TO from a requirement to a requirement', async () => {
    const { MAPPING_LINK_TYPES } = await loadFrameworks();
    expect(MAPPING_LINK_TYPES.map(({ type, from, to }) => ({ type, from, to }))).toEqual([
      { type: 'SATISFIES', from: 'control', to: 'requirement' },
      { type: 'MAPS_TO', from: 'requirement', to: 'requirement' },
    ]);
  });
});

describe('the package entry point', () => {
  it('src/index.ts re-exports the framework model', async () => {
    const shared = await loadShared();
    const direct = await loadFrameworks();
    for (const name of EXPORTS) {
      expect(shared[name], `src/index.ts must re-export ${name}`).toBe(direct[name]);
    }
  });
});

// Criterion 8: nothing in src/frameworks/ imports from the API or the web app, or touches the
// network, the filesystem or the environment. It may import other shared code, zod (D30) and Node's
// crypto (for the UUID v5s, as the brief names).
const REQUIRED_FILES = ['frameworks.ts', 'codes.ts', 'schemas.ts', 'numbers.ts', 'mapping-rules.ts', 'index.ts'];
const SRC_DIR = join(SHARED_DIR, 'src');
const ALLOWED_PACKAGES = new Set(['zod', 'node:crypto', 'crypto']);

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

describe('criterion 8: src/frameworks/ is pure shared code', () => {
  it.each(REQUIRED_FILES)('src/frameworks/%s exists', (file) => {
    expect(existsSync(join(FRAMEWORKS_DIR, file)), `src/frameworks/${file} does not exist yet`).toBe(true);
  });

  it('imports only shared code, zod and Node crypto', () => {
    const files = sourceFiles(FRAMEWORKS_DIR);
    expect(files.length, 'src/frameworks/ has no source files yet').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const where = relative(SHARED_DIR, file);
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (relative(SRC_DIR, target).startsWith('..')) bad.push(`${where}: ${spec} (outside packages/shared/src)`);
        } else if (!ALLOWED_PACKAGES.has(spec) && !spec.startsWith('zod/')) {
          bad.push(`${where}: ${spec}`);
        }
      }
    }
    expect(bad, `forbidden imports:\n${bad.join('\n')}`).toEqual([]);
  });

  it('never reads the environment or uses the network, storage or computed imports', () => {
    const files = sourceFiles(FRAMEWORKS_DIR);
    expect(files.length, 'src/frameworks/ has no source files yet').toBeGreaterThan(0);
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
