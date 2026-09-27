// M0-002 criterion 7: `pnpm setup:secrets` writes the git-ignored `.env` (D57).
//
// Contract these tests hold the script to:
// - It is run as `node packages/infra/scripts/setup-secrets.ts` (Node 24 runs the
//   TypeScript directly). It reads `.env.example` and writes `.env` in the current
//   working directory; the root `setup:secrets` script runs it from the repo root.
// - A "secret" is every name in `.env.example` that contains PASSWORD, SECRET, TOKEN
//   or KEY. Each gets a fresh random value: at least 24 characters, URL-safe
//   (A-Z a-z 0-9 _ -) so it can sit inside a connection URL unquoted, and different
//   from every other secret.
// - NEO4J_DESKTOP_PASSWORD is the user's own (M0 question Q7): the script leaves it
//   empty and its output names it, so the user knows to fill it in.
// - It never overwrites a value that is already set, never prints a secret, and
//   leaves `.env` at mode 600.
//
// Each test runs the script in its own temp folder with a copy of the repo's real
// `.env.example`.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(ROOT, 'packages', 'infra', 'scripts', 'setup-secrets.ts');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const USER_SUPPLIED = 'NEO4J_DESKTOP_PASSWORD';
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY/;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function exampleNames(): string[] {
  return readFileSync(ENV_EXAMPLE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.split('=')[0]!.trim());
}

function generatedSecretNames(): string[] {
  return exampleNames().filter((n) => SECRET_NAME.test(n) && n !== USER_SUPPLIED);
}

function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'grc-setup-secrets-test-'));
  dirs.push(d);
  copyFileSync(ENV_EXAMPLE, join(d, '.env.example'));
  return d;
}

function run(cwd: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    encoding: 'utf8',
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function readEnv(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    map.set(line.slice(0, eq).trim(), value);
  }
  return map;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('setup-secrets: wiring', () => {
  it('the script exists at packages/infra/scripts/setup-secrets.ts', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('the root package.json has a setup:secrets script that runs it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['setup:secrets'] ?? '').toContain('packages/infra/scripts/setup-secrets.ts');
  });

  it('.env.example names secrets for the script to fill', () => {
    expect(generatedSecretNames().length).toBeGreaterThanOrEqual(3);
  });
});

describe('setup-secrets: a fresh run', () => {
  it('exits 0 and writes .env', () => {
    const d = workdir();
    const r = run(d);
    expect(r.status, r.output).toBe(0);
    expect(existsSync(join(d, '.env'))).toBe(true);
  });

  it('gives every secret a random, URL-safe value of at least 24 characters', () => {
    const d = workdir();
    expect(run(d).status).toBe(0);
    const env = readEnv(d);
    for (const name of generatedSecretNames()) {
      expect(env.get(name), name).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    }
  });

  it('gives every secret a different value', () => {
    const d = workdir();
    expect(run(d).status).toBe(0);
    const env = readEnv(d);
    const values = generatedSecretNames().map((n) => env.get(n));
    expect(new Set(values).size).toBe(values.length);
  });

  it('makes new values on each fresh setup (nothing fixed in the script)', () => {
    const a = workdir();
    const b = workdir();
    expect(run(a).status).toBe(0);
    expect(run(b).status).toBe(0);
    const ea = readEnv(a);
    const eb = readEnv(b);
    for (const name of generatedSecretNames()) expect(ea.get(name), name).not.toBe(eb.get(name));
  });

  it('leaves NEO4J_DESKTOP_PASSWORD present but empty', () => {
    const d = workdir();
    expect(run(d).status).toBe(0);
    const env = readEnv(d);
    expect(env.has(USER_SUPPLIED)).toBe(true);
    expect(env.get(USER_SUPPLIED)).toBe('');
  });

  it('says that NEO4J_DESKTOP_PASSWORD is for the user to fill in', () => {
    const d = workdir();
    const r = run(d);
    expect(r.status).toBe(0);
    expect(r.output).toContain(USER_SUPPLIED);
  });

  it('never prints a secret', () => {
    const d = workdir();
    const r = run(d);
    expect(r.status).toBe(0);
    const env = readEnv(d);
    for (const name of generatedSecretNames()) {
      const value = env.get(name) ?? '';
      expect(value.length).toBeGreaterThan(0);
      expect(r.output.includes(value), `${name} was printed`).toBe(false);
    }
  });

  it('sets .env to mode 600', () => {
    const d = workdir();
    expect(run(d).status).toBe(0);
    expect(mode(join(d, '.env'))).toBe(0o600);
  });
});

describe('setup-secrets: an existing .env', () => {
  it('keeps every value on a second run', () => {
    const d = workdir();
    expect(run(d).status).toBe(0);
    const first = readEnv(d);
    const r = run(d);
    expect(r.status, r.output).toBe(0);
    expect(readEnv(d)).toEqual(first);
  });

  it('keeps values the user set, fills the missing ones, and keeps unrelated lines', () => {
    const d = workdir();
    const names = generatedSecretNames();
    const kept = names[0]!;
    writeFileSync(
      join(d, '.env'),
      `# my notes\n${kept}=user-chosen-value-000000000000\n${USER_SUPPLIED}=desktop-pass-from-user\nMY_OWN_SETTING=hello\n`,
      { mode: 0o600 },
    );
    const r = run(d);
    expect(r.status, r.output).toBe(0);
    const env = readEnv(d);
    expect(env.get(kept)).toBe('user-chosen-value-000000000000');
    expect(env.get(USER_SUPPLIED)).toBe('desktop-pass-from-user');
    expect(env.get('MY_OWN_SETTING')).toBe('hello');
    for (const name of names.slice(1)) expect(env.get(name), name).toMatch(/^[A-Za-z0-9_-]{24,}$/);
  });

  it('does not print a value the user already set', () => {
    const d = workdir();
    writeFileSync(join(d, '.env'), `${USER_SUPPLIED}=desktop-pass-from-user\n`, { mode: 0o600 });
    const r = run(d);
    expect(r.status).toBe(0);
    expect(r.output).not.toContain('desktop-pass-from-user');
  });

  it('tightens an existing .env to mode 600', () => {
    const d = workdir();
    writeFileSync(join(d, '.env'), 'MY_OWN_SETTING=hello\n');
    chmodSync(join(d, '.env'), 0o644);
    expect(run(d).status).toBe(0);
    expect(mode(join(d, '.env'))).toBe(0o600);
  });
});
