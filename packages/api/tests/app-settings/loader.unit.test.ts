// S1-013 criteria 3-6 (D210 (4), D57, D163, D164, D170): `loadAppSettings`, `MissingAppSettings`
// and `readDotEnv` in src/config/app-settings.ts.
//
// Every test passes `env` and `dotEnv` in, so nothing here depends on the real `.env` or the real
// process environment. `readDotEnv` is tested on a temporary folder tree the test makes and
// removes; the dotfile rules are the M0-003 ones (`readDotEnv` in tests/db/helpers.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AppSetting {
  name: string;
  required: boolean;
  macDefault?: string;
}
type Settings = Record<string, string>;
interface LoadOpts {
  env?: NodeJS.ProcessEnv;
  dotEnv?: Settings;
  overrides?: Settings;
}
interface Mod {
  APP_SETTINGS: readonly AppSetting[];
  loadAppSettings(opts: LoadOpts): Settings;
  readDotEnv(startDir: string): Settings;
  MissingAppSettings: new (...args: never[]) => Error & { missing: string[] };
}

async function load(): Promise<Mod> {
  const mod = (await import('../../src/config/app-settings.js')) as Partial<Mod>;
  for (const name of ['loadAppSettings', 'readDotEnv', 'MissingAppSettings'] as const) {
    if (typeof mod[name] !== 'function') throw new Error(`src/config/app-settings.ts must export ${name}`);
  }
  if (!Array.isArray(mod.APP_SETTINGS)) throw new Error('src/config/app-settings.ts must export APP_SETTINGS');
  return mod as Mod;
}

const REQUIRED_NO_DEFAULT = [
  'DATABASE_URL_APP',
  'NEO4J_ADMIN_PASSWORD',
  'NEO4J_WRITER_PASSWORD',
  'NEO4J_QUERY_SECRET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'BETTER_AUTH_SECRET',
];

/** A distinctive value per name, so a leak into an error is easy to spot. */
const val = (name: string, where: string) => `v-${where}-${name.toLowerCase()}-5e1c9a`;

/** Every required setting with no default, as one source would hold them. */
function requiredFrom(where: string): Settings {
  return Object.fromEntries(REQUIRED_NO_DEFAULT.map((n) => [n, val(n, where)]));
}

/** Catches what `fn` throws, or fails the test if it returns. */
function thrown(fn: () => unknown): Error & { missing?: string[] } {
  try {
    fn();
  } catch (err) {
    return err as Error & { missing?: string[] };
  }
  throw new Error('expected loadAppSettings to throw, but it returned');
}

