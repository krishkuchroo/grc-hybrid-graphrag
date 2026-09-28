// TEST-001: every test file says what it needs to run, each kind has its own command, and
// nothing retries a failed test.
// Decisions: D177 (names and commands), D171 (`retries: 0`; a test that fails then passes is a
// bug), D180 (db and stack runs call the `pnpm test:env` doctor first), D82 (one test process per
// run), D173 (skipped tests count as failures), D179 (TEST-001 merges after TEST-002's doctor).
//
// The kinds (D177):
//   *.unit.test.ts(x)   needs nothing
//   *.db.test.ts(x)     needs Postgres, Neo4j or SeaweedFS
//   *.stack.test.ts(x)  needs the running stack (containers, Caddy, the API)
//   e2e/*.e2e.ts        browser tests, packages/web/e2e only
//
// Two sorts of check:
// 1. Static: the files under packages/*, the package.json scripts, the Vitest configs and the
//    Playwright config, read from this checkout.
// 2. Behaviour, in a throwaway pnpm workspace ("sandbox") made under node_modules/.cache (so the
//    real node_modules resolve and every repo tool already ignores it). The sandbox holds one
//    probe package whose package.json scripts and vitest.* files are copied from packages/infra
//    (every package has the same test scripts, checked below), a root package.json copied from
//    this one, and a stand-in doctor: the root `test:env` script is replaced by a small script
//    that notes it ran and exits 0 or 1 as the test asks. So "db and stack stop when the doctor
//    fails" is proved without touching the real doctor, the stack or any database (D176).
//    Other top-level files and the real packages are linked in, so a script that calls a helper
//    by a relative path still finds it. Only the probe is a workspace member.
//    Each probe test file appends "<kind>:<name>" to a log when it runs, so the checks see exactly
//    which files each command ran, and in what order.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const PACKAGES = readdirSync(PACKAGES_DIR)
  .filter((d) => existsSync(join(PACKAGES_DIR, d, 'package.json')))
  .sort();

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

function scriptsOf(path: string): Record<string, string> {
  return (readJson(path).scripts ?? {}) as Record<string, string>;
}

const rootScripts = (): Record<string, string> => scriptsOf(join(ROOT, 'package.json'));
const pkgScripts = (name: string): Record<string, string> => scriptsOf(join(PACKAGES_DIR, name, 'package.json'));

// ---------------------------------------------------------------------------------------------
// The file-name rule, as one function the walk below applies to every file.
// ---------------------------------------------------------------------------------------------

/** Directories the walk never enters: installed or built output, reports, and hidden folders. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);

/** Anything that looks like a test file by its name, typed or not. */
const TEST_LIKE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$/;
const TYPED = /\.(unit|db|stack)\.test\.tsx?$/;
const E2E = /\.e2e\.ts$/;

/**
 * Why a file under packages/ breaks the D177 names, or null when it's fine (or isn't a test file).
 * `rel` is the path from the repo root with forward slashes, e.g. `packages/api/tests/x.db.test.ts`.
 */
