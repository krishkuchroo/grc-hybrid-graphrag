// M0-016, D165 (Q44 answer a): the wiring that puts the API behind the front door.
// 1. `packages/api/package.json` has the `start:api` and `start:worker` scripts that the compose
//    commands (`pnpm --filter @grc/api start:api` / `start:worker`) run.
// 2. `compose.yaml` sets `HOST: 0.0.0.0` on grc-api and grc-worker, so Caddy reaches the API over
//    the Docker network, and passes them `BETTER_AUTH_SECRET` from `.env`. They still publish no
//    ports (D61, D63): only grc-caddy is reachable from the Mac.
// 3. `pnpm setup:secrets` generates `BETTER_AUTH_SECRET` and `DEMO_USER_PASSWORD` into `.env`
//    (both names listed in `.env.example` without values). It adds only missing keys, never
//    changes existing ones and never prints a value (D57).
//
// These are static checks: no running stack needed. Compose is read with
// `docker compose config --format json` (docker CLI only), filled from a throwaway env file with
// dummy values, never from a real `.env`. setup:secrets runs in its own temp folder with a copy
// of the repo's `.env.example`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from './helpers.js';

const ENV_EXAMPLE = join(ROOT, '.env.example');
const SECRETS_SCRIPT = join(ROOT, 'packages', 'infra', 'scripts', 'setup-secrets.ts');
const COMPOSE = join(ROOT, 'packages', 'infra', 'compose.yaml');
const API_PKG = join(ROOT, 'packages', 'api', 'package.json');

const NEW_KEYS = ['BETTER_AUTH_SECRET', 'DEMO_USER_PASSWORD'] as const;
const APP_SERVICES = ['grc-api', 'grc-worker'] as const;
const URL_SAFE_SECRET = /^[A-Za-z0-9_-]{24,}$/;

// ---------------------------------------------------------------------------------------------
// setup:secrets
// ---------------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function exampleLines(): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'grc-wiring-secrets-test-'));
  dirs.push(d);
  copyFileSync(ENV_EXAMPLE, join(d, '.env.example'));
  return d;
}

