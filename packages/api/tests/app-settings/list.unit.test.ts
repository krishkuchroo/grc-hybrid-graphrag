// S1-013 criteria 1 and 2 (D210 (4), D57, D60, D132, D175): the one list of the app's settings.
//
// `APP_SETTINGS` in src/config/app-settings.ts lists every setting the API and worker read, and
// can't drift from the code: a scan of packages/api/src (skipping the list's own file) collects
// every name read as `process.env.NAME`, `env.NAME`, `process.env['NAME']` or `required('NAME')`,
// and the two sets must match both ways, like the security matrix (D175).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface AppSetting {
  name: string;
  required: boolean;
  macDefault?: string;
}

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const LIST_FILE = join('config', 'app-settings.ts');

async function loadList(): Promise<readonly AppSetting[]> {
  const mod = (await import('../../src/config/app-settings.js')) as { APP_SETTINGS?: readonly AppSetting[] };
  if (!Array.isArray(mod.APP_SETTINGS)) throw new Error('src/config/app-settings.ts must export APP_SETTINGS');
  return mod.APP_SETTINGS;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const NAME = '([A-Z][A-Z0-9_]*)';
const READ_PATTERNS = [
  new RegExp(`\\bprocess\\.env\\.${NAME}\\b`, 'g'),
  new RegExp(`\\bprocess\\.env\\[\\s*['"\`]${NAME}['"\`]\\s*\\]`, 'g'),
  new RegExp(`\\benv\\.${NAME}\\b`, 'g'),
  new RegExp(`\\brequired\\(\\s*['"\`]${NAME}['"\`]\\s*\\)`, 'g'),
];

/** Every setting name read in packages/api/src, with where it's read. */
function namesReadInSrc(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === LIST_FILE || rel.split(sep).join('/') === 'config/app-settings.ts') continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const pattern of READ_PATTERNS) {
        for (const m of line.matchAll(pattern)) {
          const where = `src/${rel.split(sep).join('/')}:${i + 1}`;
          found.set(m[1]!, [...(found.get(m[1]!) ?? []), where]);
        }
      }
    });
  }
  return found;
}

describe('APP_SETTINGS matches what packages/api/src reads (criterion 1)', () => {
  it('lists every name the code reads, and every listed name is read somewhere', async () => {
    const list = await loadList();
    const listed = new Set(list.map((s) => s.name));
    const read = namesReadInSrc();

    // The scan itself works: it sees each kind of read the brief names.
    expect(read.has('NEO4J_QUERY_SECRET'), 'scan finds env.NAME reads').toBe(true);
    expect(read.has('LOG_LEVEL'), 'scan finds process.env.NAME reads').toBe(true);
    expect(read.has('S3_ENDPOINT'), "scan finds required('NAME') reads").toBe(true);

    const missingFromList = [...read.keys()]
      .filter((n) => !listed.has(n))
      .sort()
      .map((n) => `${n} (read at ${read.get(n)!.join(', ')})`);
    const listedButNotRead = [...listed].filter((n) => !read.has(n)).sort();

    expect(missingFromList, 'read in packages/api/src but missing from APP_SETTINGS').toEqual([]);
    expect(listedButNotRead, 'in APP_SETTINGS but read nowhere in packages/api/src').toEqual([]);
  });

  it('names each setting once', async () => {
    const names = (await loadList()).map((s) => s.name);
    const repeated = names.filter((n, i) => names.indexOf(n) !== i);
    expect(repeated, 'names listed more than once').toEqual([]);
  });
});

describe('required, optional and Mac defaults (criterion 2)', () => {
  const EXPECTED: AppSetting[] = [
    { name: 'DATABASE_URL_APP', required: true },
    { name: 'NEO4J_ADMIN_PASSWORD', required: true },
    { name: 'NEO4J_WRITER_PASSWORD', required: true },
    { name: 'NEO4J_QUERY_SECRET', required: true },
    { name: 'S3_ACCESS_KEY', required: true },
    { name: 'S3_SECRET_KEY', required: true },
    { name: 'BETTER_AUTH_SECRET', required: true },
    { name: 'NEO4J_URI', required: true, macDefault: 'bolt://127.0.0.1:7687' },
    { name: 'S3_ENDPOINT', required: true, macDefault: 'http://127.0.0.1:8333' },
    { name: 'BETTER_AUTH_URL', required: false, macDefault: 'https://grc.localhost' },
    { name: 'HOST', required: false },
    { name: 'PORT', required: false },
    { name: 'LOG_LEVEL', required: false },
  ];

  it('has exactly the brief entries, each with its required flag and Mac default', async () => {
    const byName = (a: AppSetting, b: AppSetting) => a.name.localeCompare(b.name);
    const shape = (s: AppSetting): AppSetting =>
      s.macDefault === undefined
        ? { name: s.name, required: s.required }
        : { name: s.name, required: s.required, macDefault: s.macDefault };
    const actual = (await loadList()).map(shape).sort(byName);
    expect(actual).toEqual([...EXPECTED].sort(byName));
  });

  it.each([
    'NEO4J_QUERY_SECRET',
    'BETTER_AUTH_SECRET',
    'DATABASE_URL_APP',
    'NEO4J_ADMIN_PASSWORD',
    'NEO4J_WRITER_PASSWORD',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
  ])('%s is required, with no default', async (name) => {
    const entry = (await loadList()).find((s) => s.name === name);
    expect(entry, `${name} is in APP_SETTINGS`).toBeDefined();
    expect(entry!.required).toBe(true);
    expect(entry!.macDefault).toBeUndefined();
  });

  it.each(['HOST', 'PORT', 'LOG_LEVEL', 'BETTER_AUTH_URL'])('%s is optional', async (name) => {
    const entry = (await loadList()).find((s) => s.name === name);
    expect(entry, `${name} is in APP_SETTINGS`).toBeDefined();
    expect(entry!.required).toBe(false);
  });

  it.each(['DATABASE_URL_MIGRATE', 'POSTGRES_PASSWORD', 'OLLAMA_BASE_URL', 'DEMO_USER_PASSWORD'])(
    '%s is not in the list (D57: the apps never read it)',
    async (name) => {
      expect((await loadList()).map((s) => s.name)).not.toContain(name);
    },
  );
});