describe('where values come from (criterion 3)', () => {
  it('overrides beat the environment, which beats .env, which beats the Mac default', async () => {
    const { loadAppSettings } = await load();
    const result = loadAppSettings({
      overrides: { NEO4J_URI: 'bolt://override:1' },
      env: { ...requiredFrom('env'), NEO4J_URI: 'bolt://env:2', S3_ENDPOINT: 'http://env:3' },
      dotEnv: {
        ...requiredFrom('dotenv'),
        NEO4J_URI: 'bolt://dotenv:4',
        S3_ENDPOINT: 'http://dotenv:5',
        BETTER_AUTH_URL: 'https://dotenv.example',
      },
    });
    expect(result.NEO4J_URI).toBe('bolt://override:1');
    expect(result.S3_ENDPOINT).toBe('http://env:3');
    expect(result.BETTER_AUTH_URL).toBe('https://dotenv.example');
    expect(result.NEO4J_QUERY_SECRET).toBe(val('NEO4J_QUERY_SECRET', 'env'));
  });

  it('fills a setting from .env when the environment lacks it', async () => {
    const { loadAppSettings } = await load();
    const result = loadAppSettings({ env: {}, dotEnv: requiredFrom('dotenv') });
    for (const name of REQUIRED_NO_DEFAULT) expect(result[name], name).toBe(val(name, 'dotenv'));
  });

  it('uses the Mac defaults when nothing else has a value', async () => {
    const { loadAppSettings } = await load();
    const result = loadAppSettings({ env: requiredFrom('env'), dotEnv: {} });
    expect(result.NEO4J_URI).toBe('bolt://127.0.0.1:7687');
    expect(result.S3_ENDPOINT).toBe('http://127.0.0.1:8333');
    expect(result.BETTER_AUTH_URL).toBe('https://grc.localhost');
  });

  it('treats an empty string as not set, at every level', async () => {
    const { loadAppSettings } = await load();
    const result = loadAppSettings({
      overrides: { NEO4J_URI: '', S3_ENDPOINT: '', BETTER_AUTH_SECRET: '' },
      env: { ...requiredFrom('env'), NEO4J_URI: '', S3_ENDPOINT: 'http://env:3', BETTER_AUTH_SECRET: '' },
      dotEnv: { NEO4J_URI: '', BETTER_AUTH_SECRET: 'from-dotenv-b7' },
    });
    expect(result.NEO4J_URI, 'empty override, env and .env fall through to the Mac default').toBe(
      'bolt://127.0.0.1:7687',
    );
    expect(result.S3_ENDPOINT, 'an empty override falls through to the environment').toBe('http://env:3');
    expect(result.BETTER_AUTH_SECRET, 'empty override and env fall through to .env').toBe('from-dotenv-b7');
  });

  it('works with no dotEnv given', async () => {
    const { loadAppSettings } = await load();
    const result = loadAppSettings({ env: requiredFrom('env') });
    expect(result.DATABASE_URL_APP).toBe(val('DATABASE_URL_APP', 'env'));
  });

  it('returns only listed names, and leaves out an optional one with no value', async () => {
    const { loadAppSettings, APP_SETTINGS } = await load();
    const outsiders = {
      DATABASE_URL_MIGRATE: 'migrate-url-value-m9',
      POSTGRES_PASSWORD: 'super-pw-9',
      DEMO_USER_PASSWORD: 'demo-pw-9',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      PATH: '/usr/bin',
    };
    const result = loadAppSettings({
      overrides: { ...outsiders },
      env: { ...requiredFrom('env'), ...outsiders, HOST: '0.0.0.0' },
      dotEnv: { ...outsiders },
    });
    const listed = new Set(APP_SETTINGS.map((s) => s.name));
    expect(
      Object.keys(result).filter((k) => !listed.has(k)),
      'names outside APP_SETTINGS',
    ).toEqual([]);
    for (const name of Object.keys(outsiders)) expect(result, name).not.toHaveProperty(name);
    expect(result.HOST).toBe('0.0.0.0');
    expect(result).not.toHaveProperty('PORT');
    expect(result).not.toHaveProperty('LOG_LEVEL');
  });

  it('gives every required setting when all are present', async () => {
    const { loadAppSettings, APP_SETTINGS } = await load();
    const result = loadAppSettings({ env: requiredFrom('env'), dotEnv: {} });
    for (const s of APP_SETTINGS.filter((x) => x.required)) expect(result[s.name], s.name).toBeTruthy();
  });
});