function nameProblem(rel: string): string | null {
  const base = rel.split('/').pop() ?? rel;
  if (!TEST_LIKE.test(base)) return null;
  const inWebE2e = rel.startsWith('packages/web/e2e/');
  const inAnyE2e = rel.split('/').includes('e2e');
  if (/\.spec\.[cm]?[jt]sx?$/.test(base))
    return 'a .spec file: browser tests are e2e/*.e2e.ts, others .unit/.db/.stack';
  if (E2E.test(base)) return inWebE2e ? null : 'an .e2e.ts file outside packages/web/e2e/';
  if (/\.e2e\./.test(base)) return 'a browser test must be a .e2e.ts file';
  if (inAnyE2e) return 'a Vitest test inside an e2e/ folder (Vitest never runs e2e/**)';
  if (TYPED.test(base)) return null;
  if (/\.live\.test\./.test(base)) return 'a .live test: name it .db or .stack by what it needs';
  return 'no D177 type: name it .unit, .db or .stack .test.ts(x)';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const allFiles = (): string[] => walk(PACKAGES_DIR).map((f) => relative(ROOT, f).split(sep).join('/'));
const testFiles = (): string[] => allFiles().filter((f) => TEST_LIKE.test(f.split('/').pop() ?? ''));

describe('the name rule itself (so the walk below can fail)', () => {
  it.each([
    ['packages/api/tests/audit/chain.test.ts', 'no D177 type'],
    ['packages/infra/tests/compose/dev-relay.live.test.ts', 'a .live test'],
    ['packages/web/e2e/sign-in.spec.ts', 'a .spec file'],
    ['packages/web/tests/auth/mfa.spec.tsx', 'a .spec file'],
    ['packages/api/e2e/sign-in.e2e.ts', 'outside packages/web/e2e/'],
    ['packages/web/tests/sign-in.e2e.ts', 'outside packages/web/e2e/'],
    ['packages/web/e2e/sign-in.unit.test.ts', 'inside an e2e/ folder'],
    ['packages/web/e2e/sign-in.e2e.tsx', 'must be a .e2e.ts file'],
    ['packages/api/tests/x.test.js', 'no D177 type'],
  ])('flags %s', (rel, why) => {
    expect(nameProblem(rel)).toContain(why);
  });

  it.each([
    'packages/api/tests/audit/chain.unit.test.ts',
    'packages/web/tests/auth/mfa.unit.test.tsx',
    'packages/api/tests/auth/mfa.db.test.ts',
    'packages/infra/tests/front-door/https.stack.test.ts',
    'packages/web/e2e/sign-in.e2e.ts',
    'packages/web/e2e/helpers.ts',
    'packages/api/tests/db/helpers.ts',
  ])('accepts %s', (rel) => {
    expect(nameProblem(rel)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Criterion 1: every test file under packages/* has a D177 type.
// ---------------------------------------------------------------------------------------------

describe('criterion 1: every test file under packages/* is named by what it needs (D177)', () => {
  it('finds the test files (the walk is not looking at an empty tree)', () => {
    const files = testFiles();
    expect(files.filter((f) => TYPED.test(f)).length).toBeGreaterThanOrEqual(87);
    expect(files.filter((f) => E2E.test(f))).toContain('packages/web/e2e/sign-in.e2e.ts');
  });

  it('has no test file without a type (.unit / .db / .stack .test.ts(x), or e2e/*.e2e.ts)', () => {
    const problems = testFiles()
      .map((f) => [f, nameProblem(f)] as const)
      .filter(([, why]) => why !== null)
      .map(([f, why]) => `${f}: ${why}`);
    expect(problems).toEqual([]);
  });

  it('has no .spec or .e2e file outside packages/web/e2e/', () => {
    const outside = testFiles().filter(
      (f) => /\.(spec|e2e)\.[cm]?[jt]sx?$/.test(f) && !f.startsWith('packages/web/e2e/'),
    );
    expect(outside).toEqual([]);
  });

  it('keeps only .e2e.ts browser tests (and their helpers) in packages/web/e2e/', () => {
    const e2eDir = join(PACKAGES_DIR, 'web', 'e2e');
    const tests = readdirSync(e2eDir).filter((f) => TEST_LIKE.test(f));
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.filter((f) => !E2E.test(f))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Criteria 3-5 (static): the scripts each package and the root declare.
// ---------------------------------------------------------------------------------------------

const KIND_SCRIPTS = ['test:unit', 'test:db', 'test:stack'] as const;

describe('criterion 3: each package has test:unit, test:db and test:stack, and test runs all three', () => {
  it.each(PACKAGES)('packages/%s declares test, test:unit, test:db and test:stack', (name) => {
    expect(Object.keys(pkgScripts(name))).toEqual(expect.arrayContaining(['test', ...KIND_SCRIPTS]));
  });

  // The sandbox below proves the scripts' behaviour on a copy of packages/infra's. Every package
  // uses the same scripts, so that proof covers them all.
  it.each(PACKAGES)('packages/%s uses the same test scripts as packages/infra', (name) => {
    const infra = pkgScripts('infra');
    const mine = pkgScripts(name);
    for (const script of ['test', ...KIND_SCRIPTS]) {
      expect(mine[script], `${script} in packages/${name}`).toBe(infra[script]);
    }
  });
});

describe('criterion 5: db and stack runs call the doctor (pnpm test:env) first; unit runs never do', () => {
  it.each(PACKAGES)('packages/%s: test:db and test:stack call test:env', (name) => {
    const scripts = pkgScripts(name);
    for (const script of ['test:db', 'test:stack']) {
      const text = scripts[script] ?? '';
      expect(text, `${script} in packages/${name}`).toMatch(/\btest:env\b/);
      const doctorAt = text.search(/\btest:env\b/);
      const vitestAt = text.search(/\bvitest\b/);
      if (vitestAt !== -1) expect(doctorAt, `${script}: test:env before vitest`).toBeLessThan(vitestAt);
    }
  });

  it.each(PACKAGES)('packages/%s: test:unit never calls the doctor', (name) => {
    const text = pkgScripts(name)['test:unit'];
    expect(text).toBeDefined();
    expect(text).not.toMatch(/\btest:env\b/);
  });

  it('the root test:db and test:stack call test:env; the root test:unit does not', () => {
    const scripts = rootScripts();
    for (const script of ['test:db', 'test:stack']) {
      expect(scripts[script] ?? '', `root ${script}`).toMatch(/\btest:env\b/);
    }
    expect(scripts['test:unit']).toBeDefined();
    expect(scripts['test:unit']).not.toMatch(/\btest:env\b/);
  });
});

describe('criterion 4: the root scripts', () => {
  it('declares test, test:unit, test:db, test:stack and test:e2e', () => {
    expect(Object.keys(rootScripts())).toEqual(expect.arrayContaining(['test', ...KIND_SCRIPTS, 'test:e2e']));
  });

  it('test runs test:unit, then test:db, then test:stack', () => {
    const test = rootScripts().test ?? '';
    const at = KIND_SCRIPTS.map((s) => test.search(new RegExp(`\\b${s}\\b`)));
    expect(
      at.every((i) => i !== -1),
      `root test: ${test}`,
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('test does not run the browser tests', () => {
    expect(rootScripts().test ?? '').not.toMatch(/e2e|playwright/);
  });

  it('test:e2e runs Playwright in packages/web', () => {
    const e2e = rootScripts()['test:e2e'] ?? '';
    expect(e2e).toMatch(/\bplaywright\b/);
    expect(e2e).toMatch(/\bweb\b/);
  });
});

describe('criterion 7: no automatic retries in any script (D171)', () => {
  it('no root or package test script passes --retry or --retries', () => {
    const all = [
      ...Object.entries(rootScripts()).map(([k, v]) => [`root ${k}`, v] as const),
      ...PACKAGES.flatMap((p) => Object.entries(pkgScripts(p)).map(([k, v]) => [`packages/${p} ${k}`, v] as const)),
    ];
    expect(all.filter(([, v]) => /--retr(y|ies)\b/.test(v)).map(([k]) => k)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Criterion 7: the Vitest and Playwright configs.
// ---------------------------------------------------------------------------------------------

async function loadVitestConfig(name: string): Promise<Json> {
  const file = join(PACKAGES_DIR, name, 'vitest.config.ts');
  const mod = (await import(pathToFileURL(file).href)) as { default: unknown };
  let config = mod.default;
  if (typeof config === 'function') {
    config = await (config as (env: Json) => unknown)({ command: 'serve', mode: 'test' });
  }
  return (await config) as Json;
}

/** The top-level test options plus every inline project's, so a per-kind project split is covered. */
function testOptionSets(config: Json): { label: string; test: Json }[] {
  const top = (config.test ?? {}) as Json;
  const sets = [{ label: 'test', test: top }];
  const projects = (top.projects ?? []) as unknown[];
  projects.forEach((p, i) => {
    if (p && typeof p === 'object') {
      const proj = p as Json;
      sets.push({ label: `test.projects[${i}]`, test: (proj.test ?? {}) as Json });
    }
  });
  return sets;
}

function picksUp(test: Json, rel: string): boolean {
  const include = ((test.include as string[] | undefined) ?? []).map(String);
  const exclude = ((test.exclude as string[] | undefined) ?? []).map(String);
  return include.some((p) => matchesGlob(rel, p)) && !exclude.some((p) => matchesGlob(rel, p));
}

describe('criterion 7: every Vitest config sets retry to 0 and stays out of e2e/ and .claude/', () => {
  it.each(PACKAGES)('packages/%s/vitest.config.ts sets test.retry: 0', async (name) => {
    const test = ((await loadVitestConfig(name)).test ?? {}) as Json;
    expect(test.retry).toBe(0);
  });

  it.each(PACKAGES)('packages/%s: no Vitest project turns retries back on', async (name) => {
    for (const { label, test } of testOptionSets(await loadVitestConfig(name))) {
      if (test.retry !== undefined) expect(test.retry, label).toBe(0);
    }
  });

  it.each(PACKAGES)('packages/%s: Vitest picks up the typed test files and nothing in e2e/', async (name) => {
    const sets = testOptionSets(await loadVitestConfig(name));
    const picked = (rel: string): boolean => sets.some(({ test }) => picksUp(test, rel));
    for (const rel of [
      'e2e/sign-in.e2e.ts',
      'e2e/probe.unit.test.ts',
      'e2e/probe.db.test.ts',
      'e2e/deep/x.stack.test.ts',
    ]) {
      expect(picked(rel), rel).toBe(false);
    }
    for (const rel of ['tests/a/probe.unit.test.ts', 'tests/a/probe.db.test.ts', 'tests/a/probe.stack.test.ts']) {
      expect(picked(rel), rel).toBe(true);
    }
    for (const { label, test } of sets) {
      for (const p of ((test.include as string[] | undefined) ?? []).map(String)) {
        expect(p, `${label}.include`).not.toContain('.claude');
      }
    }
  });
});

type PlaywrightView = {
  retries: unknown;
  testMatch: ({ glob: string } | { re: string; flags: string })[] | null;
  testDir: unknown;
};

/** Loads packages/web/playwright.config.ts in a child Node (it changes the process's CA roots). */
function playwrightConfig(ci: boolean): PlaywrightView {
  const file = pathToFileURL(join(PACKAGES_DIR, 'web', 'playwright.config.ts')).href;
  const script = `
    const c = (await import(${JSON.stringify(file)})).default;
    const list = c.testMatch === undefined ? null : [].concat(c.testMatch);
    const testMatch = list && list.map((m) => m instanceof RegExp ? { re: m.source, flags: m.flags } : { glob: String(m) });
    process.stdout.write(JSON.stringify({ retries: c.retries, testMatch, testDir: c.testDir ?? null }));
  `;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (ci) env.CI = '1';
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
    {
      cwd: join(PACKAGES_DIR, 'web'),
      env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (r.status !== 0) throw new Error(`could not load playwright.config.ts: ${r.stderr}`);
  return JSON.parse(r.stdout) as PlaywrightView;
}

function playwrightMatches(view: PlaywrightView, absPath: string): boolean {
  return (view.testMatch ?? []).some((m) => {
    if ('re' in m) return new RegExp(m.re, m.flags).test(absPath);
    const glob = m.glob.startsWith('/') || m.glob.startsWith('**/') ? m.glob : `**/${m.glob}`;
    return matchesGlob(absPath, glob);
  });
}

describe('criterion 7: the Playwright config', () => {
  it.each([
    ['with CI set', true],
    ['without CI', false],
  ])('sets retries: 0 %s', (_label, ci) => {
    expect(playwrightConfig(ci).retries).toBe(0);
  });

  it('sets testMatch so it picks up *.e2e.ts only', () => {
    const view = playwrightConfig(true);
    expect(view.testMatch, 'testMatch must be set (the default also picks up .spec and .test files)').not.toBeNull();
    const e2e = join(PACKAGES_DIR, 'web', 'e2e');
    expect(playwrightMatches(view, join(e2e, 'sign-in.e2e.ts'))).toBe(true);
    expect(playwrightMatches(view, join(e2e, 'deep', 'other.e2e.ts'))).toBe(true);
    for (const f of ['sign-in.spec.ts', 'sign-in.test.ts', 'sign-in.unit.test.ts', 'helpers.ts', 'sign-in.e2e.tsx']) {
      expect(playwrightMatches(view, join(e2e, f)), f).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Criterion 6 (static): every task's test command on the board still finds its files.
// ---------------------------------------------------------------------------------------------

type BoardCommand = { task: string; pkg: string; pattern: string; runner: 'vitest' | 'playwright' };

/** The test commands of every done task on the board, plus this task's own. */
function boardCommands(): BoardCommand[] {
  const board = readFileSync(join(ROOT, 'TASKS.md'), 'utf8').split('## Briefs')[0] ?? '';
  const out: BoardCommand[] = [];
  for (const line of board.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const task = cells[1] ?? '';
    if (!/^[A-Z0-9]+-\d{3}$/.test(task)) continue;
    if (cells[4] !== 'done' && task !== 'TEST-001') continue;
    for (const m of line.matchAll(/pnpm --filter (\S+) test -- ([^\s`]+)/g)) {
      out.push({ task, pkg: m[1]!, pattern: m[2]!, runner: 'vitest' });
    }
    for (const m of line.matchAll(/pnpm --filter (\S+) playwright test ([^\s`]+)/g)) {
      out.push({ task, pkg: m[1]!, pattern: m[2]!, runner: 'playwright' });
    }
  }
  return out;
}

describe('criterion 6: each task command on the board still matches test files of a D177 kind', () => {
  it('reads the done tasks’ commands from TASKS.md', () => {
    const tasks = new Set(boardCommands().map((c) => c.task));
    expect(tasks.size).toBeGreaterThanOrEqual(17);
    expect(tasks).toContain('TEST-001');
  });

  it('every command matches at least one file of its runner’s kind', () => {
    const files = testFiles();
    const missing = boardCommands().filter(({ pkg, pattern, runner }) => {
      const dir = `packages/${pkg.replace(/^@grc\//, '')}/`;
      return !files.some((f) => {
        if (!f.startsWith(dir)) return false;
        const inPkg = f.slice(dir.length);
        const kindOk = runner === 'vitest' ? TYPED.test(f) : E2E.test(f);
        return kindOk && inPkg.includes(pattern);
      });
    });
    expect(missing.map((c) => `${c.task}: ${c.pkg} ${c.pattern}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Criteria 3-6 (behaviour): the scripts, run in a throwaway workspace with a stand-in doctor.
// ---------------------------------------------------------------------------------------------

const PROBE_FILES: Record<string, string> = {
  'tests/alpha.unit.test.ts': 'unit:alpha',
  'tests/beta.unit.test.ts': 'unit:beta',
  'tests/alpha.db.test.ts': 'db:alpha',
  'tests/gamma.db.test.ts': 'db:gamma',
  'tests/alpha.stack.test.ts': 'stack:alpha',
  // A browser test: no Vitest run may ever pick it up.
  'e2e/zeta.e2e.ts': 'e2e:zeta',
};

const LINK_SKIP = new Set([
  'node_modules',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'packages',
  '.git',
  '.env',
  '.claude',
  'logs',
]);

let SANDBOX = '';
let LOG = '';

function buildSandbox(): void {
  if (!existsSync(join(ROOT, 'node_modules', '.bin', 'vitest'))) {
    throw new Error('node_modules/.bin/vitest is missing: run `pnpm install` first');
  }
  SANDBOX = join(ROOT, 'node_modules', '.cache', `grc-test-names-${randomBytes(6).toString('hex')}`);
  LOG = join(SANDBOX, 'ran.log');
  const probeDir = join(SANDBOX, 'packages', 'probe');
  mkdirSync(probeDir, { recursive: true });

  for (const entry of readdirSync(ROOT)) {
    if (!LINK_SKIP.has(entry)) symlinkSync(join(ROOT, entry), join(SANDBOX, entry));
  }
  for (const name of PACKAGES) symlinkSync(join(PACKAGES_DIR, name), join(SANDBOX, 'packages', name));
  writeFileSync(join(SANDBOX, 'pnpm-workspace.yaml'), 'packages:\n  - packages/probe\n');

  const doctor = join(SANDBOX, 'stand-in-doctor.mjs');
  writeFileSync(
    doctor,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.PROBE_LOG, 'doctor\\n');",
      "const failing = process.env.STAND_IN_DOCTOR === 'fail';",
      "console.log(`sandbox check: ${failing ? 'missing' : 'OK'}`);",
      'process.exit(failing ? 1 : 0);',
      '',
    ].join('\n'),
  );
  const root = readJson(join(ROOT, 'package.json'));
  root.name = 'grc-test-names-sandbox';
  delete root.devDependencies;
  delete root.dependencies;
  root.scripts = { ...((root.scripts ?? {}) as Json), 'test:env': `node ${JSON.stringify(doctor)}` };
  writeFileSync(join(SANDBOX, 'package.json'), JSON.stringify(root, null, 2));

  const infraDir = join(PACKAGES_DIR, 'infra');
  const infra = readJson(join(infraDir, 'package.json'));
  writeFileSync(
    join(probeDir, 'package.json'),
    JSON.stringify({ name: '@grc/probe', private: true, type: 'module', scripts: infra.scripts ?? {} }, null, 2),
  );
  for (const f of readdirSync(infraDir)) {
    if (/^vitest\..*\.[cm]?[jt]s$/.test(f) && statSync(join(infraDir, f)).isFile()) {
      copyFileSync(join(infraDir, f), join(probeDir, f));
    }
  }
  for (const [file, tag] of Object.entries(PROBE_FILES)) {
    mkdirSync(dirname(join(probeDir, file)), { recursive: true });
    writeFileSync(
      join(probeDir, file),
      [
        "import { appendFileSync } from 'node:fs';",
        "import { expect, it } from 'vitest';",
        `it('${tag} ran', () => {`,
        `  appendFileSync(process.env.PROBE_LOG as string, '${tag}\\n');`,
        '  expect(true).toBe(true);',
        '});',
        '',
      ].join('\n'),
    );
  }
}

type Run = { status: number | null; output: string; ran: string[] };

/** Runs pnpm in the sandbox (at its root, or with --filter @grc/probe) with the stand-in doctor. */
function sandboxPnpm(args: string[], doctor: 'ok' | 'fail'): Run {
  writeFileSync(LOG, '');
  // A clean environment: the parent run's pnpm and Vitest variables change the child's behaviour.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(npm_|pnpm_|PNPM_|VITEST|TEST$|NODE_ENV$|NODE_OPTIONS$)/i.test(k)),
  );
  const r = spawnSync('pnpm', args, {
    cwd: SANDBOX,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...env,
      PATH: `${join(ROOT, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // The sandbox installs nothing: pnpm must not try to (re)install before running a script.
      pnpm_config_verify_deps_before_run: 'false',
      npm_config_verify_deps_before_run: 'false',
      PROBE_LOG: LOG,
      STAND_IN_DOCTOR: doctor,
    },
  });
  const ran = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, ran };
}

const probe = (script: string, ...rest: string[]): string[] => ['--filter', '@grc/probe', script, ...rest];
const tests = (run: Run): string[] => run.ran.filter((l) => l !== 'doctor').sort();
const show = (run: Run): string => `exit ${run.status}; ran [${run.ran.join(', ')}]\n${run.output}`;

describe('criteria 3-6 in a throwaway workspace with a stand-in doctor', () => {
  beforeAll(() => {
    buildSandbox();
  });

  afterAll(() => {
    if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
  });

  it('the stand-in doctor itself works (so a quiet log means "not called")', () => {
    const run = sandboxPnpm(['test:env'], 'fail');
    expect(run.status, show(run)).not.toBe(0);
    expect(run.ran).toEqual(['doctor']);
  });

  describe('per package (pnpm --filter <pkg> ...)', () => {
    it('test:unit runs only the unit files and never calls the doctor', () => {
      const run = sandboxPnpm(probe('test:unit'), 'fail');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran, show(run)).toEqual(expect.not.arrayContaining(['doctor']));
      expect(tests(run), show(run)).toEqual(['unit:alpha', 'unit:beta']);
    });

    it('test:unit -- <pattern> runs only the matching unit file', () => {
      const run = sandboxPnpm(probe('test:unit', '--', 'beta'), 'fail');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran, show(run)).toEqual(['unit:beta']);
    });

    it('test:db calls the doctor first, then runs only the db files', () => {
      const run = sandboxPnpm(probe('test:db'), 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran[0], show(run)).toBe('doctor');
      expect(tests(run), show(run)).toEqual(['db:alpha', 'db:gamma']);
    });

    it('test:db -- <pattern> runs only the matching db file', () => {
      const run = sandboxPnpm(probe('test:db', '--', 'gamma'), 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran[0], show(run)).toBe('doctor');
      expect(tests(run), show(run)).toEqual(['db:gamma']);
    });

    it('test:db stops when the doctor fails: non-zero exit, the doctor’s list shown, no tests run', () => {
      const run = sandboxPnpm(probe('test:db'), 'fail');
      expect(run.status, show(run)).not.toBe(0);
      expect(run.ran, show(run)).toEqual(['doctor']);
      expect(run.output).toContain('sandbox check: missing');
    });

    it('test:stack calls the doctor first, then runs only the stack files', () => {
      const run = sandboxPnpm(probe('test:stack'), 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran[0], show(run)).toBe('doctor');
      expect(tests(run), show(run)).toEqual(['stack:alpha']);
    });

    it('test:stack stops when the doctor fails: non-zero exit, the doctor’s list shown, no tests run', () => {
      const run = sandboxPnpm(probe('test:stack'), 'fail');
      expect(run.status, show(run)).not.toBe(0);
      expect(run.ran, show(run)).toEqual(['doctor']);
      expect(run.output).toContain('sandbox check: missing');
    });

    it('test runs all three kinds (and no browser test), with the doctor before db and stack', () => {
      const run = sandboxPnpm(probe('test'), 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(tests(run), show(run)).toEqual(['db:alpha', 'db:gamma', 'stack:alpha', 'unit:alpha', 'unit:beta']);
      const doctorAt = run.ran.indexOf('doctor');
      expect(doctorAt, show(run)).toBeGreaterThanOrEqual(0);
      const firstLive = run.ran.findIndex((l) => l.startsWith('db:') || l.startsWith('stack:'));
      expect(doctorAt, show(run)).toBeLessThan(firstLive);
    });

    it('test -- <pattern> that matches only unit files runs them, skips db and stack quietly, never calls the doctor', () => {
      const run = sandboxPnpm(probe('test', '--', 'beta'), 'fail');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran, show(run)).toEqual(['unit:beta']);
    });

    it('test -- <pattern> that matches db files still stops on a failing doctor, with no db test run', () => {
      const run = sandboxPnpm(probe('test', '--', 'gamma'), 'fail');
      expect(run.status, show(run)).not.toBe(0);
      expect(run.ran, show(run)).toEqual(['doctor']);
    });

    it('test -- <pattern> that matches no file of any kind fails, without calling the doctor', () => {
      const run = sandboxPnpm(probe('test', '--', 'no-such-test-file-zz'), 'ok');
      expect(run.status, show(run)).not.toBe(0);
      expect(run.ran, show(run)).toEqual([]);
    });
  });

  describe('at the root', () => {
    it('pnpm test:unit runs the unit files of every package and never calls the doctor', () => {
      const run = sandboxPnpm(['test:unit'], 'fail');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran, show(run)).toEqual(expect.not.arrayContaining(['doctor']));
      expect(tests(run), show(run)).toEqual(['unit:alpha', 'unit:beta']);
    });

    it('pnpm test:db runs only db files, after the doctor', () => {
      const run = sandboxPnpm(['test:db'], 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran[0], show(run)).toBe('doctor');
      expect(tests(run), show(run)).toEqual(['db:alpha', 'db:gamma']);
    });

    it('pnpm test:db stops at once when the doctor fails, shows its list and runs no tests', () => {
      const run = sandboxPnpm(['test:db'], 'fail');
      expect(run.status, show(run)).not.toBe(0);
      expect(run.ran, show(run)).toEqual(['doctor']);
      expect(run.output).toContain('sandbox check: missing');
    });

    it('pnpm test:stack runs only stack files, after the doctor', () => {
      const run = sandboxPnpm(['test:stack'], 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(run.ran[0], show(run)).toBe('doctor');
      expect(tests(run), show(run)).toEqual(['stack:alpha']);
    });

    it('pnpm test:stack stops at once when the doctor fails, shows its list and runs no tests', () => {
      const run = sandboxPnpm(['test:stack'], 'fail');
      expect(run.status, show(run)).not.toBe(0);
      expect(run.ran, show(run)).toEqual(['doctor']);
      expect(run.output).toContain('sandbox check: missing');
    });

    it('pnpm test runs unit, then db, then stack, and no browser test', () => {
      const run = sandboxPnpm(['test'], 'ok');
      expect(run.status, show(run)).toBe(0);
      expect(tests(run), show(run)).toEqual(['db:alpha', 'db:gamma', 'stack:alpha', 'unit:alpha', 'unit:beta']);
      const at = (prefix: string): number[] => run.ran.flatMap((l, i) => (l.startsWith(prefix) ? [i] : []));
      expect(Math.max(...at('unit:')), show(run)).toBeLessThan(Math.min(...at('db:')));
      expect(Math.max(...at('db:')), show(run)).toBeLessThan(Math.min(...at('stack:')));
      const doctors = at('doctor');
      expect(doctors.length, show(run)).toBeGreaterThan(0);
      expect(Math.min(...doctors), show(run)).toBeLessThan(Math.min(...at('db:')));
    });

    it('pnpm test with a failing doctor runs the unit files, then stops before any db or stack test', () => {
      const run = sandboxPnpm(['test'], 'fail');
      expect(run.status, show(run)).not.toBe(0);
      expect(tests(run), show(run)).toEqual(['unit:alpha', 'unit:beta']);
      expect(run.ran, show(run)).toContain('doctor');
    });
  });
});
