// S1-014 criteria 2, 3 and 9 (D82, D171, D173, D176): every throwaway Neo4j database a test makes
// is tracked by the one ThrowawayDatabases tracker (tests/graph/throwaway-databases.ts), and no
// test swallows a failed drop.
//
// Reads every code file under packages/*/tests/ as text (full-line comments left out):
// - Criterion 2: no call to `dropDatabases(`, `removeOrgDatabases(`, `.dropAll(` and no
//   `DROP DATABASE` statement has `.catch(() => undefined)`, `.catch(() => {})` (or `null`,
//   `void 0`) on it, or sits right before an empty `catch {}`. The failure names file and line.
// - Criterion 3: a file that makes a Neo4j database itself (a `createOrgDatabase(` call or a
//   Cypher `CREATE DATABASE \`…\``) also calls `.track(`. A file that makes one through an org's
//   provisioning (`provisionOrg(`, or running `org:create` / `seed:demo`) calls `.track(` or
//   imports one of the TRACKING_HELPERS below. Each tracking helper must itself call `.track(`,
//   and every file that makes a tracker calls `.dropAll()`, itself or through a tracking helper.
// - Criterion 9: `retry: 0` stays in every package's vitest.config.ts, the tracker has no sleep,
//   timer or retry, and `ONLINE_WAIT_MS` stays 120_000.
//
// Not scanned: `tests/fixtures/` (test data) and this file (it names the patterns).
// MAKES_NO_DATABASE lists the files that name a create but never make a Neo4j database, each with
// the reason; a reviewer checks the list (D173 spirit: nothing hidden without a reason).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = 'api/tests/throwaway-databases/scan.unit.test.ts';

/** Helpers that make databases for the files that import them; each tracks and drops them. */
const TRACKING_HELPERS = [
  'api/tests/graph-accounts/helpers.ts',
  'api/tests/links/helpers.ts',
  'api/tests/outbox/helpers.ts',
  'api/tests/provision/helpers.ts',
  'api/tests/records-api/helpers.ts',
  'api/tests/records-service/helpers.ts',
];

/** Files that name a database create but never make a Neo4j database. */
const MAKES_NO_DATABASE: Record<string, string> = {
  'api/tests/graph/create-org-database.unit.test.ts':
    'unit test: neo4j-driver is mocked; the scripted system session never reaches a real Neo4j',
  'api/tests/graph/org-database-name.unit.test.ts':
    'unit test: a stub driver; a bad org ID is refused before any query is sent',
  'infra/tests/org-script-env/scripts-host-swap.stack.test.ts':
    'the scripts get a wrong Postgres password and are refused before anything is written',
};

/** Every code file under packages/<pkg>/tests/, as `<pkg>/tests/...` with `/` separators. */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'fixtures') walk(full);
      } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
        out.push(relative(PACKAGES, full).split(sep).join('/'));
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const tests = join(PACKAGES, pkg.name, 'tests');
    if (existsSync(tests)) walk(tests);
  }
  return out.filter((f) => f !== SELF).sort();
}

/** The file's lines with full-line comments blanked, so line numbers still match. */
function codeLines(rel: string): string[] {
  let inBlock = false;
  return readFileSync(join(PACKAGES, rel), 'utf8')
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        return '';
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true;
        return '';
      }
      if (t.startsWith('//')) return '';
      return line;
    });
}

const DROP = /\bdropDatabases\s*\(|\bremoveOrgDatabases\s*\(|\.dropAll\s*\(|DROP DATABASE/;
const SWALLOW = /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:undefined|null|void 0|\{\s*\})\s*\)/;
const EMPTY_CATCH = /^\s*\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/** The statement starting at line i: up to the first line ending in `;` (at most 12 lines). */
function statementEnd(lines: string[], i: number): number {
  for (let j = i; j < Math.min(lines.length, i + 12); j++) {
    if (/;\s*$/.test(lines[j]!)) return j;
  }
  return i;
}

function swallowedDrops(rel: string): string[] {
  const lines = codeLines(rel);
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (!DROP.test(line)) return;
    const end = statementEnd(lines, i);
    const statement = lines.slice(i, end + 1).join('\n');
    const after = lines
      .slice(end + 1, end + 8)
      .filter((l) => l.trim() !== '')
      .join('\n');
    if (SWALLOW.test(statement)) found.push(`${rel}:${i + 1} swallows a failed drop with .catch`);
    else if (EMPTY_CATCH.test(after)) found.push(`${rel}:${i + 1} swallows a failed drop with an empty catch`);
  });
  return found;
}

