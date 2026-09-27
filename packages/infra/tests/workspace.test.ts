// M0-001: the pnpm workspaces monorepo every later task builds in.
// Decisions: D6, D33, D36, D46, D78, D82 (one test process), D97 (root lint,
// typecheck and test scripts), D130 (ESLint + Prettier), memory.md setup item
// "keep Vitest away from the hook tests".
//
// These tests use only Node built-ins and Vitest, so they load and fail on the
// missing workspace rather than on an import error.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = ['api', 'web', 'shared', 'generators', 'benchmark', 'infra'] as const;

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

// tsconfig files may hold comments and trailing commas (JSONC).
function readJsonc(path: string): Json {
  const text = readFileSync(path, 'utf8');
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Json;
}

function rootPackageJson(): Json {
  return readJson(join(ROOT, 'package.json'));
}

function scriptsOf(pkg: Json): Record<string, string> {
  return (pkg.scripts ?? {}) as Record<string, string>;
}

function pkgDir(name: string): string {
  return join(ROOT, 'packages', name);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Loads a package's vitest.config.ts the way Vitest would see it.
async function loadVitestConfig(name: string): Promise<Json> {
  const file = join(pkgDir(name), 'vitest.config.ts');
  const mod = (await import(pathToFileURL(file).href)) as { default: unknown };
  let config = mod.default;
  if (typeof config === 'function') {
    config = await (config as (env: Json) => unknown)({ command: 'serve', mode: 'test' });
  }
  return (await config) as Json;
}

// Resolves a package from the root the way the root scripts would.
async function importFromRoot<T>(specifier: string): Promise<T> {
  const req = createRequire(join(ROOT, 'package.json'));
  return (await import(pathToFileURL(req.resolve(specifier)).href)) as T;
}

describe('root workspace files', () => {
  it('has a private root package.json pinned to pnpm 11.1.3 and Node 24', () => {
    const pkg = rootPackageJson();
    expect(pkg.private).toBe(true);
    expect(pkg.packageManager).toBe('pnpm@11.1.3');
    expect((pkg.engines as Json | undefined)?.node).toBe('>=24');
  });

  it('declares packages/* as the workspace', () => {
    const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    expect(yaml).toMatch(/^packages:\s*$/m);
    expect(yaml).toMatch(/^\s*-\s*['"]?packages\/\*['"]?\s*$/m);
  });

  it('has .nvmrc set to 24 and an .env.example', () => {
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toBe('24');
    expect(existsSync(join(ROOT, '.env.example'))).toBe(true);
  });

  it('has a lockfile that covers the root and all six packages, so a clean clone installs', () => {
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toMatch(/^importers:\s*$/m);
    expect(lock).toMatch(/^ {2}\.:\s*$/m);
    for (const name of PACKAGES) {
      expect(lock, `lockfile importer for packages/${name}`).toMatch(new RegExp(`^ {2}packages/${name}:\\s*$`, 'm'));
    }
  });
});

describe('root scripts (D97)', () => {
  it('has lint, typecheck and test scripts', () => {
    const scripts = scriptsOf(rootPackageJson());
    expect(Object.keys(scripts)).toEqual(expect.arrayContaining(['lint', 'typecheck', 'test']));
  });

  it('typecheck runs every package (pnpm -r typecheck)', () => {
    expect(scriptsOf(rootPackageJson()).typecheck).toMatch(/^pnpm (-r|--recursive) (run )?typecheck$/);
  });

  it('test runs every package (pnpm -r test), not a root Vitest run', () => {
    expect(scriptsOf(rootPackageJson()).test).toMatch(/^pnpm (-r|--recursive) (run )?test$/);
  });

  it('lint runs both ESLint and a Prettier check (D130)', () => {
    const lint = scriptsOf(rootPackageJson()).lint ?? '';
    expect(lint).toMatch(/\beslint\b/);
    expect(lint).toMatch(/\bprettier\b[^&|;]*\s(--check|-c)\b/);
    expect(lint).not.toMatch(/--write\b|\s-w\b|--fix\b/);
  });
});

describe('TypeScript base config', () => {
  const base = () => readJsonc(join(ROOT, 'tsconfig.base.json'));
  const options = () => (base().compilerOptions ?? {}) as Json;

  it('is strict with noUncheckedIndexedAccess', () => {
    expect(options().strict).toBe(true);
    expect(options().noUncheckedIndexedAccess).toBe(true);
  });

  it('targets ES2024 with NodeNext modules', () => {
    expect(String(options().target).toLowerCase()).toBe('es2024');
    expect(String(options().module).toLowerCase()).toBe('nodenext');
  });

  it.each(PACKAGES)('packages/%s/tsconfig.json extends the base config', (name) => {
    const ts = readJsonc(join(pkgDir(name), 'tsconfig.json'));
    const ext = ([] as unknown[]).concat(ts.extends ?? []).map(String);
    expect(ext.map((e) => resolve(pkgDir(name), e))).toContain(join(ROOT, 'tsconfig.base.json'));
  });
});

describe('ESLint and Prettier at the root (D130)', () => {
  it('has an ESLint flat config and a Prettier config at the root', () => {
    expect(existsSync(join(ROOT, 'eslint.config.js'))).toBe(true);
    expect(existsSync(join(ROOT, '.prettierrc'))).toBe(true);
    expect(existsSync(join(ROOT, '.prettierignore'))).toBe(true);
  });

  it('ESLint ignores .claude/**, logs/** and dist/** but lints package sources', async () => {
    const { ESLint } = await importFromRoot<{
      ESLint: new (o: Json) => { isPathIgnored(p: string): Promise<boolean> };
    }>('eslint');
    const eslint = new ESLint({ cwd: ROOT });
    expect(await eslint.isPathIgnored(join(ROOT, '.claude/hooks/check-finish.mjs'))).toBe(true);
    expect(await eslint.isPathIgnored(join(ROOT, 'logs/activity.js'))).toBe(true);
    expect(await eslint.isPathIgnored(join(ROOT, 'packages/api/dist/index.js'))).toBe(true);
    expect(await eslint.isPathIgnored(join(ROOT, 'packages/api/src/index.ts'))).toBe(false);
  });

  it('ESLint parses TypeScript files with typescript-eslint', async () => {
    const { ESLint } = await importFromRoot<{
      ESLint: new (o: Json) => { calculateConfigForFile(p: string): Promise<Json | undefined> };
    }>('eslint');
    const eslint = new ESLint({ cwd: ROOT });
    const cfg = await eslint.calculateConfigForFile(join(ROOT, 'packages/shared/src/index.ts'));
    const parser = (cfg?.languageOptions as Json | undefined)?.parser as Json | undefined;
    const meta = parser?.meta as Json | undefined;
    expect(String(meta?.name ?? '')).toMatch(/typescript/i);
  });

  it('Prettier ignores .claude/**, logs/** and dist/** and finds the root config', async () => {
    const prettier = await importFromRoot<{
      getFileInfo(p: string, o: Json): Promise<{ ignored: boolean }>;
      resolveConfigFile(p: string): Promise<string | null>;
    }>('prettier');
    const ignorePath = join(ROOT, '.prettierignore');
    for (const file of ['.claude/hooks/check-finish.mjs', 'logs/activity.jsonl', 'packages/api/dist/index.js']) {
      expect((await prettier.getFileInfo(join(ROOT, file), { ignorePath })).ignored, file).toBe(true);
    }
    expect((await prettier.getFileInfo(join(ROOT, 'packages/api/src/index.ts'), { ignorePath })).ignored).toBe(false);
    expect(await prettier.resolveConfigFile(join(ROOT, 'packages/api/src/index.ts'))).toBe(join(ROOT, '.prettierrc'));
  });
});

describe.each(PACKAGES)('packages/%s', (name) => {
  it(`is named @grc/${name}`, () => {
    expect(readJson(join(pkgDir(name), 'package.json')).name).toBe(`@grc/${name}`);
  });

  it('has test, typecheck and lint scripts', () => {
    const scripts = scriptsOf(readJson(join(pkgDir(name), 'package.json')));
    expect(Object.keys(scripts)).toEqual(expect.arrayContaining(['test', 'typecheck', 'lint']));
  });

  it('uses the same Vitest test script as packages/infra, so `test -- <name>` filters the same way', () => {
    const test = scriptsOf(readJson(join(pkgDir(name), 'package.json'))).test;
    expect(test).toMatch(/\bvitest\b/);
    expect(test).toBe(scriptsOf(readJson(join(pkgDir('infra'), 'package.json'))).test);
  });

  it('has src/index.ts, tsconfig.json and vitest.config.ts', () => {
    for (const file of ['src/index.ts', 'tsconfig.json', 'vitest.config.ts']) {
      expect(existsSync(join(pkgDir(name), file)), file).toBe(true);
    }
  });
});

describe('Vitest stays inside each package (D82, hook tests use node:test)', () => {
  it('has no Vitest or Vite config at the root', () => {
    const rootFiles = readdirSync(ROOT);
    const configs = rootFiles.filter((f) => /^(vitest\.config|vitest\.workspace|vite\.config)\./.test(f));
    expect(configs).toEqual([]);
    expect(rootPackageJson().vitest).toBeUndefined();
  });

  it.each(PACKAGES)('packages/%s: no include pattern reaches .claude or leaves the package', async (name) => {
    const config = await loadVitestConfig(name);
    const test = (config.test ?? {}) as Json;
    for (const dir of [config.root, test.root, test.dir]) {
      if (dir !== undefined) expect(isInside(resolve(pkgDir(name), String(dir)), pkgDir(name))).toBe(true);
    }
    const include = ((test.include as string[] | undefined) ?? []).map(String);
    for (const pattern of include) {
      expect(pattern).not.toContain('.claude');
      expect(pattern.startsWith('..') || isAbsolute(pattern)).toBe(false);
    }
  });

  it.each(PACKAGES)('packages/%s: runs test files in one process (D82)', async (name) => {
    const test = ((await loadVitestConfig(name)).test ?? {}) as Json;
    const pools = (test.poolOptions ?? {}) as Record<string, Json | undefined>;
    const oneProcess =
      test.fileParallelism === false ||
      Number(test.maxWorkers) === 1 ||
      pools.forks?.singleFork === true ||
      pools.vmForks?.singleFork === true ||
      pools.threads?.singleThread === true;
    expect(oneProcess).toBe(true);
  });

  it.each(PACKAGES)('packages/%s: passes with no test files, so empty packages exit 0', async (name) => {
    const test = ((await loadVitestConfig(name)).test ?? {}) as Json;
    expect(test.passWithNoTests).toBe(true);
  });
});

// Criterion 4: `pnpm --filter <pkg> test -- <name>` runs only the matching
// files. The probe run sets GRC_FILTER_PROBE, so if the filter is ignored and
// this file runs again, it doesn't start another probe (no recursion).
describe('`pnpm --filter infra test -- <name>` runs only matching files', () => {
  it.skipIf(process.env.GRC_FILTER_PROBE === '1')(
    'runs tests/filter-probe.test.ts alone when filtered by "filter-probe"',
    () => {
      // A clean environment: with the parent run's pnpm variables, pnpm skips a
      // nested run of the same script; the parent Vitest's variables change the child's output.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !/^(npm_|pnpm_|PNPM_|VITEST|TEST$|NODE_ENV$|NODE_OPTIONS$)/i.test(k),
        ),
      );
      const r = spawnSync('pnpm', ['--filter', 'infra', 'test', '--', 'filter-probe'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', GRC_FILTER_PROBE: '1' },
      });
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status, output).toBe(0);
      // Only filter-probe.test.ts (one test) may run; workspace.test.ts must not.
      expect(output, 'only filter-probe.test.ts should run').toMatch(/Test Files\s+1 passed \(1\)/);
      expect(output, 'only the one probe test should run').toMatch(/Tests\s+1 passed \(1\)/);
    },
  );
});

describe('@grc/shared is importable from api and web', () => {
  it.each(['api', 'web'])('packages/%s depends on @grc/shared through the workspace', (name) => {
    const pkg = readJson(join(pkgDir(name), 'package.json'));
    const deps = { ...(pkg.dependencies as Json | undefined), ...(pkg.devDependencies as Json | undefined) };
    expect(String(deps['@grc/shared'] ?? '')).toMatch(/^workspace:/);
  });

  it.each(['api', 'web'])('@grc/shared resolves from packages/%s to packages/shared', (name) => {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "process.stdout.write(import.meta.resolve('@grc/shared'))"],
      { cwd: pkgDir(name), encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const resolved = realpathSync(fileURLToPath(r.stdout.trim()));
    expect(resolved.startsWith(realpathSync(pkgDir('shared')) + sep)).toBe(true);
  });
});
