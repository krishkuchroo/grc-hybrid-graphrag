// The one list of the settings the API and worker read (D210 (4)), and the loader that fills them.
// Pure apart from readDotEnv's file reads: no network, no logging, no writes to process.env (D57, D163, D164).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface AppSetting {
  name: string;
  required: boolean;
  macDefault?: string;
}

export const APP_SETTINGS: readonly AppSetting[] = [
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

/** Thrown when required settings have no value. Holds names only, never a value. */
export class MissingAppSettings extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Missing settings: ${missing.join(', ')}. Add them to .env.`);
    this.name = 'MissingAppSettings';
    this.missing = missing;
  }
}

/** Reads every `.env` from `startDir` upwards; a nearer file wins for a key. */
export function readDotEnv(startDir: string): Record<string, string> {
  const found: Record<string, string> = {};
  let dir = resolve(startDir);
  for (;;) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1]!;
        let value = m[2]!.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in found)) found[key] = value;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** Fills each listed setting from overrides, then env, then .env, then the Mac default. */
export function loadAppSettings(opts: {
  env?: NodeJS.ProcessEnv;
  dotEnv?: Record<string, string>;
  overrides?: Record<string, string>;
}): Record<string, string> {
  const env = opts.env ?? process.env;
  const dotEnv = opts.dotEnv ?? {};
  const overrides = opts.overrides ?? {};
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const setting of APP_SETTINGS) {
    const value = [overrides[setting.name], env[setting.name], dotEnv[setting.name], setting.macDefault].find(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    if (value !== undefined) result[setting.name] = value;
    else if (setting.required) missing.push(setting.name);
  }
  if (missing.length > 0) throw new MissingAppSettings(missing);
  return result;
}