describe('loud and safe when something is missing (criterion 4)', () => {
  // Every present setting, listed or not, holds a distinctive value; none may reach the error.
  function presentValues(except: string[]): { env: Settings; dotEnv: Settings; values: string[] } {
    const env: Settings = {};
    const dotEnv: Settings = {};
    for (const n of REQUIRED_NO_DEFAULT) if (!except.includes(n)) env[n] = val(n, 'env');
    Object.assign(env, {
      NEO4J_URI: 'bolt://neo4j-env-4417:7687',
      S3_ENDPOINT: 'http://s3-env-4417:8333',
      BETTER_AUTH_URL: 'https://auth-env-4417.example',
      HOST: 'host-env-4417',
      PORT: '44170',
      LOG_LEVEL: 'loglevel-env-4417',
    });
    Object.assign(dotEnv, {
      DATABASE_URL_MIGRATE: 'migrate-url-value-4417',
      POSTGRES_PASSWORD: 'super-pw-4417',
      DEMO_USER_PASSWORD: 'demo-pw-4417',
    });
    return { env, dotEnv, values: [...Object.values(env), ...Object.values(dotEnv)] };
  }

  it.each(REQUIRED_NO_DEFAULT)('names %s, and only it, when it is missing', async (name) => {
    const { loadAppSettings, MissingAppSettings } = await load();
    const { env, dotEnv, values } = presentValues([name]);
    const err = thrown(() => loadAppSettings({ env, dotEnv }));
    expect(err).toBeInstanceOf(MissingAppSettings);
    expect(err).toBeInstanceOf(Error);
    expect(err.missing).toEqual([name]);
    expect(err.message).toBe(`Missing settings: ${name}. Add them to .env.`);
    const said = `${err.message}\n${String(err)}\n${JSON.stringify(err.missing)}`;
    for (const v of values) expect(said, 'a present value leaked into the error').not.toContain(v);
  });

  it.each(REQUIRED_NO_DEFAULT)('treats an empty %s at every level as missing', async (name) => {
    const { loadAppSettings, MissingAppSettings } = await load();
    const { env, dotEnv } = presentValues([name]);
    const err = thrown(() =>
      loadAppSettings({ overrides: { [name]: '' }, env: { ...env, [name]: '' }, dotEnv: { ...dotEnv, [name]: '' } }),
    );
    expect(err).toBeInstanceOf(MissingAppSettings);
    expect(err.missing).toEqual([name]);
  });

  it('names every missing setting, in list order', async () => {
    const { loadAppSettings, MissingAppSettings, APP_SETTINGS } = await load();
    const absent = ['BETTER_AUTH_SECRET', 'NEO4J_QUERY_SECRET', 'DATABASE_URL_APP'];
    const { env, dotEnv, values } = presentValues(absent);
    const err = thrown(() => loadAppSettings({ env, dotEnv }));
    expect(err).toBeInstanceOf(MissingAppSettings);
    const inListOrder = APP_SETTINGS.map((s) => s.name).filter((n) => absent.includes(n));
    expect(err.missing).toEqual(inListOrder);
    expect(err.message).toBe(`Missing settings: ${inListOrder.join(', ')}. Add them to .env.`);
    const said = `${err.message}\n${String(err)}\n${JSON.stringify(err.missing)}`;
    for (const v of values) expect(said, 'a present value leaked into the error').not.toContain(v);
  });

  it('names all seven when nothing is set', async () => {
    const { loadAppSettings, APP_SETTINGS } = await load();
    const err = thrown(() => loadAppSettings({ env: {}, dotEnv: {} }));
    const inListOrder = APP_SETTINGS.map((s) => s.name).filter((n) => REQUIRED_NO_DEFAULT.includes(n));
    expect(err.missing).toEqual(inListOrder);
  });
});

describe('prints nothing and leaves process.env alone (criterion 5)', () => {
  let spies: { mock: { calls: unknown[] } }[] = [];
  let tree: string | undefined;

  beforeEach(() => {
    spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tree) rmSync(tree, { recursive: true, force: true });
    tree = undefined;
  });

  const writes = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);

  it('loadAppSettings writes nothing when it succeeds', async () => {
    const { loadAppSettings } = await load();
    loadAppSettings({ env: requiredFrom('env'), dotEnv: { HOST: 'h' } });
    const count = writes();
    vi.restoreAllMocks();
    expect(count, 'console or stdout/stderr writes').toBe(0);
  });

  it('loadAppSettings writes nothing when it throws', async () => {
    const { loadAppSettings } = await load();
    thrown(() => loadAppSettings({ env: {}, dotEnv: {} }));
    const count = writes();
    vi.restoreAllMocks();
    expect(count, 'console or stdout/stderr writes').toBe(0);
  });

  it('readDotEnv writes nothing, with or without a .env', async () => {
    const { readDotEnv } = await load();
    tree = mkdtempSync(join(tmpdir(), 's1-013-print-'));
    mkdirSync(join(tree, 'a'));
    readDotEnv(join(tree, 'a'));
    writeFileSync(join(tree, '.env'), 'S1013_PRINT_CHECK=secret-print-1\n');
    readDotEnv(join(tree, 'a'));
    const count = writes();
    vi.restoreAllMocks();
    expect(count, 'console or stdout/stderr writes').toBe(0);
  });

  it('loadAppSettings does not change process.env, succeeding or throwing', async () => {
    const { loadAppSettings } = await load();
    const before = { ...process.env };
    loadAppSettings({
      overrides: { NEO4J_URI: 'bolt://override-env-check:1' },
      env: requiredFrom('env'),
      dotEnv: { HOST: 'dotenv-host-check' },
    });
    thrown(() => loadAppSettings({ env: {}, dotEnv: { HOST: 'dotenv-host-check' } }));
    expect({ ...process.env }).toEqual(before);
  });

  it('readDotEnv does not put what it reads into process.env', async () => {
    const { readDotEnv } = await load();
    tree = mkdtempSync(join(tmpdir(), 's1-013-env-'));
    writeFileSync(join(tree, '.env'), 'S1013_NOT_IN_PROCESS_ENV=x1\n');
    const before = { ...process.env };
    expect(readDotEnv(tree).S1013_NOT_IN_PROCESS_ENV).toBe('x1');
    expect({ ...process.env }).toEqual(before);
  });
});