function runSecrets(cwd: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [SECRETS_SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    encoding: 'utf8',
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function envText(dir: string): string {
  return readFileSync(join(dir, '.env'), 'utf8');
}

function readEnv(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of envText(dir).split('\n')) {
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

describe('setup:secrets: .env.example names the two new keys (D165)', () => {
  for (const key of NEW_KEYS) {
    it(`lists ${key} with no value`, () => {
      const example = exampleLines();
      expect(example.has(key), `${key} missing from .env.example`).toBe(true);
      expect(example.get(key)).toBe('');
    });
  }
});

describe('setup:secrets: a fresh .env (D165)', () => {
  it('generates a random, URL-safe value of at least 24 characters for both keys', () => {
    const d = workdir();
    const r = runSecrets(d);
    expect(r.status, r.output).toBe(0);
    const env = readEnv(d);
    for (const key of NEW_KEYS) expect(env.get(key), key).toMatch(URL_SAFE_SECRET);
  });

  it('gives the two keys different values', () => {
    const d = workdir();
    expect(runSecrets(d).status).toBe(0);
    const env = readEnv(d);
    expect(env.get('BETTER_AUTH_SECRET')).toMatch(URL_SAFE_SECRET);
    expect(env.get('BETTER_AUTH_SECRET')).not.toBe(env.get('DEMO_USER_PASSWORD'));
  });

  it('prints neither value', () => {
    const d = workdir();
    const r = runSecrets(d);
    expect(r.status, r.output).toBe(0);
    const env = readEnv(d);
    for (const key of NEW_KEYS) {
      const value = env.get(key) ?? '';
      expect(value.length, `${key} was not generated`).toBeGreaterThan(0);
      expect(r.output.includes(value), `${key} was printed`).toBe(false);
    }
  });
});

describe('setup:secrets: an existing .env (D165)', () => {
  it('adds both keys when missing and leaves every other line as it was', () => {
    const d = workdir();
    // An .env from before D165: every other key already set, the two new ones absent.
    const before = [...exampleLines().keys()]
      .filter((k) => !(NEW_KEYS as readonly string[]).includes(k))
      .map((k) => `${k}=existing-${k.toLowerCase().replace(/_/g, '-')}-0000000000`);
    before.unshift('# my notes');
    before.push('MY_OWN_SETTING=hello');
    writeFileSync(join(d, '.env'), `${before.join('\n')}\n`, { mode: 0o600 });

    const r = runSecrets(d);
    expect(r.status, r.output).toBe(0);

    const env = readEnv(d);
    for (const key of NEW_KEYS) expect(env.get(key), key).toMatch(URL_SAFE_SECRET);
    // Existing lines are kept word for word, in order.
    const after = envText(d).split('\n');
    for (const line of before) expect(after, line).toContain(line);
  });

  it('adds only the missing one when the other is already set, and keeps the set one', () => {
    const d = workdir();
    writeFileSync(join(d, '.env'), 'DEMO_USER_PASSWORD=users-own-demo-password-000\n', { mode: 0o600 });
    const r = runSecrets(d);
    expect(r.status, r.output).toBe(0);
    const env = readEnv(d);
    expect(env.get('DEMO_USER_PASSWORD')).toBe('users-own-demo-password-000');
    expect(env.get('BETTER_AUTH_SECRET')).toMatch(URL_SAFE_SECRET);
  });

  it('never changes existing values of either key, and prints neither', () => {
    const d = workdir();
    writeFileSync(
      join(d, '.env'),
      'BETTER_AUTH_SECRET=users-own-auth-secret-00000000\nDEMO_USER_PASSWORD=users-own-demo-password-000\n',
      { mode: 0o600 },
    );
    const r = runSecrets(d);
    expect(r.status, r.output).toBe(0);
    const env = readEnv(d);
    expect(env.get('BETTER_AUTH_SECRET')).toBe('users-own-auth-secret-00000000');
    expect(env.get('DEMO_USER_PASSWORD')).toBe('users-own-demo-password-000');
    expect(r.output).not.toContain('users-own-auth-secret-00000000');
    expect(r.output).not.toContain('users-own-demo-password-000');
    // Each key appears once: nothing appended a second copy.
    for (const key of NEW_KEYS) {
      const count = envText(d)
        .split('\n')
        .filter((l) => new RegExp(`^\\s*${key}\\s*=`).test(l)).length;
      expect(count, key).toBe(1);
    }
  });

  it('a second run keeps both generated values and prints neither', () => {
    const d = workdir();
    expect(runSecrets(d).status).toBe(0);
    const first = readEnv(d);
    const r = runSecrets(d);
    expect(r.status, r.output).toBe(0);
    const second = readEnv(d);
    for (const key of NEW_KEYS) {
      const value = first.get(key) ?? '';
      expect(value, key).toMatch(URL_SAFE_SECRET);
      expect(second.get(key), key).toBe(value);
      expect(r.output.includes(value), `${key} was printed`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// compose.yaml
// ---------------------------------------------------------------------------------------------

interface Port {
  host_ip?: string;
  target: number;
  published?: string;
}
interface Service {
  command?: unknown;
  ports?: Port[];
  expose?: unknown[];
  environment?: Record<string, string | null>;
}
interface Project {
  services: Record<string, Service>;
}

const DUMMY_AUTH_SECRET = 'dummy-better-auth-secret-for-wiring-test';
let tmp = '';
let project: Project | null = null;
let projectError: Error | null = null;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'grc-wiring-compose-test-'));
  const dummyEnv = join(tmp, 'dummy.env');
  const names = new Set([...exampleLines().keys()]);
  names.delete('BETTER_AUTH_SECRET');
  const lines = [...names].map((n) => `${n}=dummy-${n.toLowerCase()}`);
  lines.push(`BETTER_AUTH_SECRET=${DUMMY_AUTH_SECRET}`);
  writeFileSync(dummyEnv, `${lines.join('\n')}\n`);

  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, '--env-file', dummyEnv, 'config', '--format', 'json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (r.status === 0) project = JSON.parse(r.stdout) as Project;
  else projectError = new Error(`docker compose config failed: ${r.stderr ?? ''}${r.error ? String(r.error) : ''}`);
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function svc(name: string): Service {
  if (projectError) throw projectError;
  const s = project!.services[name];
  if (!s) throw new Error(`service ${name} is missing`);
  return s;
}

describe('compose: grc-api and grc-worker behind the front door (D165)', () => {
  for (const name of APP_SERVICES) {
    it(`${name} listens on every interface inside the container (HOST=0.0.0.0)`, () => {
      expect(svc(name).environment?.HOST).toBe('0.0.0.0');
    });

    it(`${name} gets BETTER_AUTH_SECRET from .env`, () => {
      expect(svc(name).environment?.BETTER_AUTH_SECRET).toBe(DUMMY_AUTH_SECRET);
    });

    it(`${name} still publishes no ports (D61, D63)`, () => {
      expect(svc(name).ports ?? []).toEqual([]);
    });
  }

  it('compose.yaml takes BETTER_AUTH_SECRET from the env file, never a written-in value', () => {
    const text = readFileSync(COMPOSE, 'utf8');
    expect(text).toMatch(/BETTER_AUTH_SECRET:\s*\$\{BETTER_AUTH_SECRET\}/);
  });

  it('only grc-caddy publishes ports', () => {
    if (projectError) throw projectError;
    const publishing = Object.entries(project!.services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([n]) => n);
    expect(publishing).toEqual(['grc-caddy']);
  });

  it('grc-api and grc-worker run the start:api and start:worker scripts', () => {
    expect(svc('grc-api').command).toEqual(['pnpm', '--filter', '@grc/api', 'start:api']);
    expect(svc('grc-worker').command).toEqual(['pnpm', '--filter', '@grc/api', 'start:worker']);
  });
});

// ---------------------------------------------------------------------------------------------
// packages/api start scripts
// ---------------------------------------------------------------------------------------------

function apiScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(API_PKG, 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

describe('packages/api: the start scripts the compose commands run (D165)', () => {
  it('has a start:api script that starts the API program (main.api)', () => {
    const script = apiScripts()['start:api'];
    expect(script, 'start:api is missing').toBeTypeOf('string');
    expect(script).toMatch(/\bmain\.api\b/);
  });

  it('has a start:worker script that starts the worker program (main.worker)', () => {
    const script = apiScripts()['start:worker'];
    expect(script, 'start:worker is missing').toBeTypeOf('string');
    expect(script).toMatch(/\bmain\.worker\b/);
  });

  it('the two program entry files exist', () => {
    expect(existsSync(join(ROOT, 'packages', 'api', 'src', 'main.api.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'packages', 'api', 'src', 'main.worker.ts'))).toBe(true);
  });
});