/** Makes a database itself: a createOrgDatabase call (not a type declaration) or Cypher CREATE DATABASE. */
const MAKES_DIRECTLY = [/\bcreateOrgDatabase\s*\((?!\s*\w+\s*:)/, /CREATE DATABASE\s+(?:IF NOT EXISTS\s+)?(?:\\?`|\$)/];
/** Makes one through provisioning an org (the org lands in the test's throwaway Postgres). */
const MAKES_THROUGH_AN_ORG = [/\bprovisionOrg\s*\(/, /['"`]org:create['"`]/, /['"`]seed:demo['"`]/];

function firstLine(rel: string, patterns: RegExp[]): number | undefined {
  const lines = codeLines(rel);
  const i = lines.findIndex((l) => patterns.some((re) => re.test(l)));
  return i < 0 ? undefined : i + 1;
}

function makesDatabase(rel: string): number | undefined {
  return firstLine(rel, [...MAKES_DIRECTLY, ...MAKES_THROUGH_AN_ORG]);
}

function tracks(rel: string): boolean {
  return /\.track\s*\(/.test(codeLines(rel).join('\n'));
}

/** Resolved `<pkg>/tests/...` paths of the file's relative imports. */
function relativeImports(rel: string): string[] {
  const text = codeLines(rel).join('\n');
  const out: string[] = [];
  for (const m of text.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(join(PACKAGES, rel)), m[1]!).replace(/\.js$/, '.ts');
    out.push(relative(PACKAGES, target).split(sep).join('/'));
  }
  return out;
}

describe('no test swallows a failed Neo4j database drop (criterion 2)', () => {
  it('finds the test files to scan', () => {
    const files = testFiles();
    expect(files).toContain('api/tests/records-service/helpers.ts');
    expect(files).toContain('infra/tests/graph-schema/graph-schema-script.db.test.ts');
  });

  it('no drop has .catch(() => undefined), .catch(() => {}) or an empty catch around it', () => {
    const offenders = testFiles().flatMap(swallowedDrops);
    expect(offenders, 'let the drop fail loudly: await tracker.dropAll() in a try … finally').toEqual([]);
  });
});

describe('every Neo4j database a test makes is tracked (criterion 3)', () => {
  it('each tracking helper tracks the databases it makes', () => {
    expect(TRACKING_HELPERS.filter((rel) => !tracks(rel))).toEqual([]);
  });

  it('every file that makes a tracker drops with dropAll(), itself or through a tracking helper that does', () => {
    const dropsAll = (rel: string): boolean => /\.dropAll\s*\(\s*\)/.test(codeLines(rel).join('\n'));
    const offenders = testFiles().filter(
      (rel) =>
        /\bnew ThrowawayDatabases\s*\(/.test(codeLines(rel).join('\n')) &&
        !dropsAll(rel) &&
        !relativeImports(rel).some((imp) => TRACKING_HELPERS.includes(imp) && dropsAll(imp)),
    );
    expect(offenders).toEqual([]);
  });

  it('every file that makes a database itself calls .track(', () => {
    const offenders: string[] = [];
    for (const rel of testFiles()) {
      if (rel in MAKES_NO_DATABASE) continue;
      const line = firstLine(rel, MAKES_DIRECTLY);
      if (line === undefined || tracks(rel)) continue;
      offenders.push(`${rel}:${line} makes a Neo4j database without ThrowawayDatabases.track`);
    }
    expect(offenders).toEqual([]);
  });

  it('every file that makes one through an org calls .track( or imports a tracking helper', () => {
    const offenders: string[] = [];
    for (const rel of testFiles()) {
      if (rel in MAKES_NO_DATABASE) continue;
      const line = firstLine(rel, MAKES_THROUGH_AN_ORG);
      if (line === undefined || tracks(rel)) continue;
      if (relativeImports(rel).some((imp) => TRACKING_HELPERS.includes(imp))) continue;
      offenders.push(`${rel}:${line} makes an org's Neo4j database without ThrowawayDatabases.track`);
    }
    expect(offenders).toEqual([]);
  });

  it('the files listed as making no database exist and still name a create (so the list stays honest)', () => {
    for (const rel of Object.keys(MAKES_NO_DATABASE)) {
      expect(existsSync(join(PACKAGES, rel)), rel).toBe(true);
      expect(makesDatabase(rel), rel).toBeDefined();
    }
  });

  it('the refusal checks in setup-neo4j.db.test.ts track the name before the create that must fail', () => {
    const lines = codeLines('api/tests/graph/setup-neo4j.db.test.ts');
    const creates = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /CREATE DATABASE\s+\\?`/.test(l) && /refused\(|\bawait runOn\(\s*(admin|writer)\b/.test(l));
    expect(creates.length).toBeGreaterThan(0);
    for (const { i } of creates) {
      const before = lines.slice(Math.max(0, i - 4), i).join('\n');
      expect(before, `setup-neo4j.db.test.ts:${i + 1}`).toMatch(/\.track\s*\(/);
    }
  });
});

describe('no retries, no longer waits (criterion 9)', () => {
  it('every vitest.config.ts keeps retry: 0', () => {
    const configs = readdirSync(PACKAGES)
      .map((pkg) => join(PACKAGES, pkg, 'vitest.config.ts'))
      .filter((f) => existsSync(f));
    expect(configs.length).toBeGreaterThan(0);
    for (const f of configs) expect(readFileSync(f, 'utf8'), f).toMatch(/\bretry:\s*0\b/);
  });

  it('the tracker has no sleep, timer or retry', () => {
    const text = codeLines('api/tests/graph/throwaway-databases.ts').join('\n');
    expect(text).not.toMatch(/setTimeout|setInterval|\bsleep\b|\bretry\b|\bretries\b/i);
  });

  it('ONLINE_WAIT_MS stays 120_000 in the GraphService', () => {
    const src = readFileSync(join(PACKAGES, 'api/src/graph/graph.service.ts'), 'utf8');
    expect(src).toMatch(/\bONLINE_WAIT_MS\s*=\s*120_000\b/);
  });
});