describe('readDotEnv (criterion 6)', () => {
  let tree: string;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 's1-013-dotenv-'));
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  it('merges every .env walking up, the nearer file winning per key', async () => {
    const { readDotEnv } = await load();
    mkdirSync(join(tree, 'near', 'start'), { recursive: true });
    writeFileSync(join(tree, '.env'), 'S1013_SHARED=far\nS1013_FAR_ONLY=far-only\n');
    writeFileSync(join(tree, 'near', '.env'), 'S1013_SHARED=near\nS1013_NEAR_ONLY=near-only\n');
    const found = readDotEnv(join(tree, 'near', 'start'));
    expect(found.S1013_SHARED).toBe('near');
    expect(found.S1013_FAR_ONLY).toBe('far-only');
    expect(found.S1013_NEAR_ONLY).toBe('near-only');
  });

  it('reads a .env in the start folder itself', async () => {
    const { readDotEnv } = await load();
    writeFileSync(join(tree, '.env'), 'S1013_HERE=here\n');
    expect(readDotEnv(tree).S1013_HERE).toBe('here');
  });

  it('skips # lines and blank lines, and keeps values with = in them', async () => {
    const { readDotEnv } = await load();
    writeFileSync(
      join(tree, '.env'),
      [
        '# S1013_COMMENTED=no',
        '#S1013_COMMENTED_TIGHT=no',
        '',
        '   ',
        'S1013_PLAIN=plain',
        'S1013_URL=postgres://u:p@h:5432/db?sslmode=disable',
        '  S1013_SPACED = spaced  ',
        '',
      ].join('\n'),
    );
    const found = readDotEnv(tree);
    expect(found).not.toHaveProperty('S1013_COMMENTED');
    expect(found).not.toHaveProperty('S1013_COMMENTED_TIGHT');
    expect(found.S1013_PLAIN).toBe('plain');
    expect(found.S1013_URL).toBe('postgres://u:p@h:5432/db?sslmode=disable');
    expect(found.S1013_SPACED).toBe('spaced');
  });

  it('removes one pair of matching quotes, and only matching ones', async () => {
    const { readDotEnv } = await load();
    writeFileSync(
      join(tree, '.env'),
      [
        'S1013_DOUBLE="double quoted"',
        "S1013_SINGLE='single quoted'",
        'S1013_NESTED="\'inner\'"',
        'S1013_MISMATCHED="half\'',
        'S1013_BARE=no quotes',
        '',
      ].join('\n'),
    );
    const found = readDotEnv(tree);
    expect(found.S1013_DOUBLE).toBe('double quoted');
    expect(found.S1013_SINGLE).toBe('single quoted');
    expect(found.S1013_NESTED).toBe("'inner'");
    expect(found.S1013_MISMATCHED).toBe('"half\'');
    expect(found.S1013_BARE).toBe('no quotes');
  });

  it('gives {} for a tree with no .env', async () => {
    const { readDotEnv } = await load();
    mkdirSync(join(tree, 'empty', 'deeper'), { recursive: true });
    expect(readDotEnv(join(tree, 'empty', 'deeper'))).toEqual({});
  });
});
